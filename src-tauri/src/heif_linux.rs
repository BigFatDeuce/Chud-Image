//! HEIC / HEIF on Linux through the system libheif (enabled with `--features heif`).
//! libheif applies the container's rotation/mirroring (irot/imir) itself, so the EXIF
//! orientation must not be applied a second time.

use crate::error::{AppError, AppResult};
use image::{DynamicImage, RgbaImage};
use libheif_rs::{ColorSpace, HeifContext, LibHeif, RgbChroma};
use std::path::Path;

pub fn decode(path: &Path) -> AppResult<DynamicImage> {
    let lib = LibHeif::new();
    let path_str = path.to_str().ok_or_else(|| AppError::corrupt("non UTF-8 path"))?;
    let ctx = HeifContext::read_from_file(path_str).map_err(|e| AppError::corrupt(e.to_string()))?;
    let handle = ctx.primary_image_handle().map_err(|e| AppError::corrupt(e.to_string()))?;
    let decoded = lib
        .decode(&handle, ColorSpace::Rgb(RgbChroma::Rgba), None)
        .map_err(|e| AppError::corrupt(e.to_string()))?;
    let planes = decoded.planes();
    let plane = planes.interleaved.ok_or_else(|| AppError::corrupt("no interleaved plane"))?;
    let (w, h, stride) = (plane.width, plane.height, plane.stride);
    let mut buf = Vec::with_capacity(w as usize * h as usize * 4);
    for row in 0..h as usize {
        buf.extend_from_slice(&plane.data[row * stride..row * stride + w as usize * 4]);
    }
    let rgba = RgbaImage::from_raw(w, h, buf).ok_or_else(|| AppError::corrupt("bad buffer"))?;
    Ok(DynamicImage::ImageRgba8(rgba))
}
