import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  Brush,
  Check,
  ChevronDown,
  Circle,
  Copy,
  Crop,
  Download,
  Eraser,
  FlipHorizontal2,
  FlipVertical2,
  Highlighter,
  LoaderCircle,
  Minus,
  MousePointer2,
  MoveUpRight,
  Redo2,
  Replace,
  RotateCcw,
  RotateCw,
  SlidersHorizontal,
  Sparkles,
  Square,
  Type,
  Trash2,
  Undo2,
  WandSparkles,
  X,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ConfirmDialog } from "../components/Modal";
import { api, toAppError, type AppError, type BgModelStatus } from "../lib/api";
import { useI18n, type Key } from "../lib/i18n";
import { dirName, extension, fileName, joinPath } from "../lib/nav";
import {
  ALPHA_EXTENSIONS,
  annotationBounds,
  applyAdjust,
  applyMask,
  cropRect,
  DEFAULT_THRESHOLD,
  MASK_SIDE,
  thresholdMask,
  dragCrop,
  drawAnnotation,
  drawOriented,
  FILTERS,
  fitAspect,
  flipState,
  hitAnnotation,
  initialState,
  isNeutral,
  isPristine,
  keepInFrame,
  NEUTRAL,
  orientedSize,
  pickAnnotation,
  renderFull,
  rotateState,
  roughMeasure,
  snapMove,
  TEXT_FONT,
  TEXT_LINE_HEIGHT,
  textLayout,
  translateAnnotation,
  type Adjust,
  type Annotation,
  type EditState,
  type FilterId,
  type Handle,
  type Measure,
  type Pt,
  type Rect,
  type Size,
} from "./model";

type Tool = "crop" | "adjust" | "filters" | "draw" | "text" | "background";
type DrawMode = "select" | "pen" | "marker" | "line" | "arrow" | "rect" | "ellipse" | "eraser";

/** Formats the editor can write back; anything else is saved as a copy (PNG by default). */
export const WRITABLE_EXTENSIONS = new Set(["jpg", "jpeg", "jpe", "jfif", "png", "webp", "bmp", "tif", "tiff", "gif", "tga", "qoi"]);

const COLORS = ["#ffffff", "#111111", "#ef4444", "#f59e0b", "#facc15", "#22c55e", "#1f74d6", "#a855f7"];

const RATIOS: { id: string; label: Key | string; value: number | "original" | null }[] = [
  { id: "free", label: "ed.free", value: null },
  { id: "original", label: "ed.original", value: "original" },
  { id: "1:1", label: "ed.square", value: 1 },
  { id: "4:3", label: "4:3", value: 4 / 3 },
  { id: "3:2", label: "3:2", value: 3 / 2 },
  { id: "16:9", label: "16:9", value: 16 / 9 },
  { id: "3:4", label: "3:4", value: 3 / 4 },
  { id: "9:16", label: "9:16", value: 9 / 16 },
];

const ADJUSTMENTS: { key: keyof Adjust; label: Key; min: number }[] = [
  { key: "brightness", label: "ed.brightness", min: -100 },
  { key: "contrast", label: "ed.contrast", min: -100 },
  { key: "saturation", label: "ed.saturation", min: -100 },
  { key: "warmth", label: "ed.warmth", min: -100 },
  { key: "vignette", label: "ed.vignette", min: 0 },
];

const FILTER_LABELS: Record<FilterId, Key> = {
  none: "flt.none",
  bw: "flt.bw",
  sepia: "flt.sepia",
  vintage: "flt.vintage",
  cool: "flt.cool",
  warm: "flt.warm",
  vivid: "flt.vivid",
  drama: "flt.drama",
};

const HANDLES: Exclude<Handle, "move">[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

interface History {
  past: EditState[];
  present: EditState;
  future: EditState[];
}

export interface EditorProps {
  path: string;
  url: string;
  fallbackUrl?: string;
  /** Pending (unsaved) viewer rotation, folded into the edit. */
  turns: number;
  /** False for formats that can't be rewritten (RAW, HEIC, SVG, animations…). */
  canReplace: boolean;
  onClose: () => void;
  onSaved: (result: { path: string; replaced: boolean }) => void;
  onError: (error: AppError | string) => void;
}

type TextAnnotation = Annotation & { kind: "text" };

/** Text being typed: a new one, or an existing one (`index`) being changed in place. */
interface TextEdit {
  at: Pt;
  value: string;
  index?: number;
  /** Style of the existing text being changed (picture pixels for the size). */
  color?: string;
  size?: number;
  outline?: number;
}

/** Text is measured with the real font on a small offscreen canvas. */
let measureCtx: CanvasRenderingContext2D | null = null;
const measureText: Measure = (a) => {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  return measureCtx ? textLayout(measureCtx, a) : roughMeasure(a);
};

const clampInt = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));
const isMarker = (a: Annotation) => a.kind === "pen" && a.opacity < 1;
/** Pixels on screen within which the pointer grabs a line, and guides attract. */
const GRAB = 6;
const SNAP = 8;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => img.decode().then(() => resolve(img), () => resolve(img));
    img.onerror = () => reject(new Error("load"));
    img.src = url;
  });
}

export function Editor({ path, url, fallbackUrl, turns: startTurns, canReplace, onClose, onSaved, onError }: EditorProps) {
  const { t } = useI18n();
  const [source, setSource] = useState<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [hist, setHist] = useState<History>(() => ({ past: [], present: initialState(startTurns), future: [] }));
  const state = hist.present;
  const [tool, setTool] = useState<Tool>("crop");
  const [drawMode, setDrawMode] = useState<DrawMode>("pen");
  const [color, setColor] = useState("#ef4444");
  const [brush, setBrush] = useState(6);
  const [textSize, setTextSize] = useState(36);
  const [textOutline, setTextOutline] = useState(false);
  const [outlineOpacity, setOutlineOpacity] = useState(70);
  const [ratioId, setRatioId] = useState("free");
  const [cropDraft, setCropDraft] = useState<Rect | null>(null);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [textEdit, setTextEdit] = useState<TextEdit | null>(null);
  // The annotation picked to be moved or restyled (index in the current state).
  const [selected, setSelected] = useState<number | null>(null);
  const [guides, setGuides] = useState<{ x: number[]; y: number[] } | null>(null);
  const [hoverMovable, setHoverMovable] = useState(false);
  const [saveMenu, setSaveMenu] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<null | "replace" | "discard">(null);
  const [stageSize, setStageSize] = useState<Size>({ w: 0, h: 0 });
  // Background removal: model status, download progress, and the subject mask computed
  // once per picture (kept outside the history so undo/redo just toggle its use).
  const [bgStatus, setBgStatus] = useState<BgModelStatus | null>(null);
  const [bgDownload, setBgDownload] = useState<{ received: number; total: number } | null>(null);
  const [bgBusy, setBgBusy] = useState(false);
  const [bgError, setBgError] = useState<string | null>(null);
  const [mask, setMask] = useState<Uint8Array | null>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const liveSnapshot = useRef<EditState | null>(null);
  const drag = useRef<
    | null
    | { kind: "crop"; handle: Handle; start: Rect; origin: Pt }
    | { kind: "draw" }
    | { kind: "erase" }
    | { kind: "move"; index: number; start: Annotation; origin: Pt; box: Rect; moved: boolean }
  >(null);
  const baseCache = useRef<{ key: string; canvas: HTMLCanvasElement } | null>(null);
  const rawCache = useRef<{ key: string; data: ImageData } | null>(null);

  // ---------------------------------------------------------------- source
  useEffect(() => {
    let alive = true;
    loadImage(url)
      .catch(() => (fallbackUrl ? loadImage(fallbackUrl) : Promise.reject(new Error("load"))))
      .then((img) => alive && setSource(img))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [url, fallbackUrl]);

  const srcSize: Size = useMemo(() => (source ? { w: source.naturalWidth, h: source.naturalHeight } : { w: 1, h: 1 }), [source]);
  const oriented = orientedSize(srcSize, state.turns);

  // ---------------------------------------------------------------- history
  const commit = useCallback((next: EditState | ((s: EditState) => EditState)) => {
    setHist((h) => {
      const value = typeof next === "function" ? next(h.present) : next;
      if (value === h.present) return h;
      return { past: [...h.past.slice(-99), h.present], present: value, future: [] };
    });
  }, []);

  /** Live changes (slider drags): no history entry until the gesture ends. */
  const live = useCallback((next: (s: EditState) => EditState) => {
    setHist((h) => {
      if (!liveSnapshot.current) liveSnapshot.current = h.present;
      return { ...h, present: next(h.present) };
    });
  }, []);
  const endLive = useCallback(() => {
    const before = liveSnapshot.current;
    liveSnapshot.current = null;
    if (!before) return;
    setHist((h) => (h.present === before ? h : { past: [...h.past.slice(-99), before], present: h.present, future: [] }));
  }, []);

  const undo = useCallback(() => {
    setSelected(null);
    setHist((h) => (h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] } : h));
  }, []);
  const redo = useCallback(() => {
    setSelected(null);
    setHist((h) => (h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) } : h));
  }, []);

  const dirty = !isPristine(state, startTurns);

  // ---------------------------------------------------------------- view geometry
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStageSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setStageSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const crop = cropDraft ?? cropRect(state, srcSize);
  // While cropping the whole picture is shown; otherwise only the kept part.
  const region: Rect = tool === "crop" ? { x: 0, y: 0, w: oriented.w, h: oriented.h } : cropRect(state, srcSize);
  const pad = 28;
  const scale =
    stageSize.w > 0 && source ? Math.min((stageSize.w - pad * 2) / region.w, (stageSize.h - pad * 2) / region.h, 4) : 0;
  const view = { w: Math.max(1, Math.round(region.w * scale)), h: Math.max(1, Math.round(region.h * scale)) };

  const toImage = useCallback(
    (e: { clientX: number; clientY: number }): Pt => {
      const r = canvasRef.current!.getBoundingClientRect();
      return [region.x + (e.clientX - r.left) / scale, region.y + (e.clientY - r.top) / scale];
    },
    [region.x, region.y, scale],
  );

  // ---------------------------------------------------------------- background removal
  const threshold = state.bg?.threshold ?? null;
  const maskCanvas = useMemo(() => {
    if (!mask || threshold === null) return null;
    const c = document.createElement("canvas");
    c.width = MASK_SIDE;
    c.height = MASK_SIDE;
    c.getContext("2d")!.putImageData(new ImageData(thresholdMask(mask, threshold), MASK_SIDE, MASK_SIDE), 0, 0);
    return c;
  }, [mask, threshold]);

  useEffect(() => {
    api.bgModelStatus().then(setBgStatus, () => undefined);
  }, []);

  const downloading = bgDownload !== null;
  useEffect(() => {
    // Leaving the editor stops a download in progress.
    if (!downloading) return;
    return () => void api.bgModelCancel();
  }, [downloading]);

  const describe = (e: unknown) => t(`error.${toAppError(e).code}` as Key);

  const downloadModel = async () => {
    setBgError(null);
    setBgDownload({ received: 0, total: bgStatus?.size ?? 0 });
    try {
      await api.bgModelDownload((received, total) => setBgDownload({ received, total }));
      setBgStatus(await api.bgModelStatus());
    } catch (e) {
      if (toAppError(e).code !== "cancelled") setBgError(describe(e));
    } finally {
      setBgDownload(null);
    }
  };

  const deleteModel = async () => {
    setBgError(null);
    try {
      await api.bgModelDelete();
      setBgStatus(await api.bgModelStatus());
    } catch (e) {
      setBgError(describe(e));
    }
  };

  const removeBackground = async () => {
    if (!source) return;
    setBgError(null);
    setBgBusy(true);
    try {
      let m = mask;
      if (!m) {
        // Let the spinner paint before the model runs.
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
        const c = document.createElement("canvas");
        c.width = MASK_SIDE;
        c.height = MASK_SIDE;
        const cx = c.getContext("2d", { willReadFrequently: true })!;
        cx.imageSmoothingQuality = "high";
        cx.drawImage(source, 0, 0, MASK_SIDE, MASK_SIDE);
        const rgba = cx.getImageData(0, 0, MASK_SIDE, MASK_SIDE).data;
        m = await api.bgMask(new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength));
        setMask(m);
      }
      commit((s) => ({ ...s, bg: { threshold: DEFAULT_THRESHOLD } }));
    } catch (e) {
      setBgError(describe(e));
    } finally {
      setBgBusy(false);
    }
  };

  // ---------------------------------------------------------------- rendering
  const editingIndex = textEdit?.index ?? -1;
  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !source || scale <= 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const bw = Math.max(1, Math.round(view.w * dpr));
    const bh = Math.max(1, Math.round(view.h * dpr));
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    const k = scale * dpr;
    const geoKey = [state.turns, state.flipH, state.flipV, region.x, region.y, region.w, region.h, bw, bh, maskCanvas ? threshold : "-"].join(",");
    // Raw oriented pixels at view resolution, reused while only adjustments change.
    if (rawCache.current?.key !== geoKey) {
      const c = document.createElement("canvas");
      c.width = bw;
      c.height = bh;
      const cx = c.getContext("2d", { willReadFrequently: true })!;
      drawOriented(cx, source, srcSize, state, region, k);
      if (maskCanvas) applyMask(cx, maskCanvas, srcSize, state, region, k);
      rawCache.current = { key: geoKey, data: cx.getImageData(0, 0, bw, bh) };
      baseCache.current = null;
    }
    const adjKey = geoKey + "|" + JSON.stringify(state.adjust) + "|" + (tool === "crop" ? JSON.stringify(crop) : "");
    if (baseCache.current?.key !== adjKey) {
      const raw = rawCache.current!.data;
      const img = new ImageData(new Uint8ClampedArray(raw.data), bw, bh);
      if (!isNeutral(state.adjust)) {
        // The vignette is centred on the kept area, as in the saved file.
        const kept = cropRect(state, srcSize);
        const area = { x: (region.x - kept.x) * k, y: (region.y - kept.y) * k, w: kept.w * k, h: kept.h * k };
        applyAdjust(img.data, bw, bh, state.adjust, area);
      }
      const c = baseCache.current?.canvas ?? document.createElement("canvas");
      c.width = bw;
      c.height = bh;
      c.getContext("2d")!.putImageData(img, 0, 0);
      baseCache.current = { key: adjKey, canvas: c };
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, bw, bh);
    ctx.drawImage(baseCache.current.canvas, 0, 0);
    ctx.save();
    ctx.scale(k, k);
    ctx.translate(-region.x, -region.y);
    state.annotations.forEach((a, i) => i !== editingIndex && drawAnnotation(ctx, a));
    if (draft) drawAnnotation(ctx, draft);
    ctx.restore();
  }, [source, srcSize, state, region.x, region.y, region.w, region.h, scale, view.w, view.h, draft, tool, crop, maskCanvas, threshold, editingIndex]);

  useEffect(() => {
    const id = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(id);
  }, [paint]);

  // ---------------------------------------------------------------- crop
  const ratioValue = useCallback(
    (id: string): number | null => {
      const r = RATIOS.find((x) => x.id === id)?.value ?? null;
      return r === "original" ? oriented.w / oriented.h : r;
    },
    [oriented.w, oriented.h],
  );

  const chooseRatio = (id: string) => {
    setRatioId(id);
    const r = ratioValue(id);
    if (r) commit((s) => ({ ...s, crop: fitAspect(cropRect(s, srcSize), r) }));
  };

  const onCropDown = (handle: Handle) => (e: ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { kind: "crop", handle, start: crop, origin: toImage(e) };
  };
  const onCropMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (d?.kind !== "crop") return;
    const p = toImage(e);
    setCropDraft(dragCrop(d.start, d.handle, p[0] - d.origin[0], p[1] - d.origin[1], oriented, ratioValue(ratioId), 16 / Math.max(scale, 0.01)));
  };
  const onCropUp = () => {
    if (drag.current?.kind !== "crop") return;
    drag.current = null;
    if (cropDraft) {
      const full = cropDraft.x <= 0.5 && cropDraft.y <= 0.5 && cropDraft.w >= oriented.w - 0.5 && cropDraft.h >= oriented.h - 0.5;
      commit((s) => ({ ...s, crop: full ? null : cropDraft }));
    }
    setCropDraft(null);
  };

  // ---------------------------------------------------------------- drawing
  const eraseAt = useCallback(
    (p: Pt) => {
      const r = 10 / scale;
      setHist((h) => {
        const kept = h.present.annotations.filter((a) => !hitAnnotation(a, p, r, measureText));
        if (kept.length === h.present.annotations.length) return h;
        if (!liveSnapshot.current) liveSnapshot.current = h.present;
        return { ...h, present: { ...h.present, annotations: kept } };
      });
    },
    [scale],
  );

  // ---------------------------------------------------------------- selecting & moving
  const sel = selected !== null && selected < state.annotations.length ? selected : null;
  const selAnn = sel !== null ? state.annotations[sel] : null;
  const selecting = tool === "draw" && drawMode === "select";
  // The text tool grabs texts; the selection mode of the drawing tool grabs anything.
  const movable = tool === "text" ? (a: Annotation) => a.kind === "text" : selecting ? () => true : null;
  const pickAt = (p: Pt) => (movable ? pickAnnotation(state.annotations, p, GRAB / scale, measureText, movable) : -1);

  useEffect(() => {
    setSelected(null);
    setHoverMovable(false);
  }, [tool, drawMode]);

  /** Selects an annotation and shows its style in the panel. */
  const select = (i: number) => {
    const a = state.annotations[i];
    setSelected(i);
    setColor(a.color);
    if (a.kind === "text") {
      setTextSize(clampInt(a.size * scale, 12, 120));
      setTextOutline(!!a.outline);
      if (a.outline) setOutlineOpacity(clampInt(a.outline * 100, 5, 100));
    } else {
      setBrush(clampInt((isMarker(a) ? a.size / 3 : a.size) * scale, 1, 40));
    }
  };

  /** Changes the selected annotation; `gesture` keeps a slider drag as one undo step. */
  const restyle = (f: (a: Annotation) => Annotation, gesture = false) => {
    if (sel === null) return;
    const update = (s: EditState) => ({ ...s, annotations: s.annotations.map((a, i) => (i === sel ? f(a) : a)) });
    if (gesture) live(update);
    else commit(update);
  };

  const pickColor = (c: string) => {
    setColor(c);
    if (textEdit?.index !== undefined) setTextEdit((te) => (te ? { ...te, color: c } : te));
    else restyle((a) => ({ ...a, color: c }));
  };

  const onStageDown = (e: ReactPointerEvent) => {
    if (!source || e.button !== 0) return;
    const p = toImage(e);
    if (movable) {
      e.preventDefault();
      if (tool === "text") commitText();
      const hit = pickAt(p);
      if (hit >= 0) {
        // Grab it: it follows the pointer from the exact point where it was taken.
        select(hit);
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        const a = state.annotations[hit];
        drag.current = { kind: "move", index: hit, start: a, origin: p, box: annotationBounds(a, measureText), moved: false };
        return;
      }
      // A click beside the selection only drops it; otherwise the text tool starts a new text.
      if (sel !== null || tool !== "text") {
        setSelected(null);
        return;
      }
      setTextEdit({ at: p, value: "" });
      return;
    }
    if (tool !== "draw") return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const size = brush / scale;
    if (drawMode === "eraser") {
      drag.current = { kind: "erase" };
      eraseAt(p);
    } else if (drawMode === "pen" || drawMode === "marker") {
      drag.current = { kind: "draw" };
      const marker = drawMode === "marker";
      setDraft({ kind: "pen", points: [p], color, size: marker ? size * 3 : size, opacity: marker ? 0.38 : 1 });
    } else if (drawMode !== "select") {
      drag.current = { kind: "draw" };
      setDraft({ kind: drawMode, a: p, b: p, color, size });
    }
  };

  const moveSelection = (d: { index: number; start: Annotation; origin: Pt; box: Rect; moved: boolean }, e: ReactPointerEvent) => {
    const p = toImage(e);
    let dx = p[0] - d.origin[0];
    let dy = p[1] - d.origin[1];
    // A small dead zone, so that clicking to select never nudges anything.
    if (!d.moved && Math.hypot(dx, dy) * scale < 3) return;
    d.moved = true;
    // Shift: along one axis only.
    const lock = e.shiftKey ? (Math.abs(dx) >= Math.abs(dy) ? "y" : "x") : null;
    if (lock === "x") dx = 0;
    if (lock === "y") dy = 0;
    let g: { x: number[]; y: number[] } = { x: [], y: [] };
    // Edges and centre snap to the picture's; Alt moves freely.
    if (!e.altKey) {
      const snap = snapMove(d.box, dx, dy, region, SNAP / scale);
      if (lock !== "x") {
        dx = snap.dx;
        g.x = snap.guides.x;
      }
      if (lock !== "y") {
        dy = snap.dy;
        g.y = snap.guides.y;
      }
    }
    const [kx, ky] = keepInFrame(d.box, dx, dy, region, 16 / scale);
    if (kx !== dx) g = { ...g, x: [] };
    if (ky !== dy) g = { ...g, y: [] };
    setGuides(g.x.length || g.y.length ? g : null);
    live((s) => ({ ...s, annotations: s.annotations.map((a, i) => (i === d.index ? translateAnnotation(d.start, kx, ky) : a)) }));
  };

  const onStageMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) {
      if (movable && source && scale > 0 && canvasRef.current) {
        const over = pickAt(toImage(e)) >= 0;
        if (over !== hoverMovable) setHoverMovable(over);
      }
      return;
    }
    if (d.kind === "crop") return onCropMove(e);
    if (d.kind === "move") return moveSelection(d, e);
    const p = toImage(e);
    if (d.kind === "erase") return eraseAt(p);
    setDraft((a) => {
      if (!a) return a;
      if (a.kind === "pen") {
        const last = a.points[a.points.length - 1];
        // Skip sub-pixel jitter: fewer points, smoother curves.
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) * scale < 1.5) return a;
        return { ...a, points: [...a.points, p] };
      }
      if (a.kind === "text") return a;
      let b = p;
      if (e.shiftKey) {
        // Shift: straight lines at 45° steps, squares and circles.
        const dx = p[0] - a.a[0];
        const dy = p[1] - a.a[1];
        if (a.kind === "rect" || a.kind === "ellipse") {
          const m = Math.max(Math.abs(dx), Math.abs(dy));
          b = [a.a[0] + Math.sign(dx || 1) * m, a.a[1] + Math.sign(dy || 1) * m];
        } else {
          const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
          const len = Math.hypot(dx, dy);
          b = [a.a[0] + Math.cos(ang) * len, a.a[1] + Math.sin(ang) * len];
        }
      }
      return { ...a, b };
    });
  };

  const onStageUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === "crop") return onCropUp();
    if (d.kind === "erase") {
      setSelected(null);
      return endLive();
    }
    if (d.kind === "move") {
      setGuides(null);
      if (d.moved) endLive();
      return;
    }
    const a = draftRef.current;
    setDraft(null);
    if (a) {
      const tiny = a.kind !== "pen" && a.kind !== "text" && Math.hypot(a.b[0] - a.a[0], a.b[1] - a.a[1]) * scale < 3;
      if (!tiny) commit((s) => ({ ...s, annotations: [...s.annotations, a] }));
    }
  };

  /** Double-click on a text: change its words in place. */
  const onStageDoubleClick = (e: ReactPointerEvent | React.MouseEvent) => {
    if (!movable || !source) return;
    const i = pickAnnotation(state.annotations, toImage(e), GRAB / scale, measureText, (a) => a.kind === "text");
    if (i < 0) return;
    const a = state.annotations[i] as TextAnnotation;
    if (tool !== "text") setTool("text");
    setSelected(null);
    setTextEdit({ at: a.at, value: a.text, index: i, color: a.color, size: a.size, outline: a.outline });
  };

  // ---------------------------------------------------------------- text
  const textRef = useRef(textEdit);
  textRef.current = textEdit;
  const commitText = useCallback(() => {
    const te = textRef.current;
    textRef.current = null;
    if (!te) return;
    setTextEdit(null);
    const index = te.index;
    if (index !== undefined) {
      // An existing text: same place in the stack, emptied = removed.
      commit((s) => {
        const old = s.annotations[index];
        if (old?.kind !== "text") return s;
        if (!te.value.trim()) return { ...s, annotations: s.annotations.filter((_, i) => i !== index) };
        const next: TextAnnotation = { ...old, text: te.value, color: te.color ?? old.color, size: te.size ?? old.size, outline: te.outline ?? old.outline };
        if (JSON.stringify(next) === JSON.stringify(old)) return s;
        return { ...s, annotations: s.annotations.map((a, i) => (i === index ? next : a)) };
      });
      return;
    }
    if (te.value.trim()) {
      const size = textSize / Math.max(scale, 0.0001);
      const outline = textOutline ? outlineOpacity / 100 : 0;
      commit((s) => ({ ...s, annotations: [...s.annotations, { kind: "text", at: te.at, text: te.value, color, size, outline }] }));
    }
  }, [commit, color, textSize, scale, textOutline, outlineOpacity]);

  useEffect(() => {
    if (tool !== "text") commitText();
  }, [tool, commitText]);

  // ---------------------------------------------------------------- saving
  const render = async (): Promise<Uint8Array> => {
    const canvas = renderFull(source!, srcSize, state, maskCanvas);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("encode");
    return new Uint8Array(await blob.arrayBuffer());
  };

  const doSave = async (dest: string, mode: "copy" | "replace") => {
    setSaving(true);
    try {
      // Let the spinner paint before the heavy full-resolution render.
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
      const png = await render();
      const outcome = await api.saveEdit(png, dest, path, mode);
      onSaved({ path: outcome.path, replaced: outcome.trashed });
    } catch (e) {
      onError(e as AppError);
      setSaving(false);
    }
  };

  const saveCopy = async () => {
    setSaveMenu(false);
    const ext = extension(path);
    // A cut-out subject needs a format that keeps transparency.
    const outExt = WRITABLE_EXTENSIONS.has(ext) && (!state.bg || ALPHA_EXTENSIONS.has(ext)) ? ext : "png";
    const stem = fileName(path).replace(/\.[^.]+$/, "");
    const chosen = await saveDialog({
      defaultPath: joinPath(dirName(path), `${stem}-edit.${outExt}`),
      filters: [
        { name: "JPEG", extensions: ["jpg", "jpeg"] },
        { name: "PNG", extensions: ["png"] },
        { name: "WebP", extensions: ["webp"] },
        { name: "BMP", extensions: ["bmp"] },
        { name: "TIFF", extensions: ["tif", "tiff"] },
      ].sort((a, b) => Number(b.extensions.includes(outExt)) - Number(a.extensions.includes(outExt))),
    });
    if (!chosen) return;
    const dest = WRITABLE_EXTENSIONS.has(extension(chosen)) ? chosen : `${chosen}.png`;
    void doSave(dest, "copy");
  };

  // ---------------------------------------------------------------- keyboard
  const requestClose = useCallback(() => {
    if (saving) return;
    if (dirty) setConfirm("discard");
    else onClose();
  }, [dirty, onClose, saving]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (confirm || saving) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest(".editor-text-input")) return;
      const mod = e.ctrlKey || e.metaKey;
      const typing = !!target?.closest("input, textarea, select");
      if (sel !== null && !mod && !typing) {
        const step = (e.shiftKey ? 10 : 1) / Math.max(scale, 0.0001);
        const arrows: Record<string, Pt> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
        if (arrows[e.key]) {
          // Arrows: move by one screen pixel (Shift: ten); a held key is one undo step.
          e.preventDefault();
          const [dx, dy] = arrows[e.key];
          live((s) => ({ ...s, annotations: s.annotations.map((a, i) => (i === sel ? translateAnnotation(a, dx, dy) : a)) }));
          return;
        }
        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          setSelected(null);
          commit((s) => ({ ...s, annotations: s.annotations.filter((_, i) => i !== sel) }));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSelected(null);
          return;
        }
      }
      if (mod && e.code === "KeyZ" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (mod && (e.code === "KeyY" || (e.code === "KeyZ" && e.shiftKey))) {
        e.preventDefault();
        redo();
      } else if (mod && e.code === "KeyS") {
        e.preventDefault();
        setSaveMenu(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        if (saveMenu) setSaveMenu(false);
        else requestClose();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key.startsWith("Arrow")) endLive();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [confirm, saving, saveMenu, undo, redo, requestClose, sel, scale, live, endLive, commit]);

  // ---------------------------------------------------------------- UI pieces
  const adjust = state.adjust;
  const activeFilter = (Object.keys(FILTERS) as FilterId[]).find((id) => JSON.stringify(FILTERS[id]) === JSON.stringify(adjust));

  const tools: { id: Tool; icon: typeof Crop; label: Key }[] = [
    { id: "crop", icon: Crop, label: "ed.crop" },
    { id: "adjust", icon: SlidersHorizontal, label: "ed.adjust" },
    { id: "filters", icon: Sparkles, label: "ed.filters" },
    { id: "draw", icon: Brush, label: "ed.draw" },
    { id: "text", icon: Type, label: "ed.text" },
    { id: "background", icon: WandSparkles, label: "ed.background" },
  ];

  const drawModes: { id: DrawMode; icon: typeof Crop; label: Key }[] = [
    { id: "select", icon: MousePointer2, label: "ed.select" },
    { id: "pen", icon: Brush, label: "ed.pen" },
    { id: "marker", icon: Highlighter, label: "ed.marker" },
    { id: "line", icon: Minus, label: "ed.line" },
    { id: "arrow", icon: MoveUpRight, label: "ed.arrow" },
    { id: "rect", icon: Square, label: "ed.rect" },
    { id: "ellipse", icon: Circle, label: "ed.ellipse" },
    { id: "eraser", icon: Eraser, label: "ed.eraser" },
  ];

  const colorPicker = (
    <div className="ed-field">
      <span className="ed-label">{t("ed.color")}</span>
      <div className="ed-swatches">
        {COLORS.map((c) => (
          <button key={c} className={`ed-swatch${color === c ? " on" : ""}`} style={{ "--sw": c } as CSSProperties} onClick={() => pickColor(c)} aria-label={c} />
        ))}
        <label className={`ed-swatch ed-swatch-custom${COLORS.includes(color) ? "" : " on"}`} style={{ "--sw": color } as CSSProperties}>
          <input type="color" value={color} onChange={(e) => pickColor(e.target.value)} />
        </label>
      </div>
    </div>
  );

  const slider = (label: string, value: number, min: number, max: number, onInput: (v: number) => void, onReset?: () => void) => (
    <div className="ed-slider">
      <div className="ed-slider-head">
        <span>{label}</span>
        <button className="ed-value" onDoubleClick={onReset} data-tip={onReset ? "↺" : undefined}>
          {value > 0 && min < 0 ? `+${value}` : value}
        </button>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onInput(Number(e.target.value))}
        onPointerUp={endLive}
        onKeyUp={endLive}
        onBlur={endLive}
        onDoubleClick={onReset}
        style={{ "--fill": `${((value - min) / (max - min)) * 100}%`, "--zero": `${((0 - min) / (max - min)) * 100}%` } as CSSProperties}
      />
    </div>
  );

  let panel: ReactNode = null;
  if (tool === "crop") {
    panel = (
      <>
        <div className="ed-field">
          <span className="ed-label">{t("ed.ratio")}</span>
          <div className="ed-chips">
            {RATIOS.map((r) => (
              <button key={r.id} className={`ed-chip${ratioId === r.id ? " on" : ""}`} onClick={() => chooseRatio(r.id)}>
                {r.label.includes(".") ? t(r.label as Key) : r.label}
              </button>
            ))}
          </div>
        </div>
        <div className="ed-field">
          <div className="ed-row">
            <button className="ed-icon-btn" onClick={() => commit((s) => rotateState(s, srcSize, -1))} data-tip={t("tb.rotateLeft")} aria-label={t("tb.rotateLeft")}>
              <RotateCcw size={18} />
            </button>
            <button className="ed-icon-btn" onClick={() => commit((s) => rotateState(s, srcSize, 1))} data-tip={t("tb.rotateRight")} aria-label={t("tb.rotateRight")}>
              <RotateCw size={18} />
            </button>
            <button className="ed-icon-btn" onClick={() => commit((s) => flipState(s, srcSize, "h"))} data-tip={t("ed.flipH")} aria-label={t("ed.flipH")}>
              {/* lucide's names describe the mirror axis, not the motion: this one shows a left-right flip */}
              <FlipVertical2 size={18} />
            </button>
            <button className="ed-icon-btn" onClick={() => commit((s) => flipState(s, srcSize, "v"))} data-tip={t("ed.flipV")} aria-label={t("ed.flipV")}>
              <FlipHorizontal2 size={18} />
            </button>
          </div>
        </div>
        <button
          className="btn btn-default ed-wide"
          disabled={!state.crop}
          onClick={() => {
            setRatioId("free");
            commit((s) => ({ ...s, crop: null }));
          }}
        >
          {t("ed.clearCrop")}
        </button>
        <p className="ed-dim">{Math.round(crop.w)} × {Math.round(crop.h)} px</p>
      </>
    );
  } else if (tool === "adjust") {
    panel = (
      <>
        {ADJUSTMENTS.map((a) =>
          slider(
            t(a.label),
            adjust[a.key],
            a.min,
            100,
            (v) => live((s) => ({ ...s, adjust: { ...s.adjust, [a.key]: v } })),
            () => commit((s) => ({ ...s, adjust: { ...s.adjust, [a.key]: 0 } })),
          ),
        )}
        <button className="btn btn-default ed-wide" disabled={isNeutral(adjust)} onClick={() => commit((s) => ({ ...s, adjust: NEUTRAL }))}>
          {t("ed.resetAdjust")}
        </button>
      </>
    );
  } else if (tool === "filters") {
    panel = (
      <div className="ed-filters">
        {(Object.keys(FILTERS) as FilterId[]).map((id) => (
          <FilterThumb key={id} id={id} label={t(FILTER_LABELS[id])} source={source} srcSize={srcSize} state={state} on={activeFilter === id} onPick={() => commit((s) => ({ ...s, adjust: FILTERS[id] }))} />
        ))}
      </div>
    );
  } else if (tool === "draw") {
    panel = (
      <>
        <div className="ed-field">
          <div className="ed-tools-grid">
            {drawModes.map((m) => (
              <button key={m.id} className={`ed-icon-btn${drawMode === m.id ? " on" : ""}`} onClick={() => setDrawMode(m.id)} data-tip={t(m.label)} aria-label={t(m.label)} aria-pressed={drawMode === m.id}>
                <m.icon size={18} />
              </button>
            ))}
          </div>
        </div>
        {selecting && !selAnn && <p className="ed-hint">{t("ed.selectHint")}</p>}
        {drawMode !== "eraser" && (!selecting || selAnn) && colorPicker}
        {drawMode !== "eraser" &&
          (!selecting || (selAnn && selAnn.kind !== "text")) &&
          slider(t("ed.size"), brush, 1, 40, (v) => {
            setBrush(v);
            restyle((a) => (a.kind === "text" ? a : { ...a, size: (isMarker(a) ? v * 3 : v) / scale }), true);
          })}
        {selecting && selAnn && (
          <button className="btn btn-default ed-wide" onClick={() => {
            setSelected(null);
            commit((s) => ({ ...s, annotations: s.annotations.filter((_, i) => i !== sel) }));
          }}>
            <Trash2 size={15} />
            {t("ed.deleteSelected")}
          </button>
        )}
      </>
    );
  } else if (tool === "text") {
    panel = (
      <>
        <p className="ed-hint">{t("ed.textHint")}</p>
        {colorPicker}
        {slider(t("ed.textSize"), textSize, 12, 120, (v) => {
          setTextSize(v);
          if (textEdit?.index !== undefined) setTextEdit((te) => (te ? { ...te, size: v / scale } : te));
          else restyle((a) => (a.kind === "text" ? { ...a, size: v / scale } : a), true);
        })}
        <label className="toggle-row">
          <span>{t("ed.outline")}</span>
          <input
            type="checkbox"
            className="toggle"
            checked={textOutline}
            onChange={(e) => {
              const on = e.target.checked;
              setTextOutline(on);
              const outline = on ? outlineOpacity / 100 : 0;
              if (textEdit?.index !== undefined) setTextEdit((te) => (te ? { ...te, outline } : te));
              else restyle((a) => (a.kind === "text" ? { ...a, outline } : a));
            }}
          />
        </label>
        {textOutline &&
          slider(t("ed.outlineOpacity"), outlineOpacity, 5, 100, (v) => {
            setOutlineOpacity(v);
            if (textEdit?.index !== undefined) setTextEdit((te) => (te ? { ...te, outline: v / 100 } : te));
            else restyle((a) => (a.kind === "text" ? { ...a, outline: v / 100 } : a), true);
          })}
        {selAnn?.kind === "text" && (
          <button className="btn btn-default ed-wide" onClick={() => {
            setSelected(null);
            commit((s) => ({ ...s, annotations: s.annotations.filter((_, i) => i !== sel) }));
          }}>
            <Trash2 size={15} />
            {t("ed.deleteSelected")}
          </button>
        )}
      </>
    );
  }

  if (tool === "background") {
    const mb = (n: number) => t("bg.mb", { n: (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) });
    if (!bgStatus) {
      panel = <LoaderCircle className="spin ed-panel-spinner" size={22} />;
    } else if (!bgStatus.installed) {
      const pct = bgDownload && bgDownload.total ? (bgDownload.received / bgDownload.total) * 100 : 0;
      panel = (
        <>
          <p className="ed-hint">{t("bg.intro")}</p>
          <div className="bg-model">
            <strong>{t("bg.modelTitle")}</strong>
            <dl>
              <dt>{t("bg.model")}</dt>
              <dd>{bgStatus.name}</dd>
              {bgStatus.runtime && (
                <>
                  <dt>{t("bg.runtime")}</dt>
                  <dd>{bgStatus.runtime}</dd>
                </>
              )}
              <dt>{t("bg.size")}</dt>
              <dd>{mb(bgStatus.size)}</dd>
              <dt>{t("bg.license")}</dt>
              <dd>{bgStatus.license}</dd>
              <dt>{t("bg.from")}</dt>
              <dd className="bg-url">
                {bgStatus.url
                  .replace(/^https:\/\//, "")
                  .replace(/\/releases\/.*$/, "")
                  .split("/")
                  .map((part, i) => (
                    <span key={i}>
                      {i > 0 && "/"}
                      <wbr />
                      {part}
                    </span>
                  ))}
              </dd>
            </dl>
            <button className="bg-link" onClick={() => void openUrl(bgStatus.homepage)}>
              {t("bg.about")}
            </button>
          </div>
          <p className="ed-hint">{t("bg.privacy")}</p>
          {bgDownload ? (
            <div className="bg-progress">
              <div className="progress">
                <div className="progress-bar" style={{ width: `${pct}%` }} />
              </div>
              <div className="bg-progress-row">
                <small>
                  {mb(bgDownload.received)} / {mb(bgDownload.total)}
                </small>
                <button className="btn btn-ghost" onClick={() => void api.bgModelCancel()}>
                  {t("common.cancel")}
                </button>
              </div>
            </div>
          ) : (
            <button className="btn btn-primary ed-wide" onClick={() => void downloadModel()}>
              <Download size={15} />
              {t("bg.download", { size: mb(bgStatus.size) })}
            </button>
          )}
        </>
      );
    } else {
      panel = (
        <>
          {state.bg ? (
            <>
              {slider(t("bg.threshold"), state.bg.threshold, 1, 99, (v) => live((s) => ({ ...s, bg: { threshold: v } })), () =>
                commit((s) => ({ ...s, bg: { threshold: DEFAULT_THRESHOLD } })),
              )}
              <p className="ed-hint">{t("bg.thresholdHint")}</p>
              <button className="btn btn-default ed-wide" onClick={() => commit((s) => ({ ...s, bg: null }))}>
                {t("bg.restore")}
              </button>
            </>
          ) : (
            <>
              <p className="ed-hint">{t("bg.ready")}</p>
              <button className="btn btn-primary ed-wide" disabled={bgBusy || !source} onClick={() => void removeBackground()}>
                {bgBusy ? <LoaderCircle className="spin" size={15} /> : <WandSparkles size={15} />}
                {bgBusy ? t("bg.working") : t("bg.remove")}
              </button>
            </>
          )}
          <div className="bg-installed">
            <small>
              {bgStatus.name} · {mb(bgStatus.size)}
            </small>
            <button className="ed-icon-btn" disabled={bgBusy} onClick={() => void deleteModel()} data-tip={t("bg.deleteModel")} aria-label={t("bg.deleteModel")}>
              <Trash2 size={16} />
            </button>
          </div>
        </>
      );
    }
    if (bgError) panel = (
      <>
        {panel}
        <p className="bg-error">{bgError}</p>
      </>
    );
  }

  const cropBox = tool === "crop" && source && scale > 0 && (
    <div
      className="ed-crop"
      style={{ left: (crop.x - region.x) * scale, top: (crop.y - region.y) * scale, width: crop.w * scale, height: crop.h * scale }}
      onPointerDown={onCropDown("move")}
    >
      <div className="ed-crop-grid" />
      {HANDLES.map((h) => (
        <div key={h} className={`ed-handle ed-handle-${h}`} onPointerDown={onCropDown(h)} />
      ))}
    </div>
  );

  const textFontPx = textEdit?.size !== undefined ? textEdit.size * scale : textSize;
  const textBoxWidth = textEdit ? measureText({ kind: "text", at: [0, 0], text: textEdit.value, color, size: textFontPx }).w : 0;
  // Outline of the selected annotation (hidden while its text is being typed).
  const selBox = selAnn && scale > 0 && sel !== editingIndex && (tool === "text" || selecting) ? annotationBounds(selAnn, measureText) : null;

  return (
    <div className="editor-root" role="dialog" aria-modal="true" aria-label={t("tb.edit")}>
      <div className="editor-bar">
        <div className="editor-bar-side">
          <button className="ed-icon-btn" onClick={requestClose} data-tip={t("ed.close")} aria-label={t("ed.close")} data-tip-pos="below">
            <X size={18} />
          </button>
          <span className="editor-sep" />
          <button className="ed-icon-btn" disabled={!hist.past.length} onClick={undo} data-tip={`${t("ed.undo")} (Ctrl+Z)`} aria-label={`${t("ed.undo")} (Ctrl+Z)`} data-tip-pos="below">
            <Undo2 size={18} />
          </button>
          <button className="ed-icon-btn" disabled={!hist.future.length} onClick={redo} data-tip={`${t("ed.redo")} (Ctrl+Y)`} aria-label={`${t("ed.redo")} (Ctrl+Y)`} data-tip-pos="below">
            <Redo2 size={18} />
          </button>
          <button
            className="btn btn-ghost"
            disabled={!dirty}
            onClick={() => {
              setSelected(null);
              commit(initialState(startTurns));
            }}
          >
            {t("ed.reset")}
          </button>
        </div>

        <div className="editor-tabs" role="tablist">
          {tools.map((x) => (
            <button key={x.id} role="tab" aria-selected={tool === x.id} className={`editor-tab${tool === x.id ? " on" : ""}`} onClick={() => setTool(x.id)} aria-label={t(x.label)}>
              <x.icon size={17} />
              <span>{t(x.label)}</span>
            </button>
          ))}
        </div>

        <div className="editor-bar-side editor-bar-end">
          <div className="ed-save">
            <button className="btn btn-primary" disabled={!dirty || !source || saving} onClick={() => setSaveMenu((v) => !v)}>
              {t("ed.save")}
              <ChevronDown size={15} />
            </button>
            {saveMenu && (
              <div className="menu-popup ed-save-menu" onPointerDown={(e) => e.stopPropagation()}>
                <button className="ed-save-item" onClick={() => void saveCopy()}>
                  <Copy size={18} />
                  <span>
                    <strong>{t("ed.saveCopy")}</strong>
                    <small>{t("ed.saveCopyHint")}</small>
                  </span>
                </button>
                <button
                  className="ed-save-item"
                  disabled={!canReplace}
                  onClick={() => {
                    setSaveMenu(false);
                    setConfirm("replace");
                  }}
                >
                  <Replace size={18} />
                  <span>
                    <strong>{t("ed.replace")}</strong>
                    <small>
                      {!canReplace
                        ? t("ed.replaceUnavailable")
                        : state.bg && !ALPHA_EXTENSIONS.has(extension(path))
                          ? t("ed.replaceNoAlpha")
                          : t("ed.replaceHint")}
                    </small>
                  </span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="editor-main" onPointerDown={() => saveMenu && setSaveMenu(false)}>
        <div
          ref={stageRef}
          className={`editor-stage tool-${tool}${tool === "draw" ? ` mode-${drawMode}` : ""}${hoverMovable || drag.current?.kind === "move" ? " can-move" : ""}`}
          onPointerDown={onStageDown}
          onPointerMove={onStageMove}
          onPointerUp={onStageUp}
          onPointerCancel={onStageUp}
          onDoubleClick={onStageDoubleClick}
        >
          {failed && <div className="editor-msg">{t("ed.loadFailed")}</div>}
          {!source && !failed && <LoaderCircle className="spin editor-spinner" size={28} />}
          {source && scale > 0 && (
            <div className={`editor-canvas-wrap${maskCanvas ? " checker" : ""}`} style={{ width: view.w, height: view.h }}>
              <canvas ref={canvasRef} style={{ width: view.w, height: view.h }} />
              {tool === "crop" && (
                <div
                  className="ed-crop-shade"
                  style={{
                    clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${(crop.x - region.x) * scale}px ${(crop.y - region.y) * scale}px, ${(crop.x - region.x) * scale}px ${(crop.y - region.y + crop.h) * scale}px, ${(crop.x - region.x + crop.w) * scale}px ${(crop.y - region.y + crop.h) * scale}px, ${(crop.x - region.x + crop.w) * scale}px ${(crop.y - region.y) * scale}px, ${(crop.x - region.x) * scale}px ${(crop.y - region.y) * scale}px)`,
                  }}
                />
              )}
              {cropBox}
              {selBox && (
                <div
                  className="ed-selection"
                  style={{ left: (selBox.x - region.x) * scale, top: (selBox.y - region.y) * scale, width: selBox.w * scale, height: selBox.h * scale }}
                />
              )}
              {guides?.x.map((x) => <div key={`x${x}`} className="ed-guide ed-guide-v" style={{ left: (x - region.x) * scale }} />)}
              {guides?.y.map((y) => <div key={`y${y}`} className="ed-guide ed-guide-h" style={{ top: (y - region.y) * scale }} />)}
              {textEdit && (
                <input
                  className="editor-text-input"
                  autoFocus
                  value={textEdit.value}
                  placeholder={t("ed.textPlaceholder")}
                  style={{
                    left: (textEdit.at[0] - region.x) * scale,
                    top: (textEdit.at[1] - region.y) * scale,
                    width: Math.max(140, textBoxWidth + 24),
                    color: textEdit.color ?? color,
                    font: TEXT_FONT(textFontPx),
                    lineHeight: TEXT_LINE_HEIGHT,
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onChange={(e) => setTextEdit((te) => (te ? { ...te, value: e.target.value } : te))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitText();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      setTextEdit(null);
                    }
                  }}
                  onBlur={commitText}
                />
              )}
            </div>
          )}
        </div>
        <aside className="editor-panel">{panel}</aside>
      </div>

      {saving && (
        <div className="editor-saving">
          <LoaderCircle className="spin" size={26} />
          <span>{t("ed.saving")}</span>
        </div>
      )}

      {confirm === "replace" && (
        <ConfirmDialog
          title={t("ed.replaceTitle")}
          onClose={() => setConfirm(null)}
          actions={[
            { label: t("common.cancel"), onClick: () => setConfirm(null) },
            {
              label: t("ed.replace"),
              kind: "primary",
              autoFocus: true,
              onClick: () => {
                setConfirm(null);
                void doSave(path, "replace");
              },
            },
          ]}
        >
          <p>{t("ed.replaceBody", { name: fileName(path) })}</p>
        </ConfirmDialog>
      )}
      {confirm === "discard" && (
        <ConfirmDialog
          title={t("ed.discardTitle")}
          onClose={() => setConfirm(null)}
          actions={[
            { label: t("ed.keep"), onClick: () => setConfirm(null), autoFocus: true },
            { label: t("ed.discard"), kind: "danger", onClick: onClose },
          ]}
        >
          <p>{t("ed.discardBody")}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

/** A small preview of the picture with a filter applied. */
function FilterThumb({
  id,
  label,
  source,
  srcSize,
  state,
  on,
  onPick,
}: {
  id: FilterId;
  label: string;
  source: HTMLImageElement | null;
  srcSize: Size;
  state: EditState;
  on: boolean;
  onPick: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { turns, flipH, flipV, crop } = state;
  useEffect(() => {
    const c = ref.current;
    if (!c || !source) return;
    const s: EditState = { ...initialState(), turns, flipH, flipV, crop };
    const full = cropRect(s, srcSize);
    // Centre square of the picture so every thumbnail fills its tile.
    const m = Math.min(full.w, full.h);
    const region = { x: full.x + (full.w - m) / 2, y: full.y + (full.h - m) / 2, w: m, h: m };
    const size = 112;
    const k = size / m;
    c.width = size;
    c.height = size;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    drawOriented(ctx, source, srcSize, s, region, k);
    const img = ctx.getImageData(0, 0, c.width, c.height);
    applyAdjust(img.data, c.width, c.height, FILTERS[id]);
    ctx.putImageData(img, 0, 0);
  }, [id, source, srcSize, turns, flipH, flipV, crop]);
  return (
    <button className={`ed-filter${on ? " on" : ""}`} onClick={onPick}>
      <span className="ed-filter-img">
        <canvas ref={ref} />
        {on && (
          <span className="ed-filter-check">
            <Check size={13} strokeWidth={3} />
          </span>
        )}
      </span>
      <span>{label}</span>
    </button>
  );
}
