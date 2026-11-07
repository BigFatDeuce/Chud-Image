//! File and EXIF information shown in the "Image properties" panel.

use crate::error::AppResult;
use crate::formats::extension_of;
use exif::{Exif, In, Tag, Value};
use serde::Serialize;
use std::fs::{self, File};
use std::io::BufReader;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Gps {
    pub latitude: f64,
    pub longitude: f64,
    pub altitude: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExifEntry {
    pub group: String,
    pub tag: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfo {
    pub name: String,
    pub path: String,
    pub folder: String,
    pub extension: String,
    pub format_name: String,
    pub file_size: u64,
    pub modified: Option<i64>,
    pub created: Option<i64>,
    /// Pixel size as stored in the file (before EXIF orientation).
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub orientation: Option<u16>,
    pub dpi_x: Option<f64>,
    pub dpi_y: Option<f64>,
    pub date_taken: Option<String>,
    pub camera_make: Option<String>,
    pub camera_model: Option<String>,
    pub lens: Option<String>,
    pub exposure_time: Option<String>,
    pub f_number: Option<String>,
    pub iso: Option<String>,
    pub focal_length: Option<String>,
    pub focal_length_35mm: Option<String>,
    pub exposure_bias: Option<String>,
    pub flash: Option<String>,
    pub white_balance: Option<String>,
    pub software: Option<String>,
    pub artist: Option<String>,
    pub copyright: Option<String>,
    pub color_space: Option<String>,
    pub gps: Option<Gps>,
    pub exif: Vec<ExifEntry>,
}

pub fn format_name(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" | "jpe" | "jfif" | "pjpeg" | "pjp" => "JPEG",
        "png" => "PNG",
        "apng" => "APNG",
        "gif" => "GIF",
        "webp" => "WebP",
        "avif" => "AVIF",
        "bmp" | "dib" => "BMP",
        "ico" => "ICO",
        "svg" => "SVG",
        "tif" | "tiff" => "TIFF",
        "tga" => "TGA",
        "qoi" => "QOI",
        "pnm" | "pbm" | "pgm" | "ppm" | "pam" => "Netpbm",
        "heic" | "heif" | "hif" => "HEIF",
        "jxr" | "wdp" | "hdp" => "JPEG XR",
        "jxl" => "JPEG XL",
        "dng" => "Adobe DNG (RAW)",
        "cr2" | "cr3" | "crw" => "Canon RAW",
        "nef" | "nrw" => "Nikon RAW",
        "arw" | "srf" | "sr2" => "Sony RAW",
        "orf" => "Olympus RAW",
        "rw2" => "Panasonic RAW",
        "raf" => "Fujifilm RAW",
        "pef" => "Pentax RAW",
        "srw" => "Samsung RAW",
        _ => "Image",
    }
}

fn millis(t: std::io::Result<SystemTime>) -> Option<i64> {
    t.ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as i64)
}

fn clean(s: String) -> Option<String> {
    let s = s.trim().trim_matches('"').trim().to_string();
    (!s.is_empty()).then_some(s)
}

fn ascii(exif: &Exif, tag: Tag) -> Option<String> {
    let field = exif.get_field(tag, In::PRIMARY)?;
    match &field.value {
        Value::Ascii(parts) => clean(
            parts
                .iter()
                .map(|p| String::from_utf8_lossy(p).trim_end_matches('\0').to_string())
                .collect::<Vec<_>>()
                .join(" "),
        ),
        _ => clean(field.display_value().to_string()),
    }
}

fn shown(exif: &Exif, tag: Tag) -> Option<String> {
    let field = exif.get_field(tag, In::PRIMARY)?;
    clean(field.display_value().with_unit(exif).to_string())
}

fn rational(exif: &Exif, tag: Tag) -> Option<f64> {
    match &exif.get_field(tag, In::PRIMARY)?.value {
        Value::Rational(v) if !v.is_empty() && v[0].denom != 0 => Some(v[0].to_f64()),
        Value::SRational(v) if !v.is_empty() && v[0].denom != 0 => Some(v[0].to_f64()),
        _ => None,
    }
}

fn gps_coord(exif: &Exif, tag: Tag, reference: Tag, negative: u8) -> Option<f64> {
    let Value::Rational(parts) = &exif.get_field(tag, In::PRIMARY)?.value else { return None };
    if parts.len() < 3 || parts.iter().any(|r| r.denom == 0) {
        return None;
    }
    let value = parts[0].to_f64() + parts[1].to_f64() / 60.0 + parts[2].to_f64() / 3600.0;
    let sign = match &exif.get_field(reference, In::PRIMARY)?.value {
        Value::Ascii(v) if v.first().and_then(|s| s.first()) == Some(&negative) => -1.0,
        _ => 1.0,
    };
    Some(value * sign)
}

fn exposure(exif: &Exif) -> Option<String> {
    let Value::Rational(v) = &exif.get_field(Tag::ExposureTime, In::PRIMARY)?.value else { return None };
    let r = v.first()?;
    if r.denom == 0 || r.num == 0 {
        return None;
    }
    let secs = r.to_f64();
    Some(if secs >= 1.0 {
        format!("{} s", (secs * 10.0).round() / 10.0)
    } else {
        format!("1/{} s", (1.0 / secs).round())
    })
}

fn read_exif(path: &Path) -> Option<Exif> {
    let reader = exif::Reader::new();
    let file = File::open(path).ok()?;
    if let Ok(e) = reader.read_from_container(&mut BufReader::new(file)) {
        return Some(e);
    }
    // TIFF-based RAW files with an unusual magic number.
    let data = fs::read(path).ok()?;
    if data.len() > 8 && &data[0..2] == b"II" {
        let mut copy = data;
        copy[2] = 0x2A;
        copy[3] = 0;
        return reader.read_raw(copy).ok();
    }
    None
}

pub fn image_info(path: &Path) -> AppResult<ImageInfo> {
    let meta = fs::metadata(path)?;
    let ext = extension_of(path);
    let mut info = ImageInfo {
        name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        path: path.display().to_string(),
        folder: path.parent().map(|p| p.display().to_string()).unwrap_or_default(),
        format_name: format_name(&ext).to_string(),
        extension: ext.clone(),
        file_size: meta.len(),
        modified: millis(meta.modified()),
        created: millis(meta.created()),
        ..Default::default()
    };
    if let Ok(size) = imagesize::size(path) {
        info.width = Some(size.width as u32);
        info.height = Some(size.height as u32);
    }

    let Some(exif) = read_exif(path) else { return Ok(info) };

    if info.width.is_none() {
        let dim = |tag| exif.get_field(tag, In::PRIMARY).and_then(|f| f.value.get_uint(0));
        info.width = dim(Tag::PixelXDimension).or_else(|| dim(Tag::ImageWidth));
        info.height = dim(Tag::PixelYDimension).or_else(|| dim(Tag::ImageLength));
    }
    info.orientation = exif
        .get_field(Tag::Orientation, In::PRIMARY)
        .and_then(|f| f.value.get_uint(0))
        .filter(|v| (1..=8).contains(v))
        .map(|v| v as u16);
    let unit_is_cm = exif
        .get_field(Tag::ResolutionUnit, In::PRIMARY)
        .and_then(|f| f.value.get_uint(0))
        == Some(3);
    let to_dpi = |v: f64| if unit_is_cm { v * 2.54 } else { v };
    info.dpi_x = rational(&exif, Tag::XResolution).map(to_dpi);
    info.dpi_y = rational(&exif, Tag::YResolution).map(to_dpi);
    info.date_taken = ascii(&exif, Tag::DateTimeOriginal)
        .or_else(|| ascii(&exif, Tag::DateTimeDigitized))
        .or_else(|| ascii(&exif, Tag::DateTime));
    info.camera_make = ascii(&exif, Tag::Make);
    info.camera_model = ascii(&exif, Tag::Model);
    info.lens = ascii(&exif, Tag::LensModel);
    info.exposure_time = exposure(&exif);
    info.f_number = rational(&exif, Tag::FNumber).map(|f| format!("f/{}", (f * 10.0).round() / 10.0));
    info.iso = exif
        .get_field(Tag::PhotographicSensitivity, In::PRIMARY)
        .and_then(|f| f.value.get_uint(0))
        .map(|v| format!("ISO {v}"));
    info.focal_length = rational(&exif, Tag::FocalLength).map(|f| format!("{} mm", (f * 10.0).round() / 10.0));
    info.focal_length_35mm = exif
        .get_field(Tag::FocalLengthIn35mmFilm, In::PRIMARY)
        .and_then(|f| f.value.get_uint(0))
        .filter(|v| *v > 0)
        .map(|v| format!("{v} mm"));
    info.exposure_bias = shown(&exif, Tag::ExposureBiasValue);
    info.flash = shown(&exif, Tag::Flash);
    info.white_balance = shown(&exif, Tag::WhiteBalance);
    info.software = ascii(&exif, Tag::Software);
    info.artist = ascii(&exif, Tag::Artist);
    info.copyright = ascii(&exif, Tag::Copyright);
    info.color_space = shown(&exif, Tag::ColorSpace);
    if let (Some(lat), Some(lon)) = (
        gps_coord(&exif, Tag::GPSLatitude, Tag::GPSLatitudeRef, b'S'),
        gps_coord(&exif, Tag::GPSLongitude, Tag::GPSLongitudeRef, b'W'),
    ) {
        info.gps = Some(Gps { latitude: lat, longitude: lon, altitude: rational(&exif, Tag::GPSAltitude) });
    }

    for field in exif.fields() {
        if field.tag == Tag::MakerNote || field.tag.number() == 0x927C {
            continue;
        }
        let value = match &field.value {
            Value::Undefined(bytes, _) | Value::Byte(bytes) if bytes.len() > 64 => {
                format!("({} bytes)", bytes.len())
            }
            _ => {
                let s = field.display_value().with_unit(&exif).to_string();
                if s.len() > 300 {
                    format!("{}…", &s[..s.char_indices().nth(300).map(|(i, _)| i).unwrap_or(s.len())])
                } else {
                    s
                }
            }
        };
        let group = if field.ifd_num == In::THUMBNAIL { "Thumbnail".to_string() } else { format!("{:?}", field.tag.context()) };
        info.exif.push(ExifEntry { group, tag: field.tag.to_string(), value: value.trim_matches('"').to_string() });
    }
    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_file_information() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Shot 1.png");
        image::RgbImage::new(30, 20).save(&path).unwrap();
        let info = image_info(&path).unwrap();
        assert_eq!(info.name, "Shot 1.png");
        assert_eq!(info.format_name, "PNG");
        assert_eq!((info.width, info.height), (Some(30), Some(20)));
        assert!(info.file_size > 0);
        assert!(info.modified.is_some());
    }

    #[test]
    fn exif_orientation_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.jpg");
        let jpeg = crate::jpeg_orient::set_orientation(&crate::jpeg_orient::tests::sample_jpeg(), 6).unwrap();
        fs::write(&path, jpeg).unwrap();
        let info = image_info(&path).unwrap();
        assert_eq!(info.orientation, Some(6));
        assert!(info.exif.iter().any(|e| e.tag == "Orientation"));
    }
}
