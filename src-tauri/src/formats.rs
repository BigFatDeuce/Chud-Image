//! Which file extensions Chud Image opens, and which decoder handles each of them.

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::OnceLock;

/// How a file is turned into something the webview can display.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// The webview decodes the bytes itself (fast, colour managed, animated GIF/WebP).
    Native,
    /// Decoded in Rust by the `image` crate, then handed over as PNG.
    ImageCrate,
    /// Camera RAW: the full-size JPEG preview embedded by the camera is extracted.
    Raw,
    /// HEIC / HEIF: Windows Imaging Component on Windows, libheif on Linux.
    Heif,
    /// Any other codec installed in Windows Imaging Component (JPEG XR, JPEG XL…).
    System,
}

pub const NATIVE: &[&str] = &[
    "jpg", "jpeg", "jpe", "jfif", "pjpeg", "pjp", "png", "apng", "gif", "webp", "avif", "bmp",
    "dib", "ico", "svg",
];
pub const IMAGE_CRATE: &[&str] = &["tif", "tiff", "tga", "qoi", "pnm", "pbm", "pgm", "ppm", "pam"];
pub const RAW: &[&str] = &[
    "dng", "cr2", "cr3", "crw", "nef", "nrw", "arw", "srf", "sr2", "orf", "rw2", "raf", "pef",
    "srw", "x3f", "3fr", "mef", "mos", "erf", "kdc", "dcr", "rwl", "iiq",
];
pub const HEIF: &[&str] = &["heic", "heif", "hif"];

pub fn extension_of(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default()
}

pub fn route_for(path: &Path) -> Option<Route> {
    let ext = extension_of(path);
    let ext = ext.as_str();
    if NATIVE.contains(&ext) {
        Some(Route::Native)
    } else if IMAGE_CRATE.contains(&ext) {
        Some(Route::ImageCrate)
    } else if RAW.contains(&ext) {
        Some(Route::Raw)
    } else if HEIF.contains(&ext) {
        heif_available().then_some(Route::Heif)
    } else if system_extensions().contains(ext) {
        Some(Route::System)
    } else {
        None
    }
}

pub fn is_supported(path: &Path) -> bool {
    route_for(path).is_some()
}

/// Every extension that can currently be opened, sorted, without dots.
pub fn supported_extensions() -> Vec<String> {
    let mut all: BTreeSet<String> = NATIVE
        .iter()
        .chain(IMAGE_CRATE)
        .chain(RAW)
        .map(|s| s.to_string())
        .collect();
    if heif_available() {
        all.extend(HEIF.iter().map(|s| s.to_string()));
    }
    all.extend(system_extensions().iter().cloned());
    all.into_iter().collect()
}

/// MIME type used when the webview decodes the file itself.
pub fn native_mime(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" | "jpe" | "jfif" | "pjpeg" | "pjp" => "image/jpeg",
        "png" => "image/png",
        "apng" => "image/apng",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" | "dib" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

/// Extensions decodable by codecs installed in the operating system, excluding the ones
/// already covered by a dedicated route above.
pub fn system_extensions() -> &'static BTreeSet<String> {
    static CACHE: OnceLock<BTreeSet<String>> = OnceLock::new();
    CACHE.get_or_init(|| {
        #[cfg(windows)]
        {
            let covered: BTreeSet<&str> = NATIVE
                .iter()
                .chain(IMAGE_CRATE)
                .chain(RAW)
                .chain(HEIF)
                .copied()
                .collect();
            crate::wic::decoder_extensions()
                .into_iter()
                .filter(|e| !covered.contains(e.as_str()))
                .collect()
        }
        #[cfg(not(windows))]
        {
            BTreeSet::new()
        }
    })
}

pub fn heif_available() -> bool {
    static CACHE: OnceLock<bool> = OnceLock::new();
    *CACHE.get_or_init(|| {
        #[cfg(windows)]
        {
            crate::wic::decoder_extensions().iter().any(|e| e == "heic")
        }
        #[cfg(all(target_os = "linux", feature = "heif"))]
        {
            true
        }
        #[cfg(not(any(windows, all(target_os = "linux", feature = "heif"))))]
        {
            false
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_by_extension_case_insensitively() {
        assert_eq!(route_for(Path::new("a/B.JPG")), Some(Route::Native));
        assert_eq!(route_for(Path::new("scan.TIFF")), Some(Route::ImageCrate));
        assert_eq!(route_for(Path::new("x.cr2")), Some(Route::Raw));
        assert_eq!(route_for(Path::new("notes.txt")), None);
        assert_eq!(route_for(Path::new("no_extension")), None);
    }

    #[test]
    fn supported_list_contains_minimum_formats() {
        let list = supported_extensions();
        for ext in ["jpg", "jpeg", "png", "bmp", "gif", "webp", "tiff", "avif", "ico"] {
            assert!(list.iter().any(|e| e == ext), "{ext} missing");
        }
    }
}
