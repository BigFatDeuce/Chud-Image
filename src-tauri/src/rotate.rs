//! Saving a pending rotation to disk, as safely and losslessly as each format allows.

use crate::error::{AppError, AppResult, ErrorCode};
use crate::formats::extension_of;
use crate::jpeg_orient;
use image::codecs::png::{CompressionType, FilterType, PngDecoder, PngEncoder};
use image::codecs::tiff::TiffEncoder;
use image::codecs::webp::{WebPDecoder, WebPEncoder};
use image::{DynamicImage, ImageDecoder, ImageEncoder, ImageFormat, ImageReader};
use serde::Serialize;
use std::fs::{self, File};
use std::io::{BufReader, Cursor, Write};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RotationSupport {
    /// JPEG: only the EXIF orientation tag changes, the picture is not re-encoded.
    Lossless,
    /// Lossless formats (PNG, BMP, TIFF…): pixels are rotated and re-encoded without loss.
    Reencode,
    /// Read-only formats (RAW, HEIC, AVIF, SVG, animations…): rotation is display-only.
    Unsupported,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveOutcome {
    pub path: String,
    pub method: RotationSupport,
}

const LOSSLESS_JPEG: &[&str] = &["jpg", "jpeg", "jpe", "jfif"];
const REENCODE: &[&str] = &["png", "bmp", "dib", "tif", "tiff", "webp", "gif", "tga", "qoi", "pnm", "pbm", "pgm", "ppm"];

/// EXIF orientation as (mirror horizontally first?, then clockwise quarter turns).
fn orientation_to_pair(o: u16) -> (bool, u8) {
    match o {
        2 => (true, 0),
        3 => (false, 2),
        4 => (true, 2),
        5 => (true, 3),
        6 => (false, 1),
        7 => (true, 1),
        8 => (false, 3),
        _ => (false, 0),
    }
}

fn pair_to_orientation(flip: bool, rot: u8) -> u16 {
    match (flip, rot % 4) {
        (false, 0) => 1,
        (false, 1) => 6,
        (false, 2) => 3,
        (false, 3) => 8,
        (true, 0) => 2,
        (true, 1) => 7,
        (true, 2) => 4,
        _ => 5,
    }
}

/// The orientation obtained by rotating an image displayed with `orientation` by
/// `quarter_turns_cw` additional clockwise quarter turns.
pub fn compose_orientation(orientation: u16, quarter_turns_cw: i32) -> u16 {
    let (flip, rot) = orientation_to_pair(orientation);
    pair_to_orientation(flip, ((rot as i32 + quarter_turns_cw).rem_euclid(4)) as u8)
}

pub fn normalize_turns(turns: i32) -> u8 {
    turns.rem_euclid(4) as u8
}

fn is_animated(path: &Path, ext: &str) -> bool {
    let open = || File::open(path).map(BufReader::new);
    match ext {
        "gif" => open()
            .ok()
            .and_then(|r| image::codecs::gif::GifDecoder::new(r).ok())
            .map(|d| {
                use image::AnimationDecoder;
                d.into_frames().take(2).count() > 1
            })
            .unwrap_or(false),
        "webp" => open()
            .ok()
            .and_then(|r| WebPDecoder::new(r).ok())
            .map(|d| d.has_animation())
            .unwrap_or(false),
        "png" => open()
            .ok()
            .and_then(|r| PngDecoder::new(r).ok())
            .and_then(|d| d.is_apng().ok())
            .unwrap_or(false),
        _ => false,
    }
}

pub fn rotation_support(path: &Path) -> RotationSupport {
    let ext = extension_of(path);
    if LOSSLESS_JPEG.contains(&ext.as_str()) {
        RotationSupport::Lossless
    } else if REENCODE.contains(&ext.as_str()) && !is_animated(path, &ext) {
        RotationSupport::Reencode
    } else {
        RotationSupport::Unsupported
    }
}

/// Writes `bytes` to `dest` through a temporary file in the same folder followed by a
/// rename, so a crash or a full disk can never leave a half-written photo behind.
pub fn atomic_write(dest: &Path, bytes: &[u8]) -> AppResult<()> {
    let dir = dest.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let name = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp: PathBuf = dir.join(format!(".{name}.chud-{}.tmp", std::process::id()));
    let result = (|| -> AppResult<()> {
        let mut file = File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        if let Ok(meta) = fs::metadata(dest) {
            if meta.permissions().readonly() {
                return Err(AppError::new(ErrorCode::PermissionDenied, "file is read-only"));
            }
        }
        fs::rename(&tmp, dest)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Saves `src` rotated by `turns` clockwise quarter turns into `dest` (or over `src`).
pub fn save_rotation(src: &Path, turns: i32, dest: Option<&Path>) -> AppResult<SaveOutcome> {
    let dest = dest.unwrap_or(src);
    let turns = normalize_turns(turns);
    let support = rotation_support(src);
    let ext = extension_of(src);

    match support {
        RotationSupport::Unsupported => {
            let code = if is_animated(src, &ext) { ErrorCode::Animated } else { ErrorCode::ReadOnlyFormat };
            Err(AppError::new(code, format!("cannot save rotated .{ext} files")))
        }
        RotationSupport::Lossless => {
            let bytes = fs::read(src)?;
            let current = jpeg_orient::read_orientation(&bytes);
            let rotated = jpeg_orient::set_orientation(&bytes, compose_orientation(current, turns as i32))?;
            atomic_write(dest, &rotated)?;
            Ok(SaveOutcome { path: dest.display().to_string(), method: support })
        }
        RotationSupport::Reencode => {
            let format = ImageFormat::from_path(dest)
                .or_else(|_| ImageFormat::from_path(src))
                .map_err(|e| AppError::unsupported(e.to_string()))?;
            let mut decoder = ImageReader::open(src)?.with_guessed_format()?.into_decoder()?;
            let icc = decoder.icc_profile().ok().flatten();
            let orientation = decoder.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
            let mut img = DynamicImage::from_decoder(decoder)?;
            // Bake any stored orientation first: re-encoded files carry no EXIF afterwards.
            img.apply_orientation(orientation);
            let img = match turns {
                1 => img.rotate90(),
                2 => img.rotate180(),
                3 => img.rotate270(),
                _ => img,
            };
            let bytes = encode(&img, format, icc)?;
            atomic_write(dest, &bytes)?;
            Ok(SaveOutcome { path: dest.display().to_string(), method: support })
        }
    }
}

fn to_8bit(img: &DynamicImage) -> DynamicImage {
    if img.color().has_alpha() {
        DynamicImage::ImageRgba8(img.to_rgba8())
    } else {
        DynamicImage::ImageRgb8(img.to_rgb8())
    }
}

fn encode(img: &DynamicImage, format: ImageFormat, icc: Option<Vec<u8>>) -> AppResult<Vec<u8>> {
    let mut out = Cursor::new(Vec::new());
    match format {
        ImageFormat::Png => {
            let mut enc = PngEncoder::new_with_quality(&mut out, CompressionType::Default, FilterType::Adaptive);
            if let Some(p) = icc {
                let _ = enc.set_icc_profile(p);
            }
            img.write_with_encoder(enc)?;
        }
        ImageFormat::Tiff => {
            let mut enc = TiffEncoder::new(&mut out);
            if let Some(p) = icc {
                let _ = enc.set_icc_profile(p);
            }
            img.write_with_encoder(enc)?;
        }
        ImageFormat::WebP => {
            let mut enc = WebPEncoder::new_lossless(&mut out);
            if let Some(p) = icc {
                let _ = enc.set_icc_profile(p);
            }
            to_8bit(img).write_with_encoder(enc)?;
        }
        ImageFormat::Pnm => img.write_to(&mut out, format)?,
        other => to_8bit(img).write_to(&mut out, other)?,
    }
    Ok(out.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{GenericImageView, Rgba, RgbaImage};

    #[test]
    fn orientation_composition_matches_exif_table() {
        assert_eq!(compose_orientation(1, 1), 6);
        assert_eq!(compose_orientation(6, 1), 3);
        assert_eq!(compose_orientation(3, 1), 8);
        assert_eq!(compose_orientation(8, 1), 1);
        assert_eq!(compose_orientation(1, -1), 8);
        assert_eq!(compose_orientation(1, 2), 3);
        // Mirrored orientations keep their mirror and cycle 2 → 7 → 4 → 5 → 2.
        assert_eq!(compose_orientation(2, 1), 7);
        assert_eq!(compose_orientation(7, 1), 4);
        assert_eq!(compose_orientation(4, 1), 5);
        assert_eq!(compose_orientation(5, 1), 2);
        for o in 1..=8 {
            assert_eq!(compose_orientation(o, 4), o);
            assert_eq!(compose_orientation(compose_orientation(o, 1), -1), o);
        }
    }

    fn marker_png(path: &Path) {
        // 3×2 image with a red top-left pixel.
        let mut img = RgbaImage::from_pixel(3, 2, Rgba([0, 0, 255, 255]));
        img.put_pixel(0, 0, Rgba([255, 0, 0, 255]));
        img.save(path).unwrap();
    }

    #[test]
    fn png_rotation_reencodes_pixels() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.png");
        marker_png(&path);
        let out = save_rotation(&path, 1, None).unwrap();
        assert_eq!(out.method, RotationSupport::Reencode);
        let img = image::open(&path).unwrap();
        assert_eq!(img.dimensions(), (2, 3));
        // After a clockwise turn the red pixel lands in the top-right corner.
        assert_eq!(img.get_pixel(1, 0), Rgba([255, 0, 0, 255]));
        assert_eq!(img.get_pixel(0, 0), Rgba([0, 0, 255, 255]));
    }

    #[test]
    fn counter_clockwise_and_save_as() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("a.png");
        let dst = dir.path().join("b.bmp");
        marker_png(&src);
        save_rotation(&src, -1, Some(&dst)).unwrap();
        // Original untouched.
        assert_eq!(image::open(&src).unwrap().dimensions(), (3, 2));
        let img = image::open(&dst).unwrap();
        assert_eq!(img.dimensions(), (2, 3));
        assert_eq!(img.get_pixel(0, 2), Rgba([255, 0, 0, 255]));
    }

    #[test]
    fn jpeg_rotation_is_lossless() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("photo.jpg");
        let original = crate::jpeg_orient::tests::sample_jpeg();
        fs::write(&path, &original).unwrap();
        let out = save_rotation(&path, 1, None).unwrap();
        assert_eq!(out.method, RotationSupport::Lossless);
        let saved = fs::read(&path).unwrap();
        assert_eq!(jpeg_orient::read_orientation(&saved), 6);
        save_rotation(&path, 1, None).unwrap();
        assert_eq!(jpeg_orient::read_orientation(&fs::read(&path).unwrap()), 3);
        let a = image::load_from_memory(&original).unwrap().to_rgb8();
        let b = image::load_from_memory(&fs::read(&path).unwrap()).unwrap().to_rgb8();
        assert_eq!(a.as_raw(), b.as_raw());
    }

    #[test]
    fn read_only_formats_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.svg");
        fs::write(&path, "<svg xmlns='http://www.w3.org/2000/svg'/>").unwrap();
        let err = save_rotation(&path, 1, None).unwrap_err();
        assert_eq!(err.code, ErrorCode::ReadOnlyFormat);
        assert_eq!(fs::read_to_string(&path).unwrap(), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    }

    #[test]
    fn atomic_write_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.bin");
        fs::write(&path, b"old").unwrap();
        atomic_write(&path, b"new").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
