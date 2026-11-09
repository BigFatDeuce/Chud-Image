//! Chud Image — backend.

mod bgremove;
mod decode;
mod edit;
mod error;
mod files;
mod folder;
mod formats;
#[cfg(all(target_os = "linux", feature = "heif"))]
mod heif_linux;
mod jpeg_orient;
mod metadata;
mod raw;
mod rotate;
mod settings;
#[cfg(windows)]
mod wic;

use decode::DecodeCache;
use error::{AppError, AppResult, ErrorCode};
use std::path::{Path, PathBuf};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager};

/// Image opened from the command line ("Open with…" / double-click in the file manager).
struct LaunchPath(Option<String>);

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::new(ErrorCode::Io, e.to_string()))?
}

fn settings_path(app: &AppHandle) -> AppResult<PathBuf> {
    app.path()
        .app_config_dir()
        .map(|d| d.join("settings.json"))
        .map_err(|e| AppError::new(ErrorCode::Io, e.to_string()))
}

#[tauri::command]
fn launch_path(state: tauri::State<'_, LaunchPath>) -> Option<String> {
    state.0.clone()
}

#[tauri::command]
async fn supported_extensions() -> Vec<String> {
    blocking(|| Ok(formats::supported_extensions())).await.unwrap_or_default()
}

#[tauri::command]
async fn open_target(path: String) -> AppResult<folder::FolderListing> {
    blocking(move || folder::open_target(Path::new(&path))).await
}

#[tauri::command]
async fn list_folder(folder: String) -> AppResult<Vec<String>> {
    blocking(move || {
        Ok(folder::list_images(Path::new(&folder))?.iter().map(|p| p.display().to_string()).collect())
    })
    .await
}

#[tauri::command]
async fn image_info(path: String) -> AppResult<metadata::ImageInfo> {
    blocking(move || metadata::image_info(Path::new(&path))).await
}

/// Explains why a picture could not be displayed (`None` when it actually decodes fine).
#[tauri::command]
async fn diagnose(app: AppHandle, path: String, force_decode: bool) -> Option<AppError> {
    blocking(move || {
        let cache = app.state::<DecodeCache>();
        Ok(decode::load_for_display(Path::new(&path), force_decode, &cache).err())
    })
    .await
    .unwrap_or_else(Some)
}

#[tauri::command]
async fn rotation_support(path: String) -> rotate::RotationSupport {
    blocking(move || Ok(rotate::rotation_support(Path::new(&path))))
        .await
        .unwrap_or(rotate::RotationSupport::Unsupported)
}

#[tauri::command]
async fn save_rotation(app: AppHandle, path: String, turns: i32, dest: Option<String>) -> AppResult<rotate::SaveOutcome> {
    blocking(move || {
        let src = PathBuf::from(&path);
        let dest = dest.map(PathBuf::from);
        let outcome = rotate::save_rotation(&src, turns, dest.as_deref())?;
        let cache = app.state::<DecodeCache>();
        cache.forget(&src);
        if let Some(d) = &dest {
            cache.forget(d);
        }
        Ok(outcome)
    })
    .await
}

/// Saves an edited picture. The body is the PNG rendered by the editor; the target, the
/// original and the mode travel in headers (percent-encoded paths).
#[tauri::command]
async fn save_edit(app: AppHandle, request: tauri::ipc::Request<'_>) -> AppResult<edit::EditOutcome> {
    let tauri::ipc::InvokeBody::Raw(png) = request.body() else {
        return Err(AppError::new(ErrorCode::Io, "expected raw image bytes"));
    };
    let png = png.clone();
    let header = |name: &str| -> Option<String> {
        let v = request.headers().get(name)?.to_str().ok()?;
        Some(percent_encoding::percent_decode_str(v).decode_utf8_lossy().into_owned())
    };
    let dest = PathBuf::from(header("x-dest").ok_or_else(|| AppError::new(ErrorCode::Io, "missing destination"))?);
    let source = header("x-source").map(PathBuf::from);
    let mode = match header("x-mode").as_deref() {
        Some("replace") => edit::SaveMode::ReplaceOriginal,
        _ => edit::SaveMode::Copy,
    };
    let quality = header("x-quality").and_then(|q| q.parse().ok()).unwrap_or(92u8);
    blocking(move || {
        let outcome = edit::save(&dest, &png, source.as_deref(), mode, quality)?;
        app.state::<DecodeCache>().forget(&dest);
        Ok(outcome)
    })
    .await
}

fn models_dir(app: &AppHandle) -> AppResult<PathBuf> {
    app.path().app_local_data_dir().map_err(|e| AppError::new(ErrorCode::Io, e.to_string()))
}

#[tauri::command]
fn bg_model_status(app: AppHandle) -> AppResult<bgremove::ModelStatus> {
    Ok(bgremove::status(&models_dir(&app)?))
}

#[derive(Clone, serde::Serialize)]
struct DownloadProgress {
    received: u64,
    total: u64,
}

/// Downloads the background-removal model, streaming progress to `on_progress`.
#[tauri::command]
async fn bg_model_download(app: AppHandle, on_progress: tauri::ipc::Channel<DownloadProgress>) -> AppResult<()> {
    let dir = models_dir(&app)?;
    let state = app.state::<bgremove::BgState>();
    bgremove::download(&dir, &state, |received, total| {
        let _ = on_progress.send(DownloadProgress { received, total });
    })
    .await
}

#[tauri::command]
fn bg_model_cancel(app: AppHandle) {
    bgremove::cancel(&app.state::<bgremove::BgState>());
}

#[tauri::command]
async fn bg_model_delete(app: AppHandle) -> AppResult<()> {
    let dir = models_dir(&app)?;
    blocking(move || bgremove::delete(&dir, &app.state::<bgremove::BgState>())).await
}

/// Body: 1024×1024 RGBA pixels. Returns the 1024×1024 subject mask as raw bytes.
#[tauri::command]
async fn bg_mask(app: AppHandle, request: tauri::ipc::Request<'_>) -> AppResult<tauri::ipc::Response> {
    let tauri::ipc::InvokeBody::Raw(rgba) = request.body() else {
        return Err(AppError::new(ErrorCode::Io, "expected raw pixels"));
    };
    let rgba = rgba.clone();
    let dir = models_dir(&app)?;
    let mask = blocking(move || bgremove::mask(&dir, &app.state::<bgremove::BgState>(), &rgba)).await?;
    Ok(tauri::ipc::Response::new(mask))
}

/// How the app was installed, which decides whether updates can install themselves.
/// Linux .deb/.rpm installs are owned by the package manager.
#[tauri::command]
fn install_kind() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if std::env::var_os("APPIMAGE").is_some() {
        "appimage"
    } else {
        "package"
    }
}

#[tauri::command]
async fn delete_to_trash(app: AppHandle, path: String) -> AppResult<()> {
    blocking(move || {
        let p = PathBuf::from(&path);
        files::move_to_trash(&p)?;
        app.state::<DecodeCache>().forget(&p);
        Ok(())
    })
    .await
}

#[tauri::command]
async fn delete_permanently(app: AppHandle, path: String) -> AppResult<()> {
    blocking(move || {
        let p = PathBuf::from(&path);
        files::delete_permanently(&p)?;
        app.state::<DecodeCache>().forget(&p);
        Ok(())
    })
    .await
}

#[tauri::command]
async fn file_exists(path: String) -> bool {
    Path::new(&path).is_file()
}

#[tauri::command]
async fn load_settings(app: AppHandle) -> settings::Settings {
    match settings_path(&app) {
        Ok(p) => blocking(move || Ok(settings::load(&p))).await.unwrap_or_default(),
        Err(_) => settings::Settings::default(),
    }
}

#[tauri::command]
async fn save_settings(app: AppHandle, value: settings::Settings) -> AppResult<()> {
    let path = settings_path(&app)?;
    blocking(move || settings::save(&path, &value)).await
}

/// `chud://localhost/<url-encoded path>[?decode=1]` → the picture's bytes.
fn serve_image(app: &AppHandle, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let raw_path = request.uri().path().trim_start_matches('/');
    let path = percent_encoding::percent_decode_str(raw_path).decode_utf8_lossy().into_owned();
    let force = request.uri().query().is_some_and(|q| q.split('&').any(|kv| kv == "decode=1"));
    let cache = app.state::<DecodeCache>();
    let builder = Response::builder().header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    match decode::load_for_display(Path::new(&path), force, &cache) {
        Ok(encoded) => builder
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, encoded.mime)
            .header(header::CACHE_CONTROL, "no-cache")
            .body(encoded.bytes.as_ref().clone())
            .unwrap(),
        Err(err) => {
            let status = match err.code {
                ErrorCode::NotFound => StatusCode::NOT_FOUND,
                ErrorCode::PermissionDenied => StatusCode::FORBIDDEN,
                ErrorCode::Unsupported => StatusCode::UNSUPPORTED_MEDIA_TYPE,
                _ => StatusCode::UNPROCESSABLE_ENTITY,
            };
            builder
                .status(status)
                .header(header::CONTENT_TYPE, "application/json")
                .body(serde_json::to_vec(&err).unwrap_or_default())
                .unwrap()
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let launch = std::env::args_os()
        .skip(1)
        .map(|a| a.to_string_lossy().into_owned())
        .find(|a| !a.starts_with('-'));

    tauri::Builder::default()
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(DecodeCache::new(384 * 1024 * 1024))
        .manage(LaunchPath(launch))
        .manage(bgremove::BgState::default())
        .register_asynchronous_uri_scheme_protocol("chud", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(serve_image(&app, &request));
            });
        })
        .invoke_handler(tauri::generate_handler![
            launch_path,
            supported_extensions,
            open_target,
            list_folder,
            image_info,
            diagnose,
            rotation_support,
            save_rotation,
            delete_to_trash,
            delete_permanently,
            file_exists,
            load_settings,
            save_settings,
            save_edit,
            install_kind,
            bg_model_status,
            bg_model_download,
            bg_model_cancel,
            bg_model_delete,
            bg_mask,
        ])
        .setup(|app| {
            // The window starts hidden to avoid a white flash; the frontend shows it once
            // themed. This is a safety net should the frontend fail to load.
            if let Some(window) = app.get_webview_window("main") {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(2500));
                    let _ = window.show();
                });
            }
            // Warm up the system codec list off the UI thread.
            std::thread::spawn(|| {
                let _ = formats::supported_extensions();
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Chud Image");
}
