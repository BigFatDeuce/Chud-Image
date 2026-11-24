// Non-destructive editing model: the original picture plus a list of operations
// (orientation, crop, adjustments, annotations). Everything is re-rendered from the
// source, so undo/redo is a stack of small immutable states and the export is always
// computed at full resolution.

export type Pt = [number, number];

export interface Adjust {
  /** All in -100…100 except sepia and vignette (0…100). */
  brightness: number;
  contrast: number;
  saturation: number;
  warmth: number;
  sepia: number;
  vignette: number;
}

export const NEUTRAL: Adjust = { brightness: 0, contrast: 0, saturation: 0, warmth: 0, sepia: 0, vignette: 0 };

export type FilterId = "none" | "bw" | "sepia" | "vintage" | "cool" | "warm" | "vivid" | "drama";

export const FILTERS: Record<FilterId, Adjust> = {
  none: NEUTRAL,
  bw: { ...NEUTRAL, saturation: -100, contrast: 12 },
  sepia: { ...NEUTRAL, sepia: 85, contrast: 6 },
  vintage: { ...NEUTRAL, sepia: 30, contrast: -12, saturation: -20, warmth: 14, vignette: 40 },
  cool: { ...NEUTRAL, warmth: -32, saturation: 6, contrast: 4 },
  warm: { ...NEUTRAL, warmth: 30, saturation: 10 },
  vivid: { ...NEUTRAL, saturation: 38, contrast: 16, brightness: 3 },
  drama: { ...NEUTRAL, contrast: 38, saturation: -18, vignette: 50, brightness: -6 },
};

export type Annotation =
  | { kind: "pen"; points: Pt[]; color: string; size: number; opacity: number }
  | { kind: "line" | "arrow" | "rect" | "ellipse"; a: Pt; b: Pt; color: string; size: number }
  | {
      kind: "text";
      at: Pt;
      text: string;
      color: string;
      size: number;
      /** Opacity (0…1) of a contrasting outline around the letters; absent or 0 = none. */
      outline?: number;
    };

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EditState {
  /** Clockwise quarter turns, then optional mirrors, applied to the source. */
  turns: number;
  flipH: boolean;
  flipV: boolean;
  /** In oriented-image pixels; null = whole picture. */
  crop: Rect | null;
  adjust: Adjust;
  /** In oriented-image pixels (crop-independent, so the crop can change afterwards). */
  annotations: Annotation[];
  /** Background removal (the subject mask itself lives outside the history); null = off. */
  bg: { threshold: number } | null;
}

export const initialState = (turns = 0): EditState => ({
  turns: ((turns % 4) + 4) % 4,
  flipH: false,
  flipV: false,
  crop: null,
  adjust: NEUTRAL,
  annotations: [],
  bg: null,
});

export function isPristine(s: EditState, startTurns = 0): boolean {
  return (
    s.turns === ((startTurns % 4) + 4) % 4 &&
    !s.flipH &&
    !s.flipV &&
    s.crop === null &&
    s.annotations.length === 0 &&
    s.bg === null &&
    isNeutral(s.adjust)
  );
}

// ------------------------------------------------------------------ background removal

/** Side of the square picture the background model works on. */
export const MASK_SIDE = 1024;

/** Threshold 50 is the model's own verdict; higher removes more, lower keeps more. */
export const DEFAULT_THRESHOLD = 50;

/**
 * Turns the model's subject probabilities (0…255) into RGBA alpha. Pixels well above the
 * threshold are kept, well below are removed, with a soft band in between for clean edges.
 */
export function thresholdMask(mask: Uint8Array, threshold: number): Uint8ClampedArray<ArrayBuffer> {
  const t = Math.min(99, Math.max(1, threshold)) / 100;
  const band = 0.15;
  const lo = Math.max(0, t - band);
  const hi = Math.min(1, t + band);
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    const x = Math.min(1, Math.max(0, (i / 255 - lo) / (hi - lo)));
    lut[i] = Math.round(255 * x * x * (3 - 2 * x));
  }
  const out = new Uint8ClampedArray(mask.length * 4);
  for (let i = 0; i < mask.length; i++) out[i * 4 + 3] = lut[mask[i]];
  return out;
}

/** Keeps only the subject: `mask` (source orientation) cuts out what `ctx` holds. */
export function applyMask(ctx: CanvasRenderingContext2D, mask: CanvasImageSource, srcSize: Size, s: EditState, region: Rect, scale: number) {
  ctx.save();
  ctx.globalCompositeOperation = "destination-in";
  drawOriented(ctx, mask, srcSize, s, region, scale);
  ctx.restore();
}

/** Extensions that keep transparency when saved. */
export const ALPHA_EXTENSIONS = new Set(["png", "webp", "tif", "tiff", "tga", "qoi"]);

export const isNeutral = (a: Adjust) => (Object.keys(NEUTRAL) as (keyof Adjust)[]).every((k) => a[k] === 0);

// ------------------------------------------------------------------ geometry

export interface Size {
  w: number;
  h: number;
}

export const orientedSize = (src: Size, turns: number): Size => (turns % 2 ? { w: src.h, h: src.w } : { ...src });

/** The visible region of the oriented picture. */
export const cropRect = (s: EditState, src: Size): Rect => {
  const o = orientedSize(src, s.turns);
  return s.crop ?? { x: 0, y: 0, w: o.w, h: o.h };
};

/** Maps a point of the oriented picture when turning it a quarter clockwise. */
const turnPt = ([x, y]: Pt, o: Size): Pt => [o.h - y, x];
const mapAnnotation = (a: Annotation, f: (p: Pt) => Pt): Annotation => {
  switch (a.kind) {
    case "pen":
      return { ...a, points: a.points.map(f) };
    case "text":
      return { ...a, at: f(a.at) };
    default:
      return { ...a, a: f(a.a), b: f(a.b) };
  }
};
const normRect = (a: Pt, b: Pt): Rect => ({
  x: Math.min(a[0], b[0]),
  y: Math.min(a[1], b[1]),
  w: Math.abs(b[0] - a[0]),
  h: Math.abs(b[1] - a[1]),
});

/** Turns the picture (and its crop and drawings with it) by ±90°. */
export function rotateState(s: EditState, src: Size, dir: 1 | -1): EditState {
  let next = s;
  for (let i = 0; i < (dir === 1 ? 1 : 3); i++) {
    const o = orientedSize(src, next.turns);
    const f = (p: Pt) => turnPt(p, o);
    const crop = next.crop ? normRect(f([next.crop.x, next.crop.y]), f([next.crop.x + next.crop.w, next.crop.y + next.crop.h])) : null;
    // A quarter turn swaps the mirror axes.
    next = {
      ...next,
      turns: (next.turns + 1) % 4,
      flipH: next.flipV,
      flipV: next.flipH,
      crop,
      annotations: next.annotations.map((a) => mapAnnotation(a, f)),
    };
  }
  return next;
}

export function flipState(s: EditState, src: Size, axis: "h" | "v"): EditState {
  const o = orientedSize(src, s.turns);
  const f = ([x, y]: Pt): Pt => (axis === "h" ? [o.w - x, y] : [x, o.h - y]);
  const crop = s.crop ? normRect(f([s.crop.x, s.crop.y]), f([s.crop.x + s.crop.w, s.crop.y + s.crop.h])) : null;
  return {
    ...s,
    flipH: axis === "h" ? !s.flipH : s.flipH,
    flipV: axis === "v" ? !s.flipV : s.flipV,
    crop,
    annotations: s.annotations.map((a) => mapAnnotation(a, f)),
  };
}

/** Keeps a crop rectangle inside the picture, at least `min` pixels wide and tall. */
export function clampRect(r: Rect, bounds: Size, min = 8): Rect {
  const w = Math.min(Math.max(r.w, min), bounds.w);
  const h = Math.min(Math.max(r.h, min), bounds.h);
  return {
    x: Math.min(Math.max(r.x, 0), bounds.w - w),
    y: Math.min(Math.max(r.y, 0), bounds.h - h),
    w,
    h,
  };
}

/** Largest centered rectangle of the given aspect ratio (w/h) inside `inside`. */
export function fitAspect(inside: Rect, ratio: number): Rect {
  let w = inside.w;
  let h = w / ratio;
  if (h > inside.h) {
    h = inside.h;
    w = h * ratio;
  }
  return { x: inside.x + (inside.w - w) / 2, y: inside.y + (inside.h - h) / 2, w, h };
}

export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw" | "move";

/**
 * Resizes `start` by dragging `handle` by (dx, dy), optionally locked to `ratio`, and
 * keeps the result inside `bounds`.
 */
export function dragCrop(start: Rect, handle: Handle, dx: number, dy: number, bounds: Size, ratio: number | null, min = 16): Rect {
  if (handle === "move") return clampRect({ ...start, x: start.x + dx, y: start.y + dy }, bounds, min);
  let x0 = start.x;
  let y0 = start.y;
  let x1 = start.x + start.w;
  let y1 = start.y + start.h;
  if (handle.includes("w")) x0 = Math.min(x0 + dx, x1 - min);
  if (handle.includes("e")) x1 = Math.max(x1 + dx, x0 + min);
  if (handle.includes("n")) y0 = Math.min(y0 + dy, y1 - min);
  if (handle.includes("s")) y1 = Math.max(y1 + dy, y0 + min);
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(bounds.w, x1);
  y1 = Math.min(bounds.h, y1);
  if (!ratio) return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };

  // Locked ratio. The edge opposite the handle stays put; a side handle keeps the crop
  // centred across it. Width leads, except for the top/bottom handles.
  const byHeight = !handle.includes("e") && !handle.includes("w");
  // Room available towards where the handle grows (the whole picture across a side handle).
  const roomW = handle.includes("w") ? start.x + start.w : handle.includes("e") ? bounds.w - start.x : bounds.w;
  const roomH = handle.includes("n") ? start.y + start.h : handle.includes("s") ? bounds.h - start.y : bounds.h;
  // The shorter side never goes below `min`, the crop never leaves the picture.
  const minW = Math.max(min, min * ratio);
  const maxW = Math.min(roomW, roomH * ratio);
  let w = byHeight ? (y1 - y0) * ratio : x1 - x0;
  // Too little room on the anchored side for the minimum: let the crop slide instead.
  w = minW <= maxW ? Math.min(Math.max(w, minW), maxW) : Math.min(minW, bounds.w, bounds.h * ratio);
  const h = w / ratio;
  const within = (v: number, size: number, limit: number) => Math.min(Math.max(v, 0), Math.max(0, limit - size));
  const x = handle.includes("w") ? start.x + start.w - w : handle.includes("e") ? start.x : start.x + (start.w - w) / 2;
  const y = handle.includes("n") ? start.y + start.h - h : handle.includes("s") ? start.y : start.y + (start.h - h) / 2;
  return { x: within(x, w, bounds.w), y: within(y, h, bounds.h), w, h };
}

// ------------------------------------------------------------------ adjustments

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Per-channel lookup tables for warmth + brightness + contrast. */
export function channelLuts(a: Adjust): [Uint8ClampedArray, Uint8ClampedArray, Uint8ClampedArray] {
  const c = a.contrast * 1.28;
  const factor = (259 * (c + 255)) / (255 * (259 - c));
  const bright = a.brightness * 1.1;
  const warm = a.warmth * 0.35;
  const make = (shift: number) => {
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) lut[i] = clamp255(factor * (i + bright + shift - 128) + 128);
    return lut;
  };
  return [make(warm), make(warm * 0.15), make(-warm)];
}

/**
 * Applies `a` to RGBA pixels in place. For the vignette, `full` says where this buffer
 * sits (x, y) inside the whole output picture of size (w, h).
 */
export function applyAdjust(data: Uint8ClampedArray, width: number, height: number, a: Adjust, full?: { x: number; y: number; w: number; h: number }) {
  if (isNeutral(a)) return;
  const [lr, lg, lb] = channelLuts(a);
  const sat = 1 + a.saturation / 100;
  const sepia = a.sepia / 100;
  const vig = a.vignette / 100;
  const area = full ?? { x: 0, y: 0, w: width, h: height };
  const cx = area.w / 2;
  const cy = area.h / 2;
  const maxD = Math.hypot(cx, cy);
  for (let y = 0, i = 0; y < height; y++) {
    const dy = y + area.y - cy;
    for (let x = 0; x < width; x++, i += 4) {
      let r = lr[data[i]];
      let g = lg[data[i + 1]];
      let b = lb[data[i + 2]];
      if (sat !== 1) {
        const l = 0.299 * r + 0.587 * g + 0.114 * b;
        r = l + (r - l) * sat;
        g = l + (g - l) * sat;
        b = l + (b - l) * sat;
      }
      if (sepia > 0) {
        const sr = 0.393 * r + 0.769 * g + 0.189 * b;
        const sg = 0.349 * r + 0.686 * g + 0.168 * b;
        const sb = 0.272 * r + 0.534 * g + 0.131 * b;
        r += (sr - r) * sepia;
        g += (sg - g) * sepia;
        b += (sb - b) * sepia;
      }
      if (vig > 0) {
        const d = Math.hypot(x + area.x - cx, dy) / maxD;
        const t = d < 0.45 ? 0 : (d - 0.45) / 0.55;
        const k = 1 - vig * 0.75 * t * t * (3 - 2 * t);
        r *= k;
        g *= k;
        b *= k;
      }
      data[i] = clamp255(r);
      data[i + 1] = clamp255(g);
      data[i + 2] = clamp255(b);
    }
  }
}

// ------------------------------------------------------------------ rendering

export const TEXT_FONT = (size: number) => `600 ${size}px "Segoe UI", system-ui, -apple-system, "Noto Sans", sans-serif`;

/** Line height of the text annotations, as a multiple of the font size. */
export const TEXT_LINE_HEIGHT = 1.2;

const outlineWidth = (size: number) => Math.max(2, size / 9);

export interface TextLayout extends Size {
  lineHeight: number;
  /** From the top of a line box to the baseline. */
  baseline: number;
}

/**
 * Measures a text annotation and places its baseline the way CSS places it in a line box
 * of TEXT_LINE_HEIGHT: the font's ascent plus half the leading. The editor types into an
 * HTML text box laid out by these same rules, so the committed text does not move.
 */
export function textLayout(ctx: CanvasRenderingContext2D, a: Annotation & { kind: "text" }): TextLayout {
  ctx.save();
  ctx.font = TEXT_FONT(a.size);
  const lines = a.text.split("\n");
  const w = Math.max(0, ...lines.map((l) => ctx.measureText(l).width));
  const m = ctx.measureText("Hg");
  ctx.restore();
  const lineHeight = a.size * TEXT_LINE_HEIGHT;
  const ascent = Number.isFinite(m.fontBoundingBoxAscent) ? m.fontBoundingBoxAscent : a.size * 0.92;
  const descent = Number.isFinite(m.fontBoundingBoxDescent) ? m.fontBoundingBoxDescent : a.size * 0.24;
  return { w, h: lines.length * lineHeight, lineHeight, baseline: (lineHeight - ascent - descent) / 2 + ascent };
}

/** Width and height of a text annotation; the default is a rough estimate for tests. */
export type Measure = (a: Annotation & { kind: "text" }) => Size;
export const roughMeasure: Measure = (a) => {
  const lines = a.text.split("\n");
  return { w: Math.max(...lines.map((l) => l.length)) * a.size * 0.6, h: lines.length * a.size * TEXT_LINE_HEIGHT };
};

export function drawAnnotation(ctx: CanvasRenderingContext2D, a: Annotation) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (a.kind === "pen") {
    ctx.globalAlpha = a.opacity;
    ctx.strokeStyle = a.color;
    ctx.lineWidth = a.size;
    // Highlighters keep flat ends like a real marker.
    if (a.opacity < 1) ctx.lineCap = "butt";
    ctx.beginPath();
    const [first, ...rest] = a.points;
    ctx.moveTo(first[0], first[1]);
    if (rest.length === 0) ctx.lineTo(first[0] + 0.01, first[1]);
    // Smooth the stroke through the midpoints of successive samples.
    for (let i = 0; i < rest.length; i++) {
      const p = rest[i];
      const next = rest[i + 1];
      if (next) ctx.quadraticCurveTo(p[0], p[1], (p[0] + next[0]) / 2, (p[1] + next[1]) / 2);
      else ctx.lineTo(p[0], p[1]);
    }
    ctx.stroke();
  } else if (a.kind === "text") {
    const layout = textLayout(ctx, a);
    ctx.font = TEXT_FONT(a.size);
    // Laid out like the text box used to type it, so the words stay exactly where typed.
    ctx.textBaseline = "alphabetic";
    const outline = Math.min(1, Math.max(0, a.outline ?? 0));
    // Optional contrasting outline, to keep text readable on busy backgrounds.
    ctx.lineWidth = outlineWidth(a.size);
    ctx.strokeStyle = isLight(a.color) ? `rgba(0,0,0,${outline})` : `rgba(255,255,255,${outline})`;
    ctx.fillStyle = a.color;
    a.text.split("\n").forEach((line, i) => {
      const y = a.at[1] + i * layout.lineHeight + layout.baseline;
      if (outline > 0) ctx.strokeText(line, a.at[0], y);
      ctx.fillText(line, a.at[0], y);
    });
  } else {
    ctx.strokeStyle = a.color;
    ctx.fillStyle = a.color;
    ctx.lineWidth = a.size;
    const [x0, y0] = a.a;
    const [x1, y1] = a.b;
    ctx.beginPath();
    if (a.kind === "rect") {
      ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    } else if (a.kind === "ellipse") {
      ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      const angle = Math.atan2(y1 - y0, x1 - x0);
      const head = Math.max(a.size * 3.2, 12);
      // Stop the shaft under the arrow head so its tip stays sharp.
      const end: Pt = a.kind === "arrow" ? [x1 - Math.cos(angle) * head * 0.6, y1 - Math.sin(angle) * head * 0.6] : [x1, y1];
      ctx.moveTo(x0, y0);
      ctx.lineTo(end[0], end[1]);
      ctx.stroke();
      if (a.kind === "arrow") {
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 - head * Math.cos(angle - 0.42), y1 - head * Math.sin(angle - 0.42));
        ctx.lineTo(x1 - head * Math.cos(angle + 0.42), y1 - head * Math.sin(angle + 0.42));
        ctx.closePath();
        ctx.fill();
      }
    }
  }
  ctx.restore();
}

export function isLight(color: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = n >> 16;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 160;
}

/**
 * Draws the source with the state's orientation into `ctx`, showing `region` (oriented
 * pixels) scaled by `scale`. The canvas must already be sized.
 */
export function drawOriented(ctx: CanvasRenderingContext2D, src: CanvasImageSource, srcSize: Size, s: EditState, region: Rect, scale: number) {
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.scale(scale, scale);
  ctx.translate(-region.x, -region.y);
  const o = orientedSize(srcSize, s.turns);
  // Mirror inside the oriented frame, then rotate the source into it.
  ctx.translate(s.flipH ? o.w : 0, s.flipV ? o.h : 0);
  ctx.scale(s.flipH ? -1 : 1, s.flipV ? -1 : 1);
  ctx.translate(o.w / 2, o.h / 2);
  ctx.rotate((s.turns * Math.PI) / 2);
  ctx.drawImage(src, -srcSize.w / 2, -srcSize.h / 2, srcSize.w, srcSize.h);
  ctx.restore();
}

/** Full-resolution render of the edit, used for saving. */
export function renderFull(src: CanvasImageSource, srcSize: Size, s: EditState, mask?: CanvasImageSource | null): HTMLCanvasElement {
  const region = cropRect(s, srcSize);
  const w = Math.max(1, Math.round(region.w));
  const h = Math.max(1, Math.round(region.h));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  drawOriented(ctx, src, srcSize, s, { ...region, w, h }, 1);
  if (s.bg && mask) applyMask(ctx, mask, srcSize, s, { ...region, w, h }, 1);
  if (!isNeutral(s.adjust)) {
    // Row bands keep peak memory low on very large pictures.
    const band = 512;
    for (let y = 0; y < h; y += band) {
      const bh = Math.min(band, h - y);
      const img = ctx.getImageData(0, y, w, bh);
      applyAdjust(img.data, w, bh, s.adjust, { x: 0, y, w, h });
      ctx.putImageData(img, 0, y);
    }
  }
  ctx.save();
  ctx.translate(-region.x, -region.y);
  for (const a of s.annotations) drawAnnotation(ctx, a);
  ctx.restore();
  return canvas;
}

/** Distance from point p to segment ab. */
function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Whether the eraser at `p` (radius r) touches annotation `a`. */
export function hitAnnotation(a: Annotation, p: Pt, r: number, measure?: (a: Annotation & { kind: "text" }) => Size): boolean {
  if (a.kind === "pen") {
    const tol = r + a.size / 2;
    if (a.points.length === 1) return Math.hypot(p[0] - a.points[0][0], p[1] - a.points[0][1]) <= tol;
    for (let i = 1; i < a.points.length; i++) if (segDist(p, a.points[i - 1], a.points[i]) <= tol) return true;
    return false;
  }
  if (a.kind === "text") {
    const size = measure?.(a) ?? { w: a.text.length * a.size * 0.6, h: a.size * 1.2 };
    return p[0] >= a.at[0] - r && p[0] <= a.at[0] + size.w + r && p[1] >= a.at[1] - r && p[1] <= a.at[1] + size.h + r;
  }
  const tol = r + a.size / 2;
  if (a.kind === "line" || a.kind === "arrow") return segDist(p, a.a, a.b) <= tol;
  const rect = normRect(a.a, a.b);
  if (a.kind === "rect") {
    const corners: Pt[] = [
      [rect.x, rect.y],
      [rect.x + rect.w, rect.y],
      [rect.x + rect.w, rect.y + rect.h],
      [rect.x, rect.y + rect.h],
    ];
    return corners.some((c, i) => segDist(p, c, corners[(i + 1) % 4]) <= tol);
  }
  // Ellipse: distance to the outline, approximated in normalised space.
  const rx = rect.w / 2 || 1;
  const ry = rect.h / 2 || 1;
  const nx = (p[0] - (rect.x + rx)) / rx;
  const ny = (p[1] - (rect.y + ry)) / ry;
  return Math.abs(Math.hypot(nx, ny) - 1) * Math.min(rx, ry) <= tol;
}

// ------------------------------------------------------------------ selecting & moving

/** The box an annotation covers on the picture, thickness of its lines included. */
export function annotationBounds(a: Annotation, measure: Measure = roughMeasure): Rect {
  if (a.kind === "text") {
    const size = measure(a);
    const pad = a.outline ? outlineWidth(a.size) / 2 : 0;
    return { x: a.at[0] - pad, y: a.at[1] - pad, w: size.w + pad * 2, h: size.h + pad * 2 };
  }
  const pts = a.kind === "pen" ? a.points : [a.a, a.b];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  // An arrow head is wider than its shaft.
  const half = a.kind === "arrow" ? Math.max(a.size * 3.2, 12) / 2 : a.size / 2;
  const x = Math.min(...xs) - half;
  const y = Math.min(...ys) - half;
  return { x, y, w: Math.max(...xs) + half - x, h: Math.max(...ys) + half - y };
}

/** The same annotation, moved by (dx, dy). */
export const translateAnnotation = (a: Annotation, dx: number, dy: number): Annotation =>
  mapAnnotation(a, ([x, y]) => [x + dx, y + dy]);

/**
 * The topmost annotation under `p` (index in `list`, or -1). Lines and outlines are hit
 * within `tol`; the inside of a text, a rectangle or an ellipse counts too, but only when
 * no outline is closer to the pointer.
 */
export function pickAnnotation(list: Annotation[], p: Pt, tol: number, measure: Measure = roughMeasure, accept: (a: Annotation) => boolean = () => true): number {
  for (let i = list.length - 1; i >= 0; i--) {
    const a = list[i];
    if (accept(a) && hitAnnotation(a, p, tol, measure)) return i;
  }
  for (let i = list.length - 1; i >= 0; i--) {
    const a = list[i];
    if (!accept(a) || (a.kind !== "rect" && a.kind !== "ellipse")) continue;
    const r = annotationBounds(a, measure);
    if (p[0] >= r.x && p[0] <= r.x + r.w && p[1] >= r.y && p[1] <= r.y + r.h) return i;
  }
  return -1;
}

export interface Snap {
  dx: number;
  dy: number;
  /** Lines the moved box snapped to, in picture pixels (for on-screen guides). */
  guides: { x: number[]; y: number[] };
}

/**
 * Adjusts a move of `box` by (dx, dy) so that its edges or centre land exactly on the
 * edges or centre of `frame` when they come within `tol`.
 */
export function snapMove(box: Rect, dx: number, dy: number, frame: Rect, tol: number): Snap {
  const axis = (start: number, size: number, d: number, fStart: number, fSize: number) => {
    const targets = [fStart, fStart + fSize / 2, fStart + fSize];
    let best: { delta: number; line: number } | null = null;
    for (const offset of [0, size / 2, size]) {
      const at = start + d + offset;
      for (const line of targets) {
        const delta = line - at;
        if (Math.abs(delta) <= tol && (!best || Math.abs(delta) < Math.abs(best.delta))) best = { delta, line };
      }
    }
    return best;
  };
  const sx = axis(box.x, box.w, dx, frame.x, frame.w);
  const sy = axis(box.y, box.h, dy, frame.y, frame.h);
  return {
    dx: dx + (sx?.delta ?? 0),
    dy: dy + (sy?.delta ?? 0),
    guides: { x: sx ? [sx.line] : [], y: sy ? [sy.line] : [] },
  };
}

/**
 * Limits a move so that at least `keep` pixels of the box stay on the frame: an
 * annotation can hang over the edge but never get lost outside the picture.
 */
export function keepInFrame(box: Rect, dx: number, dy: number, frame: Rect, keep: number): [number, number] {
  const kx = Math.min(keep, box.w);
  const ky = Math.min(keep, box.h);
  const lo = (start: number, size: number, f0: number, k: number) => f0 + k - (start + size);
  const hi = (start: number, f0: number, fSize: number, k: number) => f0 + fSize - k - start;
  const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b);
  return [clamp(dx, lo(box.x, box.w, frame.x, kx), hi(box.x, frame.x, frame.w, kx)), clamp(dy, lo(box.y, box.h, frame.y, ky), hi(box.y, frame.y, frame.h, ky))];
}
