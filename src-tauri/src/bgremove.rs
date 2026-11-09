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

/// A file to download on request, checked against its SHA-256.
pub struct Asset {
    /// Name of the installed file in the models folder.
    pub file: &'static str,
    pub url: &'static str,
    /// Size of the download.
    pub size: u64,
    pub sha256: &'static str,
    /// For a .tgz download: the archive member to install as `file`.
    pub member: Option<&'static str>,
}

pub struct ModelInfo {
    pub name: &'static str,
    pub homepage: &'static str,
    pub license: &'static str,
    pub asset: Asset,
}

/// BiRefNet general-purpose segmentation, "lite" (Swin-T backbone), exported to ONNX by
/// the rembg project.
pub const MODEL: ModelInfo = ModelInfo {
    name: "BiRefNet (general, lite)",
    homepage: "https://github.com/ZhengPeng7/BiRefNet",
    license: "MIT",
    asset: Asset {
        file: "birefnet-general-lite.onnx",
        url: "https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx",
        size: 224_005_088,
        sha256: "5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333",
        member: None,
    },
};

/// On Linux, ONNX Runtime itself: Microsoft's official CPU build (needs glibc 2.28+).
#[cfg(target_os = "linux")]
pub const RUNTIME: Option<(&str, Asset)> = Some((
    "ONNX Runtime 1.31 (Microsoft, MIT)",
    Asset {
        file: "libonnxruntime.so.1.31.0",
        url: "https://github.com/microsoft/onnxruntime/releases/download/v1.31.0/onnxruntime-linux-x64-1.31.0.tgz",
        size: 11_408_003,
        sha256: "cc5c72baf5ae5c8238a6841f0897227be2d02826b9cf98eaf02fdefaeeb03a57",
        member: Some("onnxruntime-linux-x64-1.31.0/lib/libonnxruntime.so.1.31.0"),
    },
));

/// Elsewhere ONNX Runtime is linked into the app (Windows) or not available.
#[cfg(not(target_os = "linux"))]
pub const RUNTIME: Option<(&str, Asset)> = None;

fn assets() -> Vec<&'static Asset> {
    let mut v = vec![&MODEL.asset];
    if let Some((_, rt)) = &RUNTIME {
        v.push(rt);
    }
    v
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    installed: bool,
    name: &'static str,
    url: &'static str,
    homepage: &'static str,
    license: &'static str,
    /// What else is downloaded with the model (Linux: ONNX Runtime).
    runtime: Option<&'static str>,
    runtime_url: Option<&'static str>,
    /// Total download size.
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

fn asset_path(dir: &Path, a: &Asset) -> PathBuf {
    dir.join("models").join(a.file)
}

pub fn model_path(dir: &Path) -> PathBuf {
    asset_path(dir, &MODEL.asset)
}

fn asset_ready(dir: &Path, a: &Asset) -> bool {
    match fs::metadata(asset_path(dir, a)) {
        // An extracted file has its own size; a direct download must be complete.
        Ok(m) => a.member.is_some() || m.len() == a.size,
        Err(_) => false,
    }
}

/// Whether ONNX Runtime can be used on this platform at all.
const SUPPORTED: bool = cfg!(any(windows, target_os = "linux"));

pub fn status(dir: &Path) -> ModelStatus {
    ModelStatus {
        installed: SUPPORTED && assets().iter().all(|a| asset_ready(dir, a)),
        name: MODEL.name,
        url: MODEL.asset.url,
        homepage: MODEL.homepage,
        license: MODEL.license,
        runtime: RUNTIME.as_ref().map(|(label, _)| *label),
        runtime_url: RUNTIME.as_ref().map(|(_, a)| a.url),
        size: assets().iter().map(|a| a.size).sum(),
    }
}

/// Clears the busy flag however the download ends.
struct Busy<'a>(&'a AtomicBool);
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Downloads whatever is missing into `dir/models`, reporting `(received, total)` bytes.
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

    let missing: Vec<&Asset> = assets().into_iter().filter(|a| !asset_ready(dir, a)).collect();
    let total: u64 = missing.iter().map(|a| a.size).sum();
    fs::create_dir_all(dir.join("models"))?;
    let mut done = 0u64;
    progress(0, total);
    for a in missing {
        fetch(&client, dir, a, state, |n| progress(done + n, total)).await?;
        done += a.size;
    }
    Ok(())
}

async fn fetch(client: &reqwest::Client, dir: &Path, a: &Asset, state: &BgState, mut progress: impl FnMut(u64)) -> AppResult<()> {
    let mut response = client
        .get(a.url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(net_err)?;
    let target = asset_path(dir, a);
    let part = dir.join("models").join(format!("{}.part", a.file));
    let mut file = fs::File::create(&part)?;
    let mut hasher = Sha256::new();
    let mut received = 0u64;
    let mut last_report = 0u64;

    let result: AppResult<()> = async {
        while let Some(chunk) = response.chunk().await.map_err(net_err)? {
            if state.cancel.load(Ordering::SeqCst) {
                return Err(AppError::new(ErrorCode::Cancelled, "download cancelled"));
            }
            file.write_all(&chunk)?;
            hasher.update(&chunk);
            received += chunk.len() as u64;
            if received - last_report >= 512 * 1024 {
                last_report = received;
                progress(received);
            }
        }
        file.sync_all()?;
        Ok(())
    }
    .await;
    drop(file);

    let checked = result.and_then(|()| {
        let digest = format!("{:x}", hasher.finalize());
        if received != a.size || digest != a.sha256 {
            return Err(AppError::corrupt("the downloaded file does not match the expected one"));
        }
        progress(received);
        match a.member {
            Some(member) => extract(&part, member, &target),
            None => fs::rename(&part, &target).map_err(AppError::from),
        }
    });
    let _ = fs::remove_file(&part);
    checked
}

/// Installs one file of a .tgz archive as `target`.
#[cfg(not(windows))]
fn extract(archive: &Path, member: &str, target: &Path) -> AppResult<()> {
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(fs::File::open(archive)?));
    for entry in tar.entries()? {
        let mut entry = entry?;
        if entry.path()?.to_str() == Some(member) {
            let tmp = target.with_extension("tmp");
            let mut out = fs::File::create(&tmp)?;
            std::io::copy(&mut entry, &mut out)?;
            out.sync_all()?;
            drop(out);
            fs::rename(&tmp, target)?;
            return Ok(());
        }
    }
    Err(AppError::corrupt(format!("{member} is missing from the archive")))
}

#[cfg(windows)]
fn extract(_archive: &Path, _member: &str, _target: &Path) -> AppResult<()> {
    Err(AppError::unsupported("archives are only used on Linux"))
}

pub fn cancel(state: &BgState) {
    state.cancel.store(true, Ordering::SeqCst);
}

pub fn delete(dir: &Path, state: &BgState) -> AppResult<()> {
    *state.session.lock().unwrap_or_else(|p| p.into_inner()) = None;
    for a in assets() {
        let path = asset_path(dir, a);
        if path.exists() {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}

#[cfg(windows)]
fn environment(_dir: &Path) -> AppResult<ort::environment::EnvironmentBuilder> {
    Ok(ort::environment::init())
}

#[cfg(not(windows))]
fn environment(dir: &Path) -> AppResult<ort::environment::EnvironmentBuilder> {
    let (_, rt) = RUNTIME.as_ref().ok_or_else(|| AppError::unsupported("background removal is not available here"))?;
    ort::environment::init_from(asset_path(dir, rt)).map_err(ort_err)
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
        let env = environment(dir)?
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

    /// Downloads everything for real (about 235 MB), then runs it:
    /// `CHUD_BG_MODEL_DIR=<empty dir> cargo test downloads_and_runs -- --ignored`.
    #[test]
    #[ignore]
    fn downloads_and_runs() {
        let dir = PathBuf::from(std::env::var("CHUD_BG_MODEL_DIR").expect("CHUD_BG_MODEL_DIR"));
        let state = BgState::default();
        let mut last = (0, 0);
        tauri::async_runtime::block_on(download(&dir, &state, |r, t| last = (r, t))).unwrap();
        assert!(status(&dir).installed);
        assert_eq!(last.0, last.1);
        assert_eq!(last.1, status(&dir).size);
        assert!(!dir.join("models").read_dir().unwrap().any(|e| e.unwrap().file_name().to_string_lossy().ends_with(".part")));
        runs_the_real_model();
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
