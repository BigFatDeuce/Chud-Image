import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";

export type ErrorCode =
  | "not_found"
  | "permission_denied"
  | "unsupported"
  | "corrupt"
  | "read_only_format"
  | "animated"
  | "too_large"
  | "trash_unavailable"
  | "network"
  | "cancelled"
  | "io";

export interface AppError {
  code: ErrorCode;
  message: string;
}

export function isAppError(e: unknown): e is AppError {
  return typeof e === "object" && e !== null && "code" in e && "message" in e;
}

export function toAppError(e: unknown): AppError {
  if (isAppError(e)) return e;
  return { code: "io", message: e instanceof Error ? e.message : String(e) };
}

export interface FolderListing {
  folder: string;
  files: string[];
  index: number;
}

export type ThemeSetting = "system" | "light" | "dark";
export type TransitionSetting = "glitch" | "fade" | "none";
export type WheelSetting = "zoom" | "navigate";
export type BackgroundSetting = "auto" | "black" | "gray" | "white";
export type LanguageSetting = "system" | "fr" | "en";

export interface Settings {
  theme: ThemeSetting;
  language: LanguageSetting;
  slideshowInterval: number;
  slideshowLoop: boolean;
  transition: TransitionSetting;
  wheelAction: WheelSetting;
  wrapNavigation: boolean;
  confirmDelete: boolean;
  background: BackgroundSetting;
  transparencyChecker: boolean;
  autohideControls: boolean;
  autoUpdate: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  language: "system",
  slideshowInterval: 4,
  slideshowLoop: true,
  transition: "glitch",
  wheelAction: "zoom",
  wrapNavigation: true,
  confirmDelete: true,
  background: "auto",
  transparencyChecker: true,
  autohideControls: true,
  autoUpdate: true,
};

export interface ExifEntry {
  group: string;
  tag: string;
  value: string;
}

export interface ImageInfo {
  name: string;
  path: string;
  folder: string;
  extension: string;
  formatName: string;
  fileSize: number;
  modified: number | null;
  created: number | null;
  width: number | null;
  height: number | null;
  orientation: number | null;
  dpiX: number | null;
  dpiY: number | null;
  dateTaken: string | null;
  cameraMake: string | null;
  cameraModel: string | null;
  lens: string | null;
  exposureTime: string | null;
  fNumber: string | null;
  iso: string | null;
  focalLength: string | null;
  focalLength35mm: string | null;
  exposureBias: string | null;
  flash: string | null;
  whiteBalance: string | null;
  software: string | null;
  artist: string | null;
  copyright: string | null;
  colorSpace: string | null;
  gps: { latitude: number; longitude: number; altitude: number | null } | null;
  exif: ExifEntry[];
}

export type RotationSupport = "lossless" | "reencode" | "unsupported";

export interface SaveOutcome {
  path: string;
  method: RotationSupport;
}

export interface EditOutcome {
  path: string;
  trashed: boolean;
}

export interface BgModelStatus {
  installed: boolean;
  name: string;
  url: string;
  homepage: string;
  license: string;
  /** Also downloaded with the model (Linux: ONNX Runtime), if anything. */
  runtime: string | null;
  runtimeUrl: string | null;
  /** Total download size in bytes. */
  size: number;
}

export const api = {
  bgModelStatus: () => invoke<BgModelStatus>("bg_model_status"),
  /** Downloads the background-removal model (only ever on the user's request). */
  bgModelDownload: (onProgress: (received: number, total: number) => void) => {
    const channel = new Channel<{ received: number; total: number }>();
    channel.onmessage = (m) => onProgress(m.received, m.total);
    return invoke<void>("bg_model_download", { onProgress: channel });
  },
  bgModelCancel: () => invoke<void>("bg_model_cancel"),
  bgModelDelete: () => invoke<void>("bg_model_delete"),
  /** 1024x1024 RGBA in, 1024x1024 subject mask (one byte per pixel) out. */
  bgMask: async (rgba: Uint8Array) => new Uint8Array(await invoke<ArrayBuffer>("bg_mask", rgba)),
  installKind: () => invoke<"windows" | "macos" | "appimage" | "package">("install_kind"),
  /** Saves editor output (PNG bytes) as `dest`; "replace" sends the original to the trash. */
  saveEdit: (png: Uint8Array, dest: string, source: string, mode: "copy" | "replace", quality = 92) =>
    invoke<EditOutcome>("save_edit", png, {
      headers: {
        "x-dest": encodeURIComponent(dest),
        "x-source": encodeURIComponent(source),
        "x-mode": mode,
        "x-quality": String(quality),
      },
    }),
  launchPath: () => invoke<string | null>("launch_path"),
  supportedExtensions: () => invoke<string[]>("supported_extensions"),
  openTarget: (path: string) => invoke<FolderListing>("open_target", { path }),
  listFolder: (folder: string) => invoke<string[]>("list_folder", { folder }),
  imageInfo: (path: string) => invoke<ImageInfo>("image_info", { path }),
  diagnose: (path: string, forceDecode: boolean) =>
    invoke<AppError | null>("diagnose", { path, forceDecode }),
  rotationSupport: (path: string) => invoke<RotationSupport>("rotation_support", { path }),
  saveRotation: (path: string, turns: number, dest?: string) =>
    invoke<SaveOutcome>("save_rotation", { path, turns, dest: dest ?? null }),
  deleteToTrash: (path: string) => invoke<void>("delete_to_trash", { path }),
  deletePermanently: (path: string) => invoke<void>("delete_permanently", { path }),
  fileExists: (path: string) => invoke<boolean>("file_exists", { path }),
  loadSettings: () => invoke<Settings>("load_settings"),
  saveSettings: (value: Settings) => invoke<void>("save_settings", { value }),
};

/** Formats the webview decodes itself; everything else is decoded by the backend. */
export const NATIVE_EXTENSIONS = new Set([
  "jpg", "jpeg", "jpe", "jfif", "pjpeg", "pjp", "png", "apng", "gif", "webp", "avif", "bmp", "dib", "ico", "svg",
]);

/** URL of a picture served by the backend's `chud://` protocol. */
export function imageUrl(path: string, opts: { decode?: boolean; version?: number } = {}): string {
  const base = convertFileSrc(path, "chud");
  const query: string[] = [];
  if (opts.decode) query.push("decode=1");
  if (opts.version) query.push(`v=${opts.version}`);
  return query.length ? `${base}?${query.join("&")}` : base;
}
