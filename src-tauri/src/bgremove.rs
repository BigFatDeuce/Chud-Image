//! Optional background removal, run entirely on this computer with ONNX Runtime.
//!
//! The model is not shipped with the app: the user downloads it once, on request, from a
//! fixed URL. The file is checked against a known SHA-256 before it is used.
//!
//! The editor sends a 1024×1024 RGBA rendering of the picture and gets back a 1024×1024
//! mask (one byte per pixel, 255 = keep). Scaling it back to the picture, thresholding
//! and compositing all happen in the editor, so the threshold can change instantly.

use crate::error::{AppError, AppResult, ErrorCode};
use ort::environment::Environment;
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fmt::Display;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// Side of the square the model works on.
pub const SIDE: usize = 1024;

pub struct ModelInfo {
    pub name: &'static str,
    pub file: &'static str,
    pub url: &'static str,
    pub homepage: &'static str,
    pub license: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

/// BiRefNet general-purpose segmentation, "lite" (Swin-T backbone), exported to ONNX by
/// the rembg project.
pub const MODEL: ModelInfo = ModelInfo {
    name: "BiRefNet (general, lite)",
    file: "birefnet-general-lite.onnx",
    url: "https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx",
    homepage: "https://github.com/ZhengPeng7/BiRefNet",
    license: "MIT",
    size: 224_005_088,
    sha256: "5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333",
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    installed: bool,
    name: &'static str,
    url: &'static str,
    homepage: &'static str,
    license: &'static str,
    size: u64,
}

#[derive(Default)]
pub struct BgState {
    /// Loaded on first use, then kept for the next pictures.
    session: Mutex<Option<(Environment, Session)>>,
    cancel: AtomicBool,
    downloading: AtomicBool,
}

fn ort_err(e: impl Display) -> AppError {
    AppError::new(ErrorCode::Io, format!("background model: {e}"))
}

fn net_err(e: impl Display) -> AppError {
    AppError::new(ErrorCode::Network, e.to_string())
}

pub fn model_path(dir: &Path) -> PathBuf {
    dir.join("models").join(MODEL.file)
}

pub fn status(dir: &Path) -> ModelStatus {
    let installed = fs::metadata(model_path(dir)).map(|m| m.len() == MODEL.size).unwrap_or(false);
    ModelStatus {
        installed,
        name: MODEL.name,
        url: MODEL.url,
        homepage: MODEL.homepage,
        license: MODEL.license,
        size: MODEL.size,
    }
}

/// Clears the busy flag however the download ends.
struct Busy<'a>(&'a AtomicBool);
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Downloads the model into `dir/models`, reporting `(received, total)` bytes.
pub async fn download(dir: &Path, state: &BgState, mut progress: impl FnMut(u64, u64)) -> AppResult<()> {
    if state.downloading.swap(true, Ordering::SeqCst) {
        return Err(AppError::new(ErrorCode::Io, "already downloading"));
    }
    let _busy = Busy(&state.downloading);
    state.cancel.store(false, Ordering::SeqCst);

    // Same TLS setup as the updater plugin, which shares this reqwest build.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let client = reqwest::Client::builder()
        .user_agent(concat!("ChudImage/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(net_err)?;
    let mut response = client
        .get(MODEL.url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(net_err)?;
    let total = response.content_length().unwrap_or(MODEL.size);

    let target = model_path(dir);
    fs::create_dir_all(target.parent().expect("model path has a parent"))?;
    let part = target.with_extension("onnx.part");
    let mut file = fs::File::create(&part)?;
    let mut hasher = Sha256::new();
    let mut received = 0u64;
    let mut last_report = 0u64;
    progress(0, total);

    let result: AppResult<()> = async {
        while let Some(chunk) = response.chunk().await.map_err(net_err)? {
            if state.cancel.load(Ordering::SeqCst) {
                return Err(AppError::new(ErrorCode::Cancelled, "download cancelled"));
            }
            file.write_all(&chunk)?;
            hasher.update(&chunk);
            received += chunk.len() as u64;
            if received - last_report >= 512 * 1024 || received == total {
                last_report = received;
                progress(received, total);
            }
        }
        file.sync_all()?;
        Ok(())
    }
    .await;
    drop(file);

    let checked = result.and_then(|()| {
        let digest = format!("{:x}", hasher.finalize());
        if received != MODEL.size || digest != MODEL.sha256 {
            return Err(AppError::corrupt("the downloaded model does not match the expected file"));
        }
        Ok(())
    });
    if let Err(e) = checked {
        let _ = fs::remove_file(&part);
        return Err(e);
    }
    fs::rename(&part, &target)?;
    Ok(())
}

pub fn cancel(state: &BgState) {
    state.cancel.store(true, Ordering::SeqCst);
}

pub fn delete(dir: &Path, state: &BgState) -> AppResult<()> {
    *state.session.lock().unwrap_or_else(|p| p.into_inner()) = None;
    let path = model_path(dir);
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

/// ImageNet normalisation, channel-planar, as BiRefNet expects.
fn to_input(rgba: &[u8]) -> Vec<f32> {
    const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
    const STD: [f32; 3] = [0.229, 0.224, 0.225];
    let plane = SIDE * SIDE;
    let mut input = vec![0f32; 3 * plane];
    for i in 0..plane {
        for c in 0..3 {
            input[c * plane + i] = (rgba[i * 4 + c] as f32 / 255.0 - MEAN[c]) / STD[c];
        }
    }
    input
}

/// The model outputs logits; the mask is their sigmoid, as bytes.
fn to_mask(logits: &[f32]) -> Vec<u8> {
    logits.iter().map(|&v| (255.0 / (1.0 + (-v).exp())).round() as u8).collect()
}

/// Runs the model on a SIDE×SIDE RGBA picture and returns a SIDE×SIDE mask.
pub fn mask(dir: &Path, state: &BgState, rgba: &[u8]) -> AppResult<Vec<u8>> {
    if rgba.len() != SIDE * SIDE * 4 {
        return Err(AppError::new(ErrorCode::Io, "unexpected picture size"));
    }
    let mut guard = state.session.lock().unwrap_or_else(|p| p.into_inner());
    if guard.is_none() {
        let path = model_path(dir);
        if !status(dir).installed {
            return Err(AppError::new(ErrorCode::NotFound, "the background model is not installed"));
        }
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        // No telemetry: ONNX Runtime can report usage through Windows ETW otherwise.
        let env = ort::environment::init()
            .with_name("chud-image")
            .with_telemetry(false)
            .build()
            .map_err(ort_err)?;
        let session = Session::builder(&env)
            .map_err(ort_err)?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(ort_err)?
            .with_intra_threads(threads)
            .map_err(ort_err)?
            .commit_from_file(path)
            .map_err(ort_err)?;
        *guard = Some((env, session));
    }
    let (_, session) = guard.as_mut().expect("session loaded above");
    let tensor = Tensor::from_array(([1usize, 3, SIDE, SIDE], to_input(rgba))).map_err(ort_err)?;
    let outputs = session.run(ort::inputs![tensor]).map_err(ort_err)?;
    let (_, logits) = outputs[0].try_extract_tensor::<f32>().map_err(ort_err)?;
    if logits.len() < SIDE * SIDE {
        return Err(ort_err("unexpected output size"));
    }
    Ok(to_mask(&logits[..SIDE * SIDE]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_is_the_sigmoid_of_the_logits() {
        assert_eq!(to_mask(&[-20.0, 0.0, 20.0]), vec![0, 128, 255]);
    }

    #[test]
    fn input_is_planar_and_normalised() {
        let mut rgba = vec![0u8; SIDE * SIDE * 4];
        rgba[0] = 255; // first pixel: pure red
        let input = to_input(&rgba);
        let plane = SIDE * SIDE;
        assert!((input[0] - (1.0 - 0.485) / 0.229).abs() < 1e-5);
        assert!((input[plane] - (0.0 - 0.456) / 0.224).abs() < 1e-5);
        assert_eq!(input.len(), 3 * plane);
    }

    #[test]
    fn not_installed_until_the_file_is_complete() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!status(dir.path()).installed);
        fs::create_dir_all(dir.path().join("models")).unwrap();
        fs::write(model_path(dir.path()), b"partial").unwrap();
        assert!(!status(dir.path()).installed);
        let state = BgState::default();
        assert!(mask(dir.path(), &state, &vec![0; SIDE * SIDE * 4]).is_err());
        delete(dir.path(), &state).unwrap();
        assert!(!model_path(dir.path()).exists());
    }

    /// Needs the real model: `CHUD_BG_MODEL_DIR=<dir containing models/…> cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn runs_the_real_model() {
        let dir = PathBuf::from(std::env::var("CHUD_BG_MODEL_DIR").expect("CHUD_BG_MODEL_DIR"));
        let state = BgState::default();
        // A dark square on a light background: the square is the subject.
        let mut rgba = vec![235u8; SIDE * SIDE * 4];
        for y in 312..712 {
            for x in 312..712 {
                let i = (y * SIDE + x) * 4;
                rgba[i] = 200;
                rgba[i + 1] = 30;
                rgba[i + 2] = 40;
            }
        }
        let t = std::time::Instant::now();
        let m = mask(&dir, &state, &rgba).unwrap();
        eprintln!("inference: {:?}", t.elapsed());
        assert!(m[512 * SIDE + 512] > 200, "centre should be kept");
        assert!(m[20 * SIDE + 20] < 50, "corner should be removed");
    }
}
