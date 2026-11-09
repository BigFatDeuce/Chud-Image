//! Saving pictures produced by the editor (drawing, crop, adjustments…).
//!
//! The editor renders the result in the web view and hands over a lossless PNG; this
//! module re-encodes it in the format of the destination file. "Replace the original"
//! never destroys anything: the new file is fully written first, then the original goes
//! to the Recycle Bin / Trash, then the new file takes its name.

use crate::error::{AppError, AppResult, ErrorCode};
use crate::formats::extension_of;
use crate::{files, jpeg_orient, rotate};
use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

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

/// Encodes the editor output for `dest`. `source` is the original file, used to carry
/// the EXIF block over when both are JPEGs.
pub fn encode_for(dest: &Path, png: &[u8], source: Option<&Path>, quality: u8) -> AppResult<Vec<u8>> {
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
                    if let Ok(with_exif) = jpeg_orient::transplant_exif(&original, &out) {
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
pub fn save(dest: &Path, png: &[u8], source: Option<&Path>, mode: SaveMode, quality: u8) -> AppResult<EditOutcome> {
    let bytes = encode_for(dest, png, source, quality)?;
    match mode {
        SaveMode::Copy => {
            rotate::atomic_write(dest, &bytes)?;
            Ok(EditOutcome { path: dest.display().to_string(), trashed: false })
        }
        SaveMode::ReplaceOriginal => {
            if !dest.is_file() {
                return Err(AppError::new(ErrorCode::NotFound, dest.display().to_string()));
            }
            if fs::metadata(dest)?.permissions().readonly() {
                return Err(AppError::new(ErrorCode::PermissionDenied, "file is read-only"));
            }
            // 1. The new picture is complete on disk before anything else happens.
            let staged = staging_path(dest);
            fs::write(&staged, &bytes)?;
            // 2. The original goes to the trash; if that fails nothing has changed.
            if let Err(e) = files::move_to_trash(dest) {
                let _ = fs::remove_file(&staged);
                return Err(e);
            }
            // 3. The edit takes the original's name.
            if let Err(e) = fs::rename(&staged, dest) {
                // Extremely unlikely (same folder); leave the staged file for the user.
                return Err(AppError::new(
                    ErrorCode::Io,
                    format!("{e} — the edited picture was kept as {}", staged.display()),
                ));
            }
            Ok(EditOutcome { path: dest.display().to_string(), trashed: true })
        }
    }
}

fn staging_path(dest: &Path) -> PathBuf {
    let dir = dest.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let stem = dest.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = extension_of(dest);
    dir.join(format!(".{stem}.chud-edit-{}.{ext}", std::process::id()))
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
            let out = save(&dest, &png_bytes(30, 20, 255), None, SaveMode::Copy, 90).unwrap();
            assert!(!out.trashed);
            let back = image::open(&dest).unwrap();
            assert_eq!(back.dimensions(), (30, 20), "{ext}");
        }
    }

    #[test]
    fn transparent_pixels_become_white_in_jpeg() {
        let bytes = encode_for(Path::new("x.jpg"), &png_bytes(8, 8, 0), None, 95).unwrap();
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
        save(&dest, &png_bytes(16, 16, 255), Some(&src), SaveMode::Copy, 90).unwrap();
        let saved = fs::read(&dest).unwrap();
        assert_eq!(jpeg_orient::read_orientation(&saved), 1);
        assert!(saved.windows(6).any(|w| w == b"Exif\0\0"));
    }

    #[test]
    fn read_only_formats_are_refused() {
        let err = encode_for(Path::new("x.heic"), &png_bytes(4, 4, 255), None, 90).unwrap_err();
        assert_eq!(err.code, ErrorCode::ReadOnlyFormat);
    }

    #[test]
    fn replacing_a_missing_original_fails_cleanly() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("gone.png");
        let err = save(&dest, &png_bytes(4, 4, 255), None, SaveMode::ReplaceOriginal, 90).unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0, "no staged file left behind");
    }
}
