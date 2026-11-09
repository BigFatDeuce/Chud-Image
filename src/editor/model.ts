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
  | { kind: "text"; at: Pt; text: string; color: string; size: number };

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
}

export const initialState = (turns = 0): EditState => ({
  turns: ((turns % 4) + 4) % 4,
  flipH: false,
  flipV: false,
  crop: null,
  adjust: NEUTRAL,
  annotations: [],
});

export function isPristine(s: EditState, startTurns = 0): boolean {
  return (
    s.turns === ((startTurns % 4) + 4) % 4 &&
    !s.flipH &&
    !s.flipV &&
    s.crop === null &&
    s.annotations.length === 0 &&
    isNeutral(s.adjust)
  );
}

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
  let r: Rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  if (ratio) {
    // Width leads for side/corner handles, height for top/bottom ones.
    const byHeight = handle === "n" || handle === "s";
    let w = byHeight ? r.h * ratio : r.w;
    let h = byHeight ? r.h : r.w / ratio;
    // Stay inside the picture on the sides the handle can grow towards.
    const maxW = handle.includes("w") ? x1 : bounds.w - x0;
    const maxH = handle.includes("n") ? y1 : bounds.h - y0;
    if (w > maxW) {
      w = maxW;
      h = w / ratio;
    }
    if (h > maxH) {
      h = maxH;
      w = h * ratio;
    }
    const nx = handle.includes("w") ? x1 - w : handle === "n" || handle === "s" ? start.x + (start.w - w) / 2 : x0;
    const ny = handle.includes("n") ? y1 - h : handle === "e" || handle === "w" ? start.y + (start.h - h) / 2 : y0;
    r = clampRect({ x: nx, y: ny, w, h }, bounds, min);
  }
  return r;
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
    ctx.font = TEXT_FONT(a.size);
    ctx.textBaseline = "top";
    // A thin contrasting outline keeps text readable on any background.
    ctx.lineWidth = Math.max(2, a.size / 9);
    ctx.strokeStyle = isLight(a.color) ? "rgba(0,0,0,0.55)" : "rgba(255,255,255,0.7)";
    const lines = a.text.split("\n");
    lines.forEach((line, i) => {
      ctx.strokeText(line, a.at[0], a.at[1] + i * a.size * 1.2);
      ctx.fillStyle = a.color;
      ctx.fillText(line, a.at[0], a.at[1] + i * a.size * 1.2);
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
export function renderFull(src: CanvasImageSource, srcSize: Size, s: EditState): HTMLCanvasElement {
  const region = cropRect(s, srcSize);
  const w = Math.max(1, Math.round(region.w));
  const h = Math.max(1, Math.round(region.h));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  drawOriented(ctx, src, srcSize, s, { ...region, w, h }, 1);
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
