//! Turns any supported file into bytes the webview can display, with a small LRU cache
//! so navigating back and forth never decodes the same picture twice.

use crate::error::{AppError, AppResult, ErrorCode};
use crate::formats::{self, Route};
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{DynamicImage, ImageDecoder, ImageEncoder, ImageReader, Limits};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

#[derive(Clone, Debug)]
pub struct Encoded {
    pub bytes: Arc<Vec<u8>>,
    pub mime: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct CacheKey {
    path: PathBuf,
    modified: u128,
    len: u64,
    forced: bool,
}

impl CacheKey {
    fn for_path(path: &Path, forced: bool) -> AppResult<Self> {
        let meta = fs::metadata(path)?;
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        Ok(Self { path: path.to_path_buf(), modified, len: meta.len(), forced })
    }
}

/// Least-recently-used cache of decoded pictures, bounded by total byte size.
pub struct DecodeCache {
    entries: Mutex<VecDeque<(CacheKey, Encoded)>>,
    in_flight: Mutex<HashMap<CacheKey, Arc<Mutex<()>>>>,
    budget: usize,
}

impl DecodeCache {
    pub fn new(budget: usize) -> Self {
        Self { entries: Mutex::new(VecDeque::new()), in_flight: Mutex::new(HashMap::new()), budget }
    }

    fn get(&self, key: &CacheKey) -> Option<Encoded> {
        let mut entries = self.entries.lock().unwrap();
        let pos = entries.iter().position(|(k, _)| k == key)?;
        let item = entries.remove(pos)?;
        let value = item.1.clone();
        entries.push_front(item);
        Some(value)
    }

    fn insert(&self, key: CacheKey, value: Encoded) {
        let mut entries = self.entries.lock().unwrap();
        entries.retain(|(k, _)| k.path != key.path || k.forced != key.forced);
        entries.push_front((key, value));
        let mut total: usize = entries.iter().map(|(_, v)| v.bytes.len()).sum();
        while total > self.budget && entries.len() > 1 {
            if let Some((_, v)) = entries.pop_back() {
                total -= v.bytes.len();
            }
        }
    }

    pub fn forget(&self, path: &Path) {
        self.entries.lock().unwrap().retain(|(k, _)| k.path != path);
    }

    fn get_or_decode(&self, key: CacheKey, decode: impl FnOnce() -> AppResult<Encoded>) -> AppResult<Encoded> {
        if let Some(hit) = self.get(&key) {
            return Ok(hit);
        }
        // One decode per file at a time: a prefetch and a display request share the work.
        let lock = self.in_flight.lock().unwrap().entry(key.clone()).or_default().clone();
        let guard = lock.lock().unwrap();
        let result = match self.get(&key) {
            Some(hit) => Ok(hit),
            None => decode().inspect(|value| self.insert(key.clone(), value.clone())),
        };
        drop(guard);
        self.in_flight.lock().unwrap().remove(&key);
        result
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.lock().unwrap().len()
    }
}

/// Bytes for the webview. Native formats are passed through untouched; everything else is
/// decoded in Rust. `force_decode` is used when the webview failed to decode a native
/// format itself (for example AVIF on an older WebKitGTK).
pub fn load_for_display(path: &Path, force_decode: bool, cache: &DecodeCache) -> AppResult<Encoded> {
    if !path.exists() {
        return Err(AppError::new(ErrorCode::NotFound, path.display().to_string()));
    }
    let route = formats::route_for(path)
        .ok_or_else(|| AppError::unsupported(format!(".{} files", formats::extension_of(path))))?;
    if route == Route::Native && !force_decode {
        let bytes = fs::read(path)?;
        if bytes.is_empty() {
            return Err(AppError::corrupt("empty file"));
        }
        return Ok(Encoded {
            bytes: Arc::new(bytes),
            mime: formats::native_mime(&formats::extension_of(path)),
        });
    }
    let key = CacheKey::for_path(path, force_decode)?;
    cache.get_or_decode(key, || decode_route(path, route))
}

fn decode_route(path: &Path, route: Route) -> AppResult<Encoded> {
    match route {
        Route::Raw => {
            if let Some((jpeg, span)) = crate::raw::extract_preview(path)? {
                // A tiny thumbnail is a poor substitute: prefer a full decode when the OS can.
                #[cfg(windows)]
                if span.width.max(span.height) < 1200 {
                    if let Ok(full) = system_decode(path) {
                        return Ok(full);
                    }
                }
                let _ = span;
                return Ok(Encoded { bytes: Arc::new(jpeg), mime: "image/jpeg" });
            }
            system_decode(path)
        }
        Route::Heif => heif_decode(path),
        Route::System => system_decode(path),
        Route::ImageCrate | Route::Native => match decode_with_image_crate(path) {
            Ok(enc) => Ok(enc),
            Err(e) => system_decode(path).map_err(|_| e),
        },
    }
}

fn decode_with_image_crate(path: &Path) -> AppResult<Encoded> {
    let mut reader = ImageReader::open(path)?.with_guessed_format()?;
    let mut limits = Limits::default();
    limits.max_alloc = Some(4 * 1024 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader.into_decoder()?;
    let icc = decoder.icc_profile().ok().flatten();
    let orientation = decoder.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut img = DynamicImage::from_decoder(decoder)?;
    img.apply_orientation(orientation);
    to_png(img, icc)
}

/// Fast PNG encoding: the bytes only travel from Rust to the webview in memory.
pub fn to_png(img: DynamicImage, icc: Option<Vec<u8>>) -> AppResult<Encoded> {
    let img = if img.color().has_alpha() {
        DynamicImage::ImageRgba8(img.into_rgba8())
    } else {
        DynamicImage::ImageRgb8(img.into_rgb8())
    };
    let mut out = Cursor::new(Vec::with_capacity(img.as_bytes().len() / 2));
    let mut enc = PngEncoder::new_with_quality(&mut out, CompressionType::Fast, FilterType::Up);
    if let Some(p) = icc {
        let _ = enc.set_icc_profile(p);
    }
    enc.write_image(img.as_bytes(), img.width(), img.height(), img.color().into())?;
    Ok(Encoded { bytes: Arc::new(out.into_inner()), mime: "image/png" })
}

#[cfg(windows)]
fn system_decode(path: &Path) -> AppResult<Encoded> {
    let img = crate::wic::decode(path)?;
    to_png(img, None)
}

#[cfg(not(windows))]
fn system_decode(path: &Path) -> AppResult<Encoded> {
    Err(AppError::unsupported(format!("no decoder for .{}", formats::extension_of(path))))
}

#[cfg(windows)]
fn heif_decode(path: &Path) -> AppResult<Encoded> {
    system_decode(path)
}

#[cfg(all(target_os = "linux", feature = "heif"))]
fn heif_decode(path: &Path) -> AppResult<Encoded> {
    to_png(crate::heif_linux::decode(path)?, None)
}

#[cfg(not(any(windows, all(target_os = "linux", feature = "heif"))))]
fn heif_decode(path: &Path) -> AppResult<Encoded> {
    system_decode(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};

    fn decode_png(bytes: &[u8]) -> DynamicImage {
        image::load_from_memory_with_format(bytes, image::ImageFormat::Png).unwrap()
    }

    #[test]
    fn native_files_are_passed_through() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.png");
        RgbaImage::from_pixel(4, 4, Rgba([1, 2, 3, 255])).save(&path).unwrap();
        let cache = DecodeCache::new(1 << 20);
        let enc = load_for_display(&path, false, &cache).unwrap();
        assert_eq!(enc.mime, "image/png");
        assert_eq!(*enc.bytes, fs::read(&path).unwrap());
        assert_eq!(cache.len(), 0, "native files are never cached in Rust");
    }

    #[test]
    fn tiff_is_decoded_and_cached() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("scan.tif");
        RgbaImage::from_fn(20, 10, |x, _| Rgba([x as u8 * 10, 0, 0, 255])).save(&path).unwrap();
        let cache = DecodeCache::new(1 << 20);
        let a = load_for_display(&path, false, &cache).unwrap();
        assert_eq!(a.mime, "image/png");
        let img = decode_png(&a.bytes);
        assert_eq!((img.width(), img.height()), (20, 10));
        let b = load_for_display(&path, false, &cache).unwrap();
        assert!(Arc::ptr_eq(&a.bytes, &b.bytes), "second load must hit the cache");
    }

    #[test]
    fn forced_decode_of_a_native_format() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.bmp");
        RgbaImage::from_pixel(5, 3, Rgba([9, 9, 9, 255])).save(&path).unwrap();
        let enc = load_for_display(&path, true, &DecodeCache::new(1 << 20)).unwrap();
        assert_eq!(enc.mime, "image/png");
        assert_eq!(decode_png(&enc.bytes).width(), 5);
    }

    #[test]
    fn corrupted_and_missing_files_give_clear_errors() {
        let dir = tempfile::tempdir().unwrap();
        let cache = DecodeCache::new(1 << 20);
        let bad = dir.path().join("broken.tiff");
        fs::write(&bad, b"definitely not a tiff").unwrap();
        let err = load_for_display(&bad, false, &cache).unwrap_err();
        assert!(matches!(err.code, ErrorCode::Corrupt | ErrorCode::Unsupported), "{err:?}");

        let missing = dir.path().join("gone.jpg");
        assert_eq!(load_for_display(&missing, false, &cache).unwrap_err().code, ErrorCode::NotFound);

        let unknown = dir.path().join("x.unknownext");
        fs::write(&unknown, b"x").unwrap();
        assert_eq!(load_for_display(&unknown, false, &cache).unwrap_err().code, ErrorCode::Unsupported);
    }

    #[test]
    fn cache_respects_its_budget() {
        let dir = tempfile::tempdir().unwrap();
        let cache = DecodeCache::new(1);
        for i in 0..3 {
            let p = dir.path().join(format!("{i}.tiff"));
            RgbaImage::from_pixel(8, 8, Rgba([i, 0, 0, 255])).save(&p).unwrap();
            load_for_display(&p, false, &cache).unwrap();
        }
        assert_eq!(cache.len(), 1, "only the most recent entry survives a tiny budget");
    }

    #[test]
    fn changed_file_is_decoded_again() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x.tiff");
        let cache = DecodeCache::new(1 << 20);
        RgbaImage::from_pixel(4, 4, Rgba([0, 0, 0, 255])).save(&p).unwrap();
        load_for_display(&p, false, &cache).unwrap();
        RgbaImage::from_pixel(6, 4, Rgba([0, 0, 0, 255])).save(&p).unwrap();
        let enc = load_for_display(&p, false, &cache).unwrap();
        assert_eq!(decode_png(&enc.bytes).width(), 6);
        assert_eq!(cache.len(), 1);
    }
}
