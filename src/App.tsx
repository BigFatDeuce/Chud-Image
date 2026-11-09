import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { FolderOpen, ImageOff, ImagePlus, Loader2, RotateCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AboutDialog, SettingsDialog, ShortcutsDialog } from "./components/Dialogs";
import { InfoDialog } from "./components/InfoDialog";
import type { Menu, MenuItem } from "./components/MenuBar";
import { ConfirmDialog } from "./components/Modal";
import { PrintDialog } from "./components/PrintDialog";
import { TitleBar } from "./components/TitleBar";
import { UpdateDialog } from "./components/Update";
import { useUpdater } from "./lib/updater";
import { Editor, WRITABLE_EXTENSIONS } from "./editor/Editor";
import { Toolbar } from "./components/Toolbar";
import logo from "./brand/logo.svg";
import logoSmall from "./brand/logo-small.svg";
import {
  api,
  DEFAULT_SETTINGS,
  imageUrl,
  NATIVE_EXTENSIONS,
  toAppError,
  type AppError,
  type RotationSupport,
  type Settings,
} from "./lib/api";
import { I18nContext, makeTranslator, resolveLang, type Key } from "./lib/i18n";
import { dirName, extension, fileName, indexAfterRemoval, relocate, stepIndex } from "./lib/nav";
import { printImage, type PrintOptions } from "./lib/print";
import { actionFor, isTypingTarget, type Action } from "./lib/shortcuts";
import type { Size } from "./lib/zoom";
import { ViewerEngine } from "./viewer/engine";

type Status = "empty" | "emptyFolder" | "loading" | "ready" | "error";

type Dialog =
  | { kind: "info" }
  | { kind: "settings" }
  | { kind: "shortcuts" }
  | { kind: "about" }
  | { kind: "update" }
  | { kind: "delete"; path: string }
  | { kind: "deletePermanent"; path: string; reason: string }
  | { kind: "saveConfirm"; path: string; turns: number }
  | { kind: "quit"; count: number }
  | { kind: "print"; src: string; size: Size; dpi: number | null; blob: boolean };

interface ContextMenu {
  x: number;
  y: number;
}

/** Extensions whose files may contain transparency (checkerboard shown behind them). */
const ALPHA_EXTENSIONS = new Set(["png", "apng", "gif", "webp", "avif", "ico", "svg", "tif", "tiff", "tga", "qoi", "heic", "heif"]);

const norm = (turns: number) => ((turns % 4) + 4) % 4;

function renderRotated(img: HTMLImageElement, turns: number): HTMLCanvasElement {
  const w = img.naturalWidth || 1024;
  const h = img.naturalHeight || 1024;
  const odd = turns % 2 === 1;
  const c = document.createElement("canvas");
  c.width = odd ? h : w;
  c.height = odd ? w : h;
  const ctx = c.getContext("2d")!;
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((turns * Math.PI) / 2);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  return c;
}

export default function App() {
  // ------------------------------------------------------------- settings & i18n
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [ready, setReady] = useState(false);
  const updater = useUpdater(settings.autoUpdate, ready);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const lang = resolveLang(settings.language);
  const i18n = useMemo(() => ({ lang, t: makeTranslator(lang) }), [lang]);
  const t = i18n.t;
  const saveTimer = useRef(0);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((s) => {
      const next = { ...s, ...patch };
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => api.saveSettings(next).catch(() => undefined), 250);
      return next;
    });
  }, []);

  // ------------------------------------------------------------- viewer state
  const [folder, setFolder] = useState<string | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [index, setIndex] = useState(-1);
  const path = index >= 0 ? (files[index] ?? null) : null;
  const [status, setStatus] = useState<Status>("empty");
  const [error, setError] = useState<AppError | null>(null);
  const [loading, setLoading] = useState(false);
  const [zoom, setZoom] = useState({ scale: 1, fit: true, canPan: false });
  const [natural, setNatural] = useState<Size | null>(null);
  const [pending, setPending] = useState<Record<string, number>>({});
  const [versions, setVersions] = useState<Record<string, number>>({});
  const [support, setSupport] = useState<RotationSupport>("unsupported");
  const [editing, setEditing] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [slideshow, setSlideshow] = useState({ active: false, playing: false, enteredFullscreen: false });
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [extensions, setExtensions] = useState<string[]>([]);
  const [dropping, setDropping] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<ViewerEngine | null>(null);
  const animateNext = useRef(false);
  const reencodeConfirmed = useRef(false);
  const pathRef = useRef(path);
  pathRef.current = path;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  const turns = path ? norm(pending[path] ?? 0) : 0;
  const hasImage = status === "ready" && !!path;

  const showToast = useCallback((text: string) => setToast({ text, id: Date.now() }), []);
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 2800);
    return () => window.clearTimeout(id);
  }, [toast]);

  // ------------------------------------------------------------- theme
  const resolvedTheme = settings.theme === "system" ? (systemDark ? "dark" : "light") : settings.theme;
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => setSystemDark(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolvedTheme;
    root.dataset.bg = settings.background;
    root.lang = lang;
    getCurrentWindow()
      .setTheme(settings.theme === "system" ? null : settings.theme)
      .catch(() => undefined);
  }, [resolvedTheme, settings.background, settings.theme, lang]);

  // ------------------------------------------------------------- open
  const openPath = useCallback(
    async (target: string) => {
      try {
        const listing = await api.openTarget(target);
        animateNext.current = false;
        setFolder(listing.folder);
        setFiles(listing.files);
        if (listing.files.length === 0) {
          engineRef.current?.clear();
          setIndex(-1);
          setStatus("emptyFolder");
        } else {
          setIndex(listing.index);
        }
      } catch (e) {
        const err = toAppError(e);
        showToast(t(`error.${err.code}` as Key));
      }
    },
    [showToast, t],
  );

  // Startup: settings, supported formats, file passed on the command line.
  // Runs once: `openPath` changes identity with the language, and re-running this would
  // reload stale settings from disk and reopen the launch file.
  const openPathRef = useRef(openPath);
  openPathRef.current = openPath;
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = await api.loadSettings().catch(() => DEFAULT_SETTINGS);
      if (cancelled) return;
      setSettings(s);
      setReady(true);
      api.supportedExtensions().then(setExtensions).catch(() => undefined);
      const launch = await api.launchPath().catch(() => null);
      if (launch) openPathRef.current(launch);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Show the (initially hidden) window once the theme is applied: no white flash.
  useEffect(() => {
    if (!ready) return;
    requestAnimationFrame(() => {
      const win = getCurrentWindow();
      win.show().then(() => win.setFocus()).catch(() => undefined);
    });
  }, [ready]);

  const pickFile = useCallback(async () => {
    const selected = await openDialog({
      multiple: false,
      directory: false,
      defaultPath: folder ?? undefined,
      filters: [
        { name: t("dialog.images"), extensions: extensions.length ? extensions : ["jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff", "avif"] },
        { name: t("dialog.all"), extensions: ["*"] },
      ],
    });
    if (typeof selected === "string") openPath(selected);
  }, [extensions, folder, openPath, t]);

  const pickFolder = useCallback(async () => {
    const selected = await openDialog({ directory: true, multiple: false, defaultPath: folder ?? undefined });
    if (typeof selected === "string") openPath(selected);
  }, [folder, openPath]);

  const closeImage = useCallback(() => {
    engineRef.current?.clear();
    setFiles([]);
    setFolder(null);
    setIndex(-1);
    setStatus("empty");
    setError(null);
    setNatural(null);
  }, []);

  // ------------------------------------------------------------- engine
  const eventsRef = useRef({
    onFailed: () => {},
    onWheelNavigate: (_d: 1 | -1) => {},
  });

  useEffect(() => {
    const host = stageRef.current!;
    const engine = new ViewerEngine(
      host,
      {
        onZoom: (scale, fit, canPan) => setZoom({ scale, fit, canPan }),
        onLoaded: (size) => {
          setNatural(size);
          setError(null);
          setStatus("ready");
        },
        onFailed: () => eventsRef.current.onFailed(),
        onLoading: setLoading,
        onWheelNavigate: (d) => eventsRef.current.onWheelNavigate(d),
      },
      { wheelAction: "zoom", transition: "glitch" },
    );
    engineRef.current = engine;
    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    engineRef.current?.setOptions({ wheelAction: settings.wheelAction, transition: settings.transition });
  }, [settings.wheelAction, settings.transition]);

  const urlsFor = useCallback(
    (p: string) => {
      const native = NATIVE_EXTENSIONS.has(extension(p));
      const version = versions[p];
      return {
        url: imageUrl(p, { version }),
        fallbackUrl: native ? imageUrl(p, { decode: true, version }) : undefined,
      };
    },
    [versions],
  );

  const version = path ? (versions[path] ?? 0) : 0;
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !path) return;
    const animate = animateNext.current;
    animateNext.current = false;
    setStatus((s) => (s === "ready" ? "ready" : "loading"));
    const { url, fallbackUrl } = urlsFor(path);
    const ext = extension(path);
    engine
      .show({
        url,
        fallbackUrl,
        turns: pendingRef.current[path] ?? 0,
        transition: animate,
        checker: settings.transparencyChecker && ALPHA_EXTENSIONS.has(ext),
      })
      .then((ok) => {
        if (!ok || pathRef.current !== path) return;
        const neighbours = [index + 1, index - 1, index + 2]
          .map((i) => files[(i + files.length) % files.length])
          .filter((p): p is string => !!p && p !== path);
        engine.preload([...new Set(neighbours)].map((p) => urlsFor(p).url));
      });
    api.rotationSupport(path).then((s) => pathRef.current === path && setSupport(s)).catch(() => setSupport("unsupported"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, version, settings.transparencyChecker]);

  eventsRef.current.onFailed = () => {
    const p = pathRef.current;
    if (!p) return;
    setNatural(null);
    api
      .diagnose(p, NATIVE_EXTENSIONS.has(extension(p)))
      .then((err) => {
        if (pathRef.current !== p) return;
        setError(err ?? { code: "corrupt", message: "" });
        setStatus("error");
      })
      .catch(() => {
        setError({ code: "corrupt", message: "" });
        setStatus("error");
      });
  };

  // ------------------------------------------------------------- navigation
  const go = useCallback(
    (delta: number, wrapOverride?: boolean): boolean => {
      if (files.length === 0 || index < 0) return false;
      const r = stepIndex(index, files.length, delta, wrapOverride ?? settings.wrapNavigation);
      if (!r) return false;
      animateNext.current = true;
      setIndex(r.index);
      if (r.wrapped && !slideshow.active) showToast(delta > 0 ? t("toast.wrappedStart") : t("toast.wrappedEnd"));
      return true;
    },
    [files.length, index, settings.wrapNavigation, slideshow.active, showToast, t],
  );

  const goTo = (i: number) => {
    if (i < 0 || i >= files.length || i === index) return;
    animateNext.current = true;
    setIndex(i);
  };

  eventsRef.current.onWheelNavigate = (d) => go(d);

  const multi = files.length > 1;
  const canPrev = multi && (settings.wrapNavigation || index > 0);
  const canNext = multi && (settings.wrapNavigation || index < files.length - 1);

  // Keep the listing in sync with the disk when the window regains focus.
  useEffect(() => {
    if (!folder) return;
    const refresh = async () => {
      const current = pathRef.current;
      let list: string[];
      try {
        list = await api.listFolder(folder);
      } catch {
        return;
      }
      if (current && !list.includes(current)) {
        if (await api.fileExists(current)) return; // explicitly opened file with an unusual extension
        showToast(t("toast.fileGone", { name: fileName(current) }));
      }
      setFiles((old) => {
        if (old.length === list.length && old.every((f, i) => f === list[i])) return old;
        const i = relocate(list, current, index);
        animateNext.current = false;
        setIndex(i);
        if (i < 0) {
          engineRef.current?.clear();
          setStatus("emptyFolder");
        }
        return list;
      });
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [folder, index, showToast, t]);

  // ------------------------------------------------------------- rotation & saving
  const rotate = useCallback(
    (d: 1 | -1) => {
      const p = pathRef.current;
      if (!p || status !== "ready") return;
      engineRef.current?.rotateBy(d);
      setPending((old) => ({ ...old, [p]: (old[p] ?? 0) + d }));
    },
    [status],
  );

  const discardRotation = useCallback(() => {
    const p = pathRef.current;
    if (!p) return;
    setPending((old) => {
      const { [p]: _, ...rest } = old;
      return rest;
    });
    engineRef.current?.setTurns(0);
  }, []);

  const doSave = useCallback(
    async (p: string, q: number, dest?: string) => {
      try {
        const out = await api.saveRotation(p, q, dest);
        if (!dest || dest === p) {
          setPending((old) => {
            const { [p]: _, ...rest } = old;
            return rest;
          });
          pendingRef.current = { ...pendingRef.current, [p]: 0 };
          setVersions((v) => ({ ...v, [p]: (v[p] ?? 0) + 1 }));
          showToast(out.method === "lossless" ? t("toast.savedLossless") : t("toast.saved"));
        } else {
          showToast(t("toast.savedCopy", { name: fileName(dest) }));
          if (folder && dirName(dest) === folder) {
            api.listFolder(folder).then((list) => {
              setFiles(list);
              setIndex(relocate(list, pathRef.current, index));
            });
          }
        }
        return true;
      } catch (e) {
        const err = toAppError(e);
        showToast(t("toast.saveFailed", { reason: t(`error.${err.code}` as Key) }));
        return false;
      }
    },
    [folder, index, showToast, t],
  );

  const save = useCallback(
    async (saveAs = false) => {
      const p = pathRef.current;
      if (!p || status !== "ready") return;
      const q = norm(pendingRef.current[p] ?? 0);
      if (support === "unsupported") {
        if (q) showToast(t("error.read_only_format"));
        return;
      }
      if (saveAs) {
        const ext = extension(p);
        const base = fileName(p).replace(/\.[^.]+$/, "");
        const dest = await saveDialog({
          defaultPath: `${dirName(p)}/${base}${q ? "-rotated" : "-copy"}.${ext}`,
          filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
        });
        if (dest) await doSave(p, q, dest);
        return;
      }
      if (!q) return;
      if (support === "reencode" && !reencodeConfirmed.current) {
        setDialog({ kind: "saveConfirm", path: p, turns: q });
        return;
      }
      await doSave(p, q);
    },
    [doSave, showToast, status, support, t],
  );

  // ------------------------------------------------------------- deletion
  const removeFromList = useCallback(
    (p: string) => {
      const i = files.indexOf(p);
      const next = files.filter((f) => f !== p);
      setPending((old) => {
        const { [p]: _, ...rest } = old;
        return rest;
      });
      setFiles(next);
      const ni = indexAfterRemoval(i < 0 ? index : i, next.length);
      animateNext.current = true;
      setIndex(ni);
      if (ni < 0) {
        engineRef.current?.clear();
        setStatus("emptyFolder");
        setNatural(null);
      }
    },
    [files, index],
  );

  const doDelete = useCallback(
    async (p: string) => {
      try {
        await api.deleteToTrash(p);
        removeFromList(p);
        showToast(t("toast.deleted", { name: fileName(p) }));
      } catch (e) {
        const err = toAppError(e);
        if (err.code === "trash_unavailable") setDialog({ kind: "deletePermanent", path: p, reason: err.message });
        else showToast(t("toast.deleteFailed", { reason: t(`error.${err.code}` as Key) }));
      }
    },
    [removeFromList, showToast, t],
  );

  const requestDelete = useCallback(() => {
    const p = pathRef.current;
    if (!p) return;
    if (settings.confirmDelete) setDialog({ kind: "delete", path: p });
    else doDelete(p);
  }, [doDelete, settings.confirmDelete]);

  // ------------------------------------------------------------- fullscreen & slideshow
  const setFs = useCallback(async (value: boolean) => {
    await getCurrentWindow().setFullscreen(value).catch(() => undefined);
    setFullscreen(value);
  }, []);

  useEffect(() => {
    const win = getCurrentWindow();
    let un: (() => void) | undefined;
    win.onResized(() => win.isFullscreen().then(setFullscreen).catch(() => undefined)).then((u) => (un = u));
    return () => un?.();
  }, []);

  const startSlideshow = useCallback(async () => {
    if (!pathRef.current) return;
    const entered = !fullscreen;
    if (entered) await setFs(true);
    setSlideshow({ active: true, playing: true, enteredFullscreen: entered });
    setControlsVisible(false);
  }, [fullscreen, setFs]);

  const stopSlideshow = useCallback(async () => {
    const entered = slideshow.enteredFullscreen;
    setSlideshow({ active: false, playing: false, enteredFullscreen: false });
    setControlsVisible(true);
    if (entered) await setFs(false);
  }, [setFs, slideshow.enteredFullscreen]);

  const togglePlay = useCallback(() => {
    if (!slideshow.active) startSlideshow();
    else setSlideshow((s) => ({ ...s, playing: !s.playing }));
  }, [slideshow.active, startSlideshow]);

  useEffect(() => {
    if (!slideshow.active || !slideshow.playing || loading || dialog) return;
    if (status !== "ready" && status !== "error") return;
    const id = window.setTimeout(() => {
      if (!go(1, settings.slideshowLoop)) {
        stopSlideshow();
        showToast(t("toast.slideshowEnd"));
      }
    }, settings.slideshowInterval * 1000);
    return () => window.clearTimeout(id);
  }, [slideshow.active, slideshow.playing, status, index, loading, dialog, settings.slideshowInterval, settings.slideshowLoop, go, stopSlideshow, showToast, t]);

  // Auto-hide controls and cursor in fullscreen.
  const hideTimer = useRef(0);
  const pokeControls = useCallback(() => {
    setControlsVisible(true);
    window.clearTimeout(hideTimer.current);
    if (fullscreen && settings.autohideControls) {
      hideTimer.current = window.setTimeout(() => {
        if (!document.querySelector(".toolbar:hover, .zoom-popover, .modal-backdrop")) setControlsVisible(false);
      }, 2500);
    }
  }, [fullscreen, settings.autohideControls]);
  useEffect(() => {
    if (!fullscreen) {
      window.clearTimeout(hideTimer.current);
      setControlsVisible(true);
    } else if (!slideshow.active) {
      pokeControls();
    }
  }, [fullscreen, slideshow.active, pokeControls]);

  // ------------------------------------------------------------- printing & clipboard
  const openPrint = useCallback(async () => {
    const engine = engineRef.current;
    const img = engine?.currentImage();
    const p = pathRef.current;
    if (!img || !p || status !== "ready") return;
    const dpi = await api.imageInfo(p).then((i) => i.dpiX).catch(() => null);
    const q = norm(pendingRef.current[p] ?? 0);
    const w = img.naturalWidth || 1024;
    const h = img.naturalHeight || 1024;
    if (q) {
      const canvas = renderRotated(img, q);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
      if (blob) {
        setDialog({ kind: "print", src: URL.createObjectURL(blob), size: { w: canvas.width, h: canvas.height }, dpi, blob: true });
        return;
      }
    }
    setDialog({ kind: "print", src: img.src, size: { w, h }, dpi, blob: false });
  }, [status]);

  const copyImage = useCallback(async () => {
    const img = engineRef.current?.currentImage();
    const p = pathRef.current;
    if (!img || !p) return;
    try {
      const canvas = renderRotated(img, norm(pendingRef.current[p] ?? 0));
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
      if (!blob) throw new Error("encode");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      showToast(t("toast.imageCopied"));
    } catch {
      showToast(t("error.io"));
    }
  }, [showToast, t]);

  // ------------------------------------------------------------- window close
  const requestClose = useCallback(() => {
    getCurrentWindow().close().catch(() => undefined);
  }, []);

  useEffect(() => {
    const win = getCurrentWindow();
    const unlisten = win.onCloseRequested((e) => {
      const dirty = Object.values(pendingRef.current).filter((v) => norm(v) !== 0).length;
      if (dirty > 0) {
        e.preventDefault();
        setDialog({ kind: "quit", count: dirty });
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const saveAllAndQuit = async () => {
    for (const [p, v] of Object.entries(pendingRef.current)) {
      if (norm(v) === 0) continue;
      const s = await api.rotationSupport(p).catch(() => "unsupported" as const);
      if (s !== "unsupported") await api.saveRotation(p, norm(v)).catch(() => undefined);
    }
    getCurrentWindow().destroy();
  };

  // ------------------------------------------------------------- drag and drop
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((e) => {
      const type = e.payload.type;
      if (type === "enter" || type === "over") setDropping(true);
      else if (type === "leave") setDropping(false);
      else if (type === "drop") {
        setDropping(false);
        if (e.payload.paths.length) openPath(e.payload.paths[0]);
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [openPath]);

  // ------------------------------------------------------------- window title
  useEffect(() => {
    getCurrentWindow()
      .setTitle(path ? `${fileName(path)} - Chud Image` : "Chud Image")
      .catch(() => undefined);
  }, [path]);

  // ------------------------------------------------------------- actions & keyboard
  const engine = () => engineRef.current;
  const toggleFitActual = () => (zoom.fit ? engine()?.actualSize() : engine()?.fitToWindow());

  function openEditor() {
    if (!hasImage || !path) return;
    stopSlideshow();
    setContextMenu(null);
    setEditing(true);
  }
  const run = (action: Action, repeat = false) => {
    switch (action) {
      case "prev":
        return go(-1);
      case "next":
        return go(1);
      case "first":
        return goTo(0);
      case "last":
        return goTo(files.length - 1);
      case "space":
        if (repeat) return;
        return slideshow.active ? togglePlay() : go(1);
      case "zoomIn":
        return engine()?.zoomStep(1);
      case "zoomOut":
        return engine()?.zoomStep(-1);
      case "fit":
        return engine()?.fitToWindow();
      case "actual":
        return engine()?.actualSize();
      case "open":
        return pickFile();
      case "openFolder":
        return pickFolder();
      case "print":
        return openPrint();
      case "save":
        return save(false);
      case "saveAs":
        return save(true);
      case "delete":
        return !repeat && requestDelete();
      case "fullscreen":
        return !repeat && setFs(!fullscreen);
      case "slideshow":
        return !repeat && (slideshow.active ? stopSlideshow() : startSlideshow());
      case "escape":
        if (contextMenu) return setContextMenu(null);
        if (slideshow.active) return stopSlideshow();
        if (fullscreen) return setFs(false);
        return;
      case "rotateRight":
        return rotate(1);
      case "rotateLeft":
        return rotate(-1);
      case "info":
        return path && setDialog({ kind: "info" });
      case "shortcuts":
        return setDialog({ kind: "shortcuts" });
      case "closeImage":
        return closeImage();
      case "copy":
        return copyImage();
      case "edit":
        return !repeat && openEditor();
    }
  };
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Never let the webview reload or open its own find bar.
      if (e.key === "F5" || ((e.ctrlKey || e.metaKey) && ["r", "f", "g", "u", "j"].includes(e.key.toLowerCase()))) e.preventDefault();
      if (isTypingTarget(e.target) || document.querySelector(".modal-backdrop, .editor-root")) return;
      const action = actionFor(e);
      if (!action) return;
      e.preventDefault();
      runRef.current(action, e.repeat);
    };
    const onContext = (e: MouseEvent) => {
      if (!isTypingTarget(e.target)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("contextmenu", onContext);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("contextmenu", onContext);
    };
  }, []);

  // ------------------------------------------------------------- menus
  const sel = (label: string, onSelect: () => void, shortcut?: string, disabled?: boolean): MenuItem => ({ label, onSelect, shortcut, disabled });
  const noImage = !hasImage;
  const menus: Menu[] = [
    {
      id: "file",
      label: t("menu.file"),
      items: [
        sel(t("file.open"), pickFile, "Ctrl+O"),
        sel(t("file.openFolder"), pickFolder, "Ctrl+Maj+O".replace("Maj", t("kb.shift"))),
        { type: "separator" },
        sel(t("file.save"), () => save(false), "Ctrl+S", noImage || turns === 0 || support === "unsupported"),
        sel(t("file.saveAs"), () => save(true), `Ctrl+${t("kb.shift")}+S`, noImage || support === "unsupported"),
        sel(t("file.print"), openPrint, "Ctrl+P", noImage),
        { type: "separator" },
        sel(t("file.reveal"), () => path && revealItemInDir(path), undefined, !path),
        sel(t("file.properties"), () => setDialog({ kind: "info" }), "Alt+Enter", !path),
        { type: "separator" },
        sel(t("file.settings"), () => setDialog({ kind: "settings" })),
        { type: "separator" },
        sel(t("file.close"), closeImage, "Ctrl+W", !path && status !== "emptyFolder"),
        sel(t("file.exit"), requestClose, "Alt+F4"),
      ],
    },
    {
      id: "view",
      label: t("menu.view"),
      items: [
        sel(t("view.zoomIn"), () => engine()?.zoomStep(1), "+", noImage),
        sel(t("view.zoomOut"), () => engine()?.zoomStep(-1), "−", noImage),
        sel(t("view.fit"), () => engine()?.fitToWindow(), "Ctrl+0", noImage),
        sel(t("view.actual"), () => engine()?.actualSize(), "Ctrl+1", noImage),
        { type: "separator" },
        sel(t("view.fullscreen"), () => setFs(!fullscreen), "F11"),
        sel(t("view.slideshow"), () => (slideshow.active ? stopSlideshow() : startSlideshow()), "F5", noImage),
        { type: "separator" },
        { type: "label", label: t("view.theme") },
        ...(["system", "light", "dark"] as const).map((th) => ({
          label: t(`theme.${th}` as Key),
          checked: settings.theme === th,
          onSelect: () => updateSettings({ theme: th }),
        })),
      ],
    },
    {
      id: "image",
      label: t("menu.image"),
      items: [
        sel(t("image.rotateLeft"), () => rotate(-1), `${t("kb.shift")}+R`, noImage),
        sel(t("image.rotateRight"), () => rotate(1), "R", noImage),
        sel(t("image.edit"), () => openEditor(), "E", noImage),
        { type: "separator" },
        sel(t("ctx.copy"), copyImage, "Ctrl+C", noImage),
        sel(t("image.delete"), requestDelete, t("kb.del"), !path),
        { type: "separator" },
        sel(t("image.info"), () => setDialog({ kind: "info" }), "Ctrl+I", !path),
      ],
    },
    {
      id: "help",
      label: t("menu.help"),
      items: [sel(t("help.shortcuts"), () => setDialog({ kind: "shortcuts" }), "F1"),
        {
          type: "item",
          label: t("help.updates"),
          onSelect: () => {
            setDialog({ kind: "update" });
            if (updater.state.phase !== "available") void updater.checkNow(false);
          },
        },
        { type: "separator" },
        sel(t("help.about"), () => setDialog({ kind: "about" }))],
    },
  ];

  const contextItems: MenuItem[] = [
    sel(zoom.fit ? t("view.actual") : t("view.fit"), toggleFitActual, zoom.fit ? "Ctrl+1" : "Ctrl+0"),
    { type: "separator" },
    sel(t("image.rotateRight"), () => rotate(1), "R"),
    sel(t("image.rotateLeft"), () => rotate(-1), `${t("kb.shift")}+R`),
    sel(t("image.edit"), () => openEditor(), "E"),
    { type: "separator" },
    sel(t("ctx.copy"), copyImage, "Ctrl+C"),
    sel(t("file.reveal"), () => path && revealItemInDir(path)),
    sel(t("file.print"), openPrint, "Ctrl+P"),
    { type: "separator" },
    sel(t("image.delete"), requestDelete, t("kb.del")),
    sel(t("file.properties"), () => setDialog({ kind: "info" }), "Alt+Enter"),
  ];

  // ------------------------------------------------------------- render
  const name = path ? fileName(path) : null;
  const position = path && files.length > 1 ? `${index + 1} / ${files.length}` : null;
  const toolbarHidden = fullscreen && !controlsVisible;
  const closeDialog = () => setDialog(null);

  return (
    <I18nContext.Provider value={i18n}>
      <div
        className={`app${fullscreen ? " is-fullscreen" : ""}${toolbarHidden ? " hide-cursor" : ""}${slideshow.active ? " in-slideshow" : ""}`}
        onPointerMove={fullscreen ? pokeControls : undefined}
      >
        {!fullscreen && <TitleBar
            menus={menus}
            fileName={name}
            position={position}
            onFullscreen={() => setFs(true)}
            onClose={requestClose}
            updateVersion={updater.state.phase === "available" ? updater.state.version : null}
            onUpdate={() => setDialog({ kind: "update" })}
          />}

        <main className="stage-wrap">
          <div
            className="stage"
            ref={stageRef}
            onContextMenu={(e) => {
              if (!hasImage) return;
              e.preventDefault();
              setContextMenu({ x: e.clientX, y: e.clientY });
            }}
            onPointerDown={() => contextMenu && setContextMenu(null)}
          />

          {(status === "empty" || status === "emptyFolder") && (
            <div className="empty-state">
              <img src={logoSmall} srcSet={`${logoSmall} 1x, ${logo} 1.5x`} alt="" className="empty-logo" draggable={false} />
              <h1>{t("empty.title")}</h1>
              <p>{status === "emptyFolder" ? t("empty.folder") : t("empty.hint")}</p>
              <div className="empty-actions">
                <button className="btn btn-primary" onClick={pickFile}>
                  <ImagePlus size={16} /> {t("empty.open")}
                </button>
                <button className="btn btn-default" onClick={pickFolder}>
                  <FolderOpen size={16} /> {t("empty.openFolder")}
                </button>
              </div>
            </div>
          )}

          {status === "error" && error && path && (
            <div className="error-state">
              <ImageOff size={40} strokeWidth={1.4} />
              <h2>{t("error.title")}</h2>
              <p>{t(`error.${error.code}` as Key)}</p>
              <p className="error-file">{fileName(path)}</p>
            </div>
          )}

          {loading && (
            <div className="loading-indicator" aria-label={t("loading")}>
              <Loader2 size={22} className="spin" />
            </div>
          )}

          {hasImage && turns !== 0 && (
            <div className="pending-bar no-pan">
              <RotateCw size={15} />
              {support === "unsupported" ? (
                <span>{t("pending.readonly")}</span>
              ) : (
                <>
                  <span>{t("pending.label")}</span>
                  {support === "lossless" && <span className="pending-tag">{t("pending.lossless")}</span>}
                  <button className="btn btn-primary btn-sm" onClick={() => save(false)}>
                    {t("pending.save")}
                  </button>
                </>
              )}
              <button className="btn btn-ghost btn-sm" onClick={discardRotation}>
                {t("pending.discard")}
              </button>
            </div>
          )}

          {toast && (
            <div className="toast" key={toast.id} role="status">
              {toast.text}
            </div>
          )}

          {dropping && <div className="drop-overlay" />}

          {contextMenu && (
            <div
              className="menu-popup context-menu"
              style={{ left: contextMenu.x, top: contextMenu.y }}
              ref={(el) => {
                // Keep the menu inside the window: flip it left/up when it would overflow.
                if (!el) return;
                // offsetWidth/Height ignore the pop-in scale animation.
                const r = { width: el.offsetWidth, height: el.offsetHeight };
                const pad = 6;
                let x = contextMenu.x;
                let y = contextMenu.y;
                if (x + r.width > window.innerWidth - pad) x = Math.max(pad, x - r.width);
                if (y + r.height > window.innerHeight - pad) y = Math.max(pad, window.innerHeight - pad - r.height);
                el.style.left = `${x}px`;
                el.style.top = `${y}px`;
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              {contextItems.map((item, i) =>
                item.type === "separator" ? (
                  <div key={i} className="menu-sep" />
                ) : item.type === "label" ? null : (
                  <button
                    key={i}
                    className="menu-item"
                    onClick={() => {
                      setContextMenu(null);
                      item.onSelect();
                    }}
                  >
                    <span className="menu-check" />
                    <span className="menu-text">{item.label}</span>
                    {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
                  </button>
                ),
              )}
            </div>
          )}
        </main>

        <Toolbar
          hasImage={hasImage}
          scale={zoom.scale}
          isFit={zoom.fit}
          minScale={engineRef.current?.getMinScale() ?? 0.02}
          canPrev={canPrev}
          canNext={canNext}
          slideshowActive={slideshow.active}
          playing={slideshow.active && slideshow.playing}
          hidden={toolbarHidden}
          onZoomStep={(d) => engine()?.zoomStep(d)}
          onZoomTo={(s) => engine()?.zoomTo(s, undefined, false)}
          onFitToggle={toggleFitActual}
          onPrev={() => go(-1)}
          onNext={() => go(1)}
          onPlay={togglePlay}
          onRotate={rotate}
          onDelete={requestDelete}
          onEdit={() => openEditor()}
        />

        {editing && path && (
          <Editor
            key={path}
            path={path}
            url={urlsFor(path).url}
            fallbackUrl={urlsFor(path).fallbackUrl}
            turns={pending[path] ?? 0}
            canReplace={support !== "unsupported" && WRITABLE_EXTENSIONS.has(extension(path))}
            onClose={() => setEditing(false)}
            onError={(e) =>
              showToast(t("toast.saveFailed", { reason: typeof e === "string" ? e : t(`error.${toAppError(e).code}` as Key) }))
            }
            onSaved={({ path: saved, replaced }) => {
              setEditing(false);
              if (replaced) {
                setPending((old) => {
                  const { [saved]: _, ...rest } = old;
                  return rest;
                });
                pendingRef.current = { ...pendingRef.current, [saved]: 0 };
                setVersions((v) => ({ ...v, [saved]: (v[saved] ?? 0) + 1 }));
                showToast(t("toast.editReplaced"));
              } else {
                void openPath(saved);
                showToast(t("toast.editCopySaved", { name: fileName(saved) }));
              }
            }}
          />
        )}

        {dialog?.kind === "info" && path && <InfoDialog path={path} displayed={natural} onClose={closeDialog} onToast={showToast} />}
        {dialog?.kind === "settings" && (
          <SettingsDialog settings={settings} onChange={updateSettings} onClose={closeDialog} updater={updater} onOpenUpdate={() => setDialog({ kind: "update" })} />
        )}
        {dialog?.kind === "update" && <UpdateDialog updater={updater} onClose={closeDialog} />}
        {dialog?.kind === "shortcuts" && <ShortcutsDialog onClose={closeDialog} />}
        {dialog?.kind === "about" && <AboutDialog extensions={extensions} onClose={closeDialog} />}
        {dialog?.kind === "print" && (
          <PrintDialog
            src={dialog.src}
            image={dialog.size}
            dpi={dialog.dpi}
            onClose={() => {
              if (dialog.blob) setTimeout(() => URL.revokeObjectURL(dialog.src), 60_000);
              closeDialog();
            }}
            onPrint={(opts: PrintOptions) => {
              closeDialog();
              printImage(dialog.src, opts, dialog.size, dialog.dpi);
            }}
          />
        )}
        {dialog?.kind === "delete" && (
          <ConfirmDialog
            title={t("delete.title")}
            onClose={closeDialog}
            actions={[
              { label: t("common.cancel"), onClick: closeDialog },
              {
                label: t("delete.confirm"),
                kind: "danger",
                autoFocus: true,
                onClick: () => {
                  closeDialog();
                  doDelete(dialog.path);
                },
              },
            ]}
          >
            <div className="confirm-delete">
              {dialog.path === path && engineRef.current?.currentImage() && (
                <img src={engineRef.current.currentImage()!.src} alt="" style={{ transform: `rotate(${turns * 90}deg)` }} />
              )}
              <p>{t("delete.body", { name: fileName(dialog.path) })}</p>
            </div>
          </ConfirmDialog>
        )}
        {dialog?.kind === "deletePermanent" && (
          <ConfirmDialog
            title={t("delete.permanentTitle")}
            onClose={closeDialog}
            actions={[
              { label: t("common.cancel"), onClick: closeDialog, autoFocus: true },
              {
                label: t("delete.permanentConfirm"),
                kind: "danger",
                onClick: async () => {
                  closeDialog();
                  try {
                    await api.deletePermanently(dialog.path);
                    removeFromList(dialog.path);
                    showToast(t("toast.deletedPermanently", { name: fileName(dialog.path) }));
                  } catch (e) {
                    showToast(t("toast.deleteFailed", { reason: t(`error.${toAppError(e).code}` as Key) }));
                  }
                },
              },
            ]}
          >
            <p>{t("delete.permanentBody", { name: fileName(dialog.path), reason: dialog.reason })}</p>
          </ConfirmDialog>
        )}
        {dialog?.kind === "saveConfirm" && (
          <ConfirmDialog
            title={t("save.title")}
            onClose={closeDialog}
            actions={[
              { label: t("common.cancel"), onClick: closeDialog },
              {
                label: t("save.saveAs"),
                onClick: () => {
                  closeDialog();
                  save(true);
                },
              },
              {
                label: t("save.replace"),
                kind: "primary",
                autoFocus: true,
                onClick: () => {
                  reencodeConfirmed.current = true;
                  closeDialog();
                  doSave(dialog.path, dialog.turns);
                },
              },
            ]}
          >
            <p>{t("save.body", { name: fileName(dialog.path) })}</p>
          </ConfirmDialog>
        )}
        {dialog?.kind === "quit" && (
          <ConfirmDialog
            title={t("quit.title")}
            onClose={closeDialog}
            actions={[
              { label: t("common.cancel"), onClick: closeDialog },
              { label: t("quit.discard"), kind: "danger", onClick: () => getCurrentWindow().destroy() },
              { label: t("quit.saveAll"), kind: "primary", autoFocus: true, onClick: saveAllAndQuit },
            ]}
          >
            <p>{t("quit.body", { count: dialog.count })}</p>
          </ConfirmDialog>
        )}
      </div>
    </I18nContext.Provider>
  );
}
