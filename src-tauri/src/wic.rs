//! Windows Imaging Component: decodes every format for which a codec is installed in
//! Windows (HEIC/HEIF through the "HEIF Image Extensions", camera RAW through the
//! "Raw Image Extension", JPEG XR, JPEG XL…).

use crate::error::{AppError, AppResult};
use image::{DynamicImage, RgbaImage};
use std::collections::BTreeSet;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use windows::core::{Interface, PCWSTR};
use windows::Win32::System::Com::StructuredStorage::{PropVariantClear, PropVariantToUInt16, PROPVARIANT};
use windows::Win32::Foundation::GENERIC_READ;
use windows::Win32::Graphics::Imaging::*;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, IEnumUnknown, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};

fn com_error(e: windows::core::Error) -> AppError {
    AppError::corrupt(e.message().to_string())
}

fn factory() -> AppResult<IWICImagingFactory> {
    unsafe {
        // S_FALSE / RPC_E_CHANGED_MODE are fine: COM is already initialised on this thread.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).map_err(com_error)
    }
}

/// Lower-case extensions (without dot) of every installed WIC decoder.
pub fn decoder_extensions() -> BTreeSet<String> {
    // COM must not be initialised on the caller's (possibly UI) thread.
    std::thread::spawn(|| enumerate().unwrap_or_default()).join().unwrap_or_default()
}

fn enumerate() -> AppResult<BTreeSet<String>> {
    let mut out = BTreeSet::new();
    unsafe {
        let factory = factory()?;
        let enumerator: IEnumUnknown = factory
            .CreateComponentEnumerator(WICDecoder.0 as u32, WICComponentEnumerateDefault.0 as u32)
            .map_err(com_error)?;
        loop {
            let mut items = [None];
            let mut fetched = 0u32;
            let hr = enumerator.Next(&mut items, Some(&mut fetched));
            if hr.is_err() || fetched == 0 {
                break;
            }
            let Some(unknown) = items[0].take() else { break };
            let Ok(info) = unknown.cast::<IWICBitmapCodecInfo>() else { continue };
            let mut len = 0u32;
            if info.GetFileExtensions(&mut [], &mut len).is_err() && len == 0 {
                continue;
            }
            let mut buf = vec![0u16; len as usize];
            if info.GetFileExtensions(&mut buf, &mut len).is_err() {
                continue;
            }
            let text = String::from_utf16_lossy(&buf[..buf.iter().position(|&c| c == 0).unwrap_or(buf.len())]);
            for ext in text.split(',') {
                let ext = ext.trim().trim_start_matches('.').to_ascii_lowercase();
                if !ext.is_empty() {
                    out.insert(ext);
                }
            }
        }
    }
    Ok(out)
}

fn orientation_of(frame: &IWICBitmapFrameDecode) -> u16 {
    unsafe {
        let Ok(reader) = frame.GetMetadataQueryReader() else { return 1 };
        let mut value = PROPVARIANT::default();
        let name: Vec<u16> = "System.Photo.Orientation\0".encode_utf16().collect();
        if reader.GetMetadataByName(PCWSTR(name.as_ptr()), &mut value).is_err() {
            return 1;
        }
        let result = PropVariantToUInt16(&value);
        let _ = PropVariantClear(&mut value);
        match result {
            Ok(v) if (1..=8).contains(&v) => v,
            _ => 1,
        }
    }
}

/// Decodes the first frame to RGBA8, applying the stored orientation.
pub fn decode(path: &Path) -> AppResult<DynamicImage> {
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    unsafe {
        let factory = factory()?;
        let decoder = factory
            .CreateDecoderFromFilename(
                PCWSTR(wide.as_ptr()),
                None,
                GENERIC_READ,
                WICDecodeMetadataCacheOnDemand,
            )
            .map_err(|e| AppError::unsupported(e.message().to_string()))?;
        let frame = decoder.GetFrame(0).map_err(com_error)?;
        let orientation = orientation_of(&frame);
        let source: IWICBitmapSource = frame.cast().map_err(com_error)?;
        let converted = WICConvertBitmapSource(&GUID_WICPixelFormat32bppRGBA, &source).map_err(com_error)?;
        let (mut width, mut height) = (0u32, 0u32);
        converted.GetSize(&mut width, &mut height).map_err(com_error)?;
        if width == 0 || height == 0 {
            return Err(AppError::corrupt("empty image"));
        }
        let stride = width as usize * 4;
        let mut buffer = vec![0u8; stride * height as usize];
        converted.CopyPixels(std::ptr::null(), stride as u32, &mut buffer).map_err(com_error)?;
        let rgba = RgbaImage::from_raw(width, height, buffer).ok_or_else(|| AppError::corrupt("bad buffer"))?;
        let mut img = DynamicImage::ImageRgba8(rgba);
        if let Some(o) = image::metadata::Orientation::from_exif(orientation as u8) {
            img.apply_orientation(o);
        }
        Ok(img)
    }
}
