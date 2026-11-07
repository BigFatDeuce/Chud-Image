//! Camera RAW files: nearly every camera stores a JPEG rendition of the photo (usually at
//! full resolution) inside the RAW container. Extracting it is instant, needs no
//! camera-specific code and matches what the camera itself displayed.

use crate::error::AppResult;
use crate::jpeg_orient;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JpegSpan {
    pub start: usize,
    pub end: usize,
    pub width: u32,
    pub height: u32,
}

fn be16(d: &[u8], at: usize) -> usize {
    u16::from_be_bytes([d[at], d[at + 1]]) as usize
}

/// Parses a JPEG starting at `d[0]` (which must be FF D8) and returns its length and
/// dimensions. Lossless / arithmetic-coded JPEGs (used for raw sensor data) are rejected.
pub fn jpeg_extent(d: &[u8]) -> Option<(usize, u32, u32)> {
    if d.len() < 4 || d[0] != 0xFF || d[1] != 0xD8 {
        return None;
    }
    let mut pos = 2;
    let mut dims: Option<(u32, u32)> = None;
    loop {
        if pos + 2 > d.len() || d[pos] != 0xFF {
            return None;
        }
        while pos < d.len() && d[pos] == 0xFF {
            pos += 1;
        }
        if pos >= d.len() {
            return None;
        }
        let marker = d[pos];
        pos += 1;
        match marker {
            0x01 | 0xD0..=0xD7 => continue,
            0xD8 => return None,
            0xD9 => return dims.map(|(w, h)| (pos, w, h)),
            _ => {}
        }
        if pos + 2 > d.len() {
            return None;
        }
        let len = be16(d, pos);
        if len < 2 || pos + len > d.len() {
            return None;
        }
        match marker {
            0xC0..=0xC2 => {
                if len < 7 {
                    return None;
                }
                let h = be16(d, pos + 3) as u32;
                let w = be16(d, pos + 5) as u32;
                if w == 0 || h == 0 {
                    return None;
                }
                dims = Some((w, h));
            }
            // Lossless, hierarchical and arithmetic-coded frames.
            0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF => return None,
            _ => {}
        }
        pos += len;
        if marker == 0xDA {
            // Skip the entropy-coded data up to the next real marker.
            loop {
                if pos + 1 >= d.len() {
                    return None;
                }
                if d[pos] == 0xFF {
                    let next = d[pos + 1];
                    if next == 0x00 || (0xD0..=0xD7).contains(&next) || next == 0xFF {
                        pos += if next == 0xFF { 1 } else { 2 };
                        continue;
                    }
                    break;
                }
                pos += 1;
            }
        }
    }
}

/// Finds the embedded JPEG with the most pixels.
pub fn largest_embedded_jpeg(data: &[u8]) -> Option<JpegSpan> {
    let mut best: Option<JpegSpan> = None;
    let mut i = 0;
    while i + 3 < data.len() {
        let Some(rel) = data[i..].windows(3).position(|w| w == [0xFF, 0xD8, 0xFF]) else { break };
        let start = i + rel;
        match jpeg_extent(&data[start..]) {
            Some((len, width, height)) => {
                let span = JpegSpan { start, end: start + len, width, height };
                let area = |s: &JpegSpan| s.width as u64 * s.height as u64;
                if best.map_or(true, |b| area(&span) > area(&b)) {
                    best = Some(span);
                }
                i = start + len;
            }
            None => i = start + 2,
        }
    }
    best
}

/// Orientation stored in the RAW container's own TIFF/EXIF structure.
pub fn raw_orientation(data: &[u8]) -> Option<u16> {
    let read = |buf: Vec<u8>| -> Option<u16> {
        let exif = exif::Reader::new().read_raw(buf).ok()?;
        let v = exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)?.value.get_uint(0)?;
        (1..=8).contains(&v).then_some(v as u16)
    };
    if data.len() < 8 {
        return None;
    }
    // Plain TIFF-based RAW (DNG, CR2, NEF, ARW, PEF, SRW…).
    if &data[0..4] == b"II*\0" || &data[0..4] == b"MM\0*" {
        if let Some(o) = read(data.to_vec()) {
            return Some(o);
        }
    }
    // Olympus ("IIRO"/"IIRS") and Panasonic ("IIU\0") use TIFF with a different magic.
    if &data[0..2] == b"II" && (&data[2..4] == b"RO" || &data[2..4] == b"RS" || &data[2..4] == b"U\0") {
        let mut copy = data.to_vec();
        copy[2] = 0x2A;
        copy[3] = 0;
        if let Some(o) = read(copy) {
            return Some(o);
        }
    }
    // Containers such as Canon CR3 embed a TIFF header near the start of the file.
    let window = &data[..data.len().min(512 * 1024)];
    for magic in [b"II*\0", b"MM\0*"] {
        let mut from = 8;
        while let Some(rel) = window[from..].windows(4).position(|w| w == magic) {
            let off = from + rel;
            let end = data.len().min(off + 4 * 1024 * 1024);
            if let Some(o) = read(data[off..end].to_vec()) {
                return Some(o);
            }
            from = off + 4;
        }
    }
    None
}

/// Returns the embedded preview as a JPEG carrying the RAW file's orientation, or `None`
/// when the file contains no usable preview.
pub fn extract_preview(path: &Path) -> AppResult<Option<(Vec<u8>, JpegSpan)>> {
    let data = fs::read(path)?;
    let Some(span) = largest_embedded_jpeg(&data) else { return Ok(None) };
    let jpeg = &data[span.start..span.end];
    let bytes = match raw_orientation(&data) {
        Some(o) => jpeg_orient::set_orientation(jpeg, o).unwrap_or_else(|_| jpeg.to_vec()),
        None => jpeg.to_vec(),
    };
    Ok(Some((bytes, span)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageFormat, Rgb, RgbImage};
    use std::io::Cursor;

    fn jpeg(w: u32, h: u32) -> Vec<u8> {
        let img = RgbImage::from_fn(w, h, |x, y| Rgb([x as u8, y as u8, 200]));
        let mut out = Cursor::new(Vec::new());
        img.write_to(&mut out, ImageFormat::Jpeg).unwrap();
        out.into_inner()
    }

    #[test]
    fn extent_of_a_plain_jpeg() {
        let j = jpeg(64, 40);
        assert_eq!(jpeg_extent(&j), Some((j.len(), 64, 40)));
    }

    #[test]
    fn picks_the_largest_preview_in_a_fake_raw_file() {
        let small = jpeg(32, 24);
        let big = jpeg(160, 120);
        let mut raw = b"II*\0\x08\0\0\0".to_vec();
        raw.extend(std::iter::repeat(0xAB).take(1000));
        raw.extend_from_slice(&small);
        raw.extend(std::iter::repeat(0xFF).take(17));
        raw.extend_from_slice(&big);
        raw.extend(std::iter::repeat(0x00).take(500));

        let span = largest_embedded_jpeg(&raw).unwrap();
        assert_eq!((span.width, span.height), (160, 120));
        assert_eq!(&raw[span.start..span.end], &big[..]);

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.nef");
        fs::write(&path, &raw).unwrap();
        let (bytes, _) = extract_preview(&path).unwrap().unwrap();
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (160, 120));
    }

    #[test]
    fn no_preview_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.cr2");
        fs::write(&path, vec![0x11u8; 4096]).unwrap();
        assert!(extract_preview(&path).unwrap().is_none());
    }

    #[test]
    fn lossless_jpeg_is_ignored() {
        // SOI + SOF3 segment: raw sensor data, not a preview.
        let mut d = vec![0xFF, 0xD8, 0xFF, 0xC3, 0x00, 0x0B, 8, 0, 16, 0, 16, 1, 1, 0x11, 0];
        d.extend_from_slice(&[0xFF, 0xD9]);
        assert_eq!(jpeg_extent(&d), None);
    }
}
