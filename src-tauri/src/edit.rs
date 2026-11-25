//! Saving pictures produced by the editor (drawing, crop, adjustments…).
//!
//! The editor renders the result in the web view and hands over a lossless PNG; this
//! module re-encodes it in the format of the destination file. "Replace the original"
//! never destroys anything: the new file is fully written and flushed first, then the
//! original goes to the Recycle Bin / Trash, then the new file takes its name.

use crate::error::{AppError, AppResult, ErrorCode};
use crate::formats::extension_of;
use crate::{files, jpeg_orient, rotate, safe_write};
use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::collections::BTreeMap;
use std::time::{Duration, SystemTime};

/// Extensions the editor can write. Everything else (RAW, HEIC, AVIF, SVG…) can only be
/// saved as a copy in one of these.
pub const WRITABLE: &[&str] = &[
    "jpg", "jpeg", "jpe", "jfif", "png", "webp", "bmp", "tif", "tiff", "gif", "tga", "qoi",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SaveMode {
    /// Write a new file (or one the user explicitly agreed to replace in the save dialog).
    Copy,
    /// Replace `original`: it is moved to the trash, the edit takes its place.
    ReplaceOriginal,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditOutcome {
    pub path: String,
    /// The original went to the trash.
    pub trashed: bool,
}

pub fn is_writable(path: &Path) -> bool {
    WRITABLE.contains(&extension_of(path).as_str())
}

/// What travels with the picture besides its pixels.
#[derive(Debug, Clone, Copy, Default)]
pub struct SaveOptions {
    /// Leave the GPS location out of the EXIF data.
    pub strip_gps: bool,
}

/// Encodes the editor output for `dest`. `source` is the original file, used to carry
/// the EXIF block over when both are JPEGs.
pub fn encode_for(dest: &Path, png: &[u8], source: Option<&Path>, quality: u8, options: SaveOptions) -> AppResult<Vec<u8>> {
    let ext = extension_of(dest);
    if !is_writable(dest) {
        return Err(AppError::new(ErrorCode::ReadOnlyFormat, format!("cannot write .{ext} files")));
    }
    let img = image::load_from_memory_with_format(png, ImageFormat::Png)
        .map_err(|e| AppError::corrupt(format!("editor output: {e}")))?;
    let format = ImageFormat::from_extension(&ext).ok_or_else(|| AppError::unsupported(ext.clone()))?;
    match format {
        ImageFormat::Jpeg => {
            let rgb = flatten_on_white(&img);
            let mut out = Vec::new();
            JpegEncoder::new_with_quality(&mut out, quality.clamp(40, 100)).encode_image(&rgb)?;
            let is_jpeg_source = source
                .map(|s| matches!(extension_of(s).as_str(), "jpg" | "jpeg" | "jpe" | "jfif"))
                .unwrap_or(false);
            if is_jpeg_source {
                if let Some(original) = source.and_then(|s| fs::read(s).ok()) {
                    if let Ok(with_exif) = jpeg_orient::transplant_exif(&original, &out, options.strip_gps) {
                        return Ok(with_exif);
                    }
                }
            }
            Ok(out)
        }
        _ => rotate::encode(&img, format, None),
    }
}

fn flatten_on_white(img: &DynamicImage) -> DynamicImage {
    if !img.color().has_alpha() {
        return DynamicImage::ImageRgb8(img.to_rgb8());
    }
    let rgba = img.to_rgba8();
    let mut out = RgbImage::new(rgba.width(), rgba.height());
    for (o, p) in out.pixels_mut().zip(rgba.pixels()) {
        let a = p[3] as u32;
        let mix = |c: u8| ((c as u32 * a + 255 * (255 - a)) / 255) as u8;
        *o = Rgb([mix(p[0]), mix(p[1]), mix(p[2])]);
    }
    DynamicImage::ImageRgb8(out)
}

/// Writes the edit. In `ReplaceOriginal` mode `dest` must be the original file.
pub fn save(dest: &Path, png: &[u8], source: Option<&Path>, mode: SaveMode, quality: u8, options: SaveOptions) -> AppResult<EditOutcome> {
    let bytes = encode_for(dest, png, source, quality, options)?;
    match mode {
        SaveMode::Copy => {
            safe_write::atomic_write(dest, &bytes)?;
            Ok(EditOutcome { path: dest.display().to_string(), trashed: false })
        }
        SaveMode::ReplaceOriginal => replace_original(dest, &bytes, files::move_to_trash),
    }
}

/// "Replace the original": the edit is written and flushed under a hidden name, the
/// original goes to the trash, then the edit takes its name. Should the app die between
/// the last two steps, [`recover_interrupted`] finishes the job the next time the folder
/// is opened, so the picture never stays missing.
fn replace_original(dest: &Path, bytes: &[u8], trash: impl FnOnce(&Path) -> AppResult<()>) -> AppResult<EditOutcome> {
    if !dest.is_file() {
        return Err(AppError::new(ErrorCode::NotFound, dest.display().to_string()));
    }
    if fs::metadata(dest)?.permissions().readonly() {
        return Err(AppError::new(ErrorCode::PermissionDenied, "file is read-only"));
    }
    // 1. The new picture is complete and on the disk before anything else happens.
    let staged = safe_write::stage(dest, bytes, safe_write::EDIT_TAG)?;
    // 2. The original goes to the trash; if that fails nothing has changed.
    if let Err(e) = trash(dest) {
        let _ = fs::remove_file(&staged);
        return Err(e);
    }
    // 3. The edit takes the original's name.
    if let Err(e) = fs::rename(&staged, dest) {
        // Extremely unlikely (same folder); the edit is kept and the recovery puts it in
        // place the next time the folder is opened.
        return Err(AppError::new(
            ErrorCode::Io,
            format!("{e} — the edited picture was kept as {}", staged.display()),
        ));
    }
    safe_write::sync_folder(dest);
    Ok(EditOutcome { path: dest.display().to_string(), trashed: true })
}

/// Staged edits younger than this may belong to a save still in progress.
pub const RECOVERY_DELAY: Duration = Duration::from_secs(120);

/// Puts back pictures left missing by an interrupted "replace the original": a staged
/// edit whose original is gone (already in the trash) is renamed to the original's name.
/// Staged files whose original is still there are left alone: that save never got as
/// far as touching the original. When several edits of one picture were left behind, the
/// most recent one is restored and the others are kept as they are; while any of them is
/// younger than `min_age` (a save may still be running) the picture is not touched.
/// Returns the pictures restored.
pub fn recover_interrupted(dir: &Path, min_age: Duration) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    // Per picture: the newest staged edit, and whether one is too recent to touch.
    let mut found: BTreeMap<String, (Option<(SystemTime, PathBuf)>, bool)> = BTreeMap::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(target_name) = safe_write::edit_target_name(&name) else { continue };
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let slot = found.entry(target_name).or_insert((None, false));
        let modified = meta.modified().ok();
        let old_enough = modified.and_then(|m| m.elapsed().ok()).is_some_and(|age| age >= min_age);
        if !old_enough {
            slot.1 = true;
            continue;
        }
        let modified = modified.unwrap_or(SystemTime::UNIX_EPOCH);
        if !slot.0.as_ref().is_some_and(|(best, _)| modified <= *best) {
            slot.0 = Some((modified, entry.path()));
        }
    }
    let mut restored = Vec::new();
    for (target_name, (newest, busy)) in found {
        let Some((_, staged)) = newest else { continue };
        let target = dir.join(&target_name);
        // `symlink_metadata`: a dangling link still counts as "there".
        if busy || fs::symlink_metadata(&target).is_ok() {
            continue;
        }
        if fs::rename(&staged, &target).is_ok() {
            safe_write::sync_folder(&target);
            restored.push(target);
        }
    }
    restored
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{GenericImageView, Rgba, RgbaImage};
    use std::io::Cursor;

    fn png_bytes(w: u32, h: u32, alpha: u8) -> Vec<u8> {
        let img = RgbaImage::from_pixel(w, h, Rgba([200, 30, 30, alpha]));
        let mut out = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(img).write_to(&mut out, ImageFormat::Png).unwrap();
        out.into_inner()
    }

    #[test]
    fn encodes_in_the_destination_format() {
        let dir = tempfile::tempdir().unwrap();
        for ext in ["png", "jpg", "webp", "bmp", "tiff"] {
            let dest = dir.path().join(format!("out.{ext}"));
            let out = save(&dest, &png_bytes(30, 20, 255), None, SaveMode::Copy, 90, SaveOptions::default()).unwrap();
            assert!(!out.trashed);
            let back = image::open(&dest).unwrap();
            assert_eq!(back.dimensions(), (30, 20), "{ext}");
        }
    }

    #[test]
    fn transparent_pixels_become_white_in_jpeg() {
        let bytes = encode_for(Path::new("x.jpg"), &png_bytes(8, 8, 0), None, 95, SaveOptions::default()).unwrap();
        let back = image::load_from_memory(&bytes).unwrap().to_rgb8();
        assert!(back.get_pixel(4, 4)[0] > 245);
    }

    #[test]
    fn jpeg_edits_keep_exif_but_reset_orientation() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("photo.jpg");
        let original = jpeg_orient::set_orientation(&jpeg_orient::tests::sample_jpeg(), 6).unwrap();
        fs::write(&src, &original).unwrap();
        let dest = dir.path().join("photo-edit.jpg");
        save(&dest, &png_bytes(16, 16, 255), Some(&src), SaveMode::Copy, 90, SaveOptions::default()).unwrap();
        let saved = fs::read(&dest).unwrap();
        assert_eq!(jpeg_orient::read_orientation(&saved), 1);
        assert!(saved.windows(6).any(|w| w == b"Exif\0\0"));
    }

    #[test]
    fn read_only_formats_are_refused() {
        let err = encode_for(Path::new("x.heic"), &png_bytes(4, 4, 255), None, 90, SaveOptions::default()).unwrap_err();
        assert_eq!(err.code, ErrorCode::ReadOnlyFormat);
    }

    #[test]
    fn replacing_a_missing_original_fails_cleanly() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("gone.png");
        let err = save(&dest, &png_bytes(4, 4, 255), None, SaveMode::ReplaceOriginal, 90, SaveOptions::default()).unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0, "no staged file left behind");
    }

    #[test]
    fn replacing_puts_the_edit_in_place_and_the_original_in_the_trash() {
        let dir = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        let dest = dir.path().join("photo.png");
        fs::write(&dest, b"original").unwrap();
        let out = replace_original(&dest, b"edited", |p| Ok(fs::rename(p, bin.path().join("photo.png"))?)).unwrap();
        assert!(out.trashed);
        assert_eq!(fs::read(&dest).unwrap(), b"edited");
        assert_eq!(fs::read(bin.path().join("photo.png")).unwrap(), b"original");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1, "no staged file left behind");
    }

    #[test]
    fn a_failing_trash_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("photo.png");
        fs::write(&dest, b"original").unwrap();
        let err = replace_original(&dest, b"edited", |_| Err(AppError::new(ErrorCode::TrashUnavailable, "no trash"))).unwrap_err();
        assert_eq!(err.code, ErrorCode::TrashUnavailable);
        assert_eq!(fs::read(&dest).unwrap(), b"original");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1, "no staged file left behind");
    }

    /// Regression IMG-01: the app dies right after the original went to the trash.
    #[test]
    fn an_interrupted_replace_is_finished_when_the_folder_is_opened_again() {
        let dir = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        let dest = dir.path().join("photo.png");
        fs::write(&dest, b"original").unwrap();
        // Steps 1 and 2 of `replace_original`, then the "crash".
        let staged = safe_write::stage(&dest, b"edited", safe_write::EDIT_TAG).unwrap();
        fs::rename(&dest, bin.path().join("photo.png")).unwrap();
        assert!(!dest.exists());

        // A save that might still be running is not touched...
        assert!(recover_interrupted(dir.path(), RECOVERY_DELAY).is_empty());
        assert!(staged.exists());
        // ...an old one is completed.
        assert_eq!(recover_interrupted(dir.path(), Duration::ZERO), vec![dest.clone()]);
        assert_eq!(fs::read(&dest).unwrap(), b"edited");
        assert!(!staged.exists());
    }

    #[test]
    fn recovery_never_overwrites_an_existing_picture() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("photo.jpg");
        fs::write(&dest, b"current").unwrap();
        let staged = safe_write::stage(&dest, b"stale edit", safe_write::EDIT_TAG).unwrap();
        // The 1.2 naming too.
        let legacy = dir.path().join(".photo.chud-edit-42.jpg");
        fs::write(&legacy, b"older edit").unwrap();
        assert!(recover_interrupted(dir.path(), Duration::ZERO).is_empty());
        assert_eq!(fs::read(&dest).unwrap(), b"current");
        assert!(staged.exists() && legacy.exists());
    }

    /// Two interrupted replaces of the same picture: the latest edit wins, the other stays.
    #[test]
    fn recovery_restores_the_newest_of_several_edits() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("photo.png");
        let older = safe_write::stage(&dest, b"first edit", safe_write::EDIT_TAG).unwrap();
        let newer = safe_write::stage(&dest, b"second edit", safe_write::EDIT_TAG).unwrap();
        let now = std::time::SystemTime::now();
        fs::File::options().write(true).open(&older).unwrap().set_modified(now - Duration::from_secs(600)).unwrap();
        fs::File::options().write(true).open(&newer).unwrap().set_modified(now - Duration::from_secs(300)).unwrap();
        assert_eq!(recover_interrupted(dir.path(), RECOVERY_DELAY), vec![dest.clone()]);
        assert_eq!(fs::read(&dest).unwrap(), b"second edit");
        assert!(older.exists(), "the older edit is kept, not lost");
    }

    /// One edit of the picture may still be on its way: leave the picture alone.
    #[test]
    fn recovery_waits_while_any_edit_of_the_picture_is_recent() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("photo.png");
        let old = safe_write::stage(&dest, b"old edit", safe_write::EDIT_TAG).unwrap();
        fs::File::options().write(true).open(&old).unwrap().set_modified(std::time::SystemTime::now() - Duration::from_secs(600)).unwrap();
        safe_write::stage(&dest, b"save in progress", safe_write::EDIT_TAG).unwrap();
        assert!(recover_interrupted(dir.path(), RECOVERY_DELAY).is_empty());
        assert!(!dest.exists());
    }

    #[test]
    fn recovery_understands_the_1_2_staging_names() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(".photo.chud-edit-42.jpg"), b"edit").unwrap();
        assert_eq!(recover_interrupted(dir.path(), Duration::ZERO), vec![dir.path().join("photo.jpg")]);
        assert_eq!(fs::read(dir.path().join("photo.jpg")).unwrap(), b"edit");
    }
}
