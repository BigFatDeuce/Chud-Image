// Pure zoom / pan geometry. Sizes are in CSS pixels; an image's CSS size is its pixel
// size divided by the device pixel ratio, so a scale of 1 shows one image pixel per
// physical screen pixel ("Actual size").

export interface Size {
  w: number;
  h: number;
}

export interface View {
  /** Zoom factor (1 = actual size). */
  scale: number;
  /** Offset of the image centre from the viewport centre, in CSS pixels. */
  x: number;
  y: number;
}

export const MAX_SCALE = 32;
export const ZOOM_STEPS = [
  0.02, 0.03, 0.05, 0.08, 0.1, 0.125, 0.167, 0.25, 0.333, 0.5, 0.667, 0.75, 1, 1.25, 1.5, 2, 3, 4,
  6, 8, 12, 16, 24, 32,
];

/** Size after a rotation by `turns` quarter turns. */
export function rotatedSize(size: Size, turns: number): Size {
  const odd = Math.abs(Math.round(turns)) % 2 === 1;
  return odd ? { w: size.h, h: size.w } : size;
}

/**
 * Largest scale at which the whole (rotated) image fits in the viewport. Small images are
 * never enlarged beyond actual size unless `upscale` is set.
 */
export function fitScale(image: Size, viewport: Size, turns = 0, upscale = false): number {
  const r = rotatedSize(image, turns);
  if (r.w <= 0 || r.h <= 0 || viewport.w <= 0 || viewport.h <= 0) return 1;
  const s = Math.min(viewport.w / r.w, viewport.h / r.h);
  return upscale ? s : Math.min(1, s);
}

/** The smallest zoom allowed: a tenth of the fitted size, never more than 10%. */
export function minScale(fit: number): number {
  return Math.min(0.1, fit / 10);
}

export function clampScale(scale: number, fit: number): number {
  return Math.min(MAX_SCALE, Math.max(minScale(fit), scale));
}

/**
 * Keeps the image inside the viewport: centred along any axis where it is smaller than
 * the viewport, and with no empty gap at the edges along the others.
 */
export function clampPan(view: View, image: Size, viewport: Size, turns = 0): View {
  const r = rotatedSize(image, turns);
  const dw = r.w * view.scale;
  const dh = r.h * view.scale;
  const limit = (offset: number, displayed: number, available: number) => {
    if (displayed <= available) return 0;
    const max = (displayed - available) / 2;
    return Math.min(max, Math.max(-max, offset));
  };
  return { scale: view.scale, x: limit(view.x, dw, viewport.w), y: limit(view.y, dh, viewport.h) };
}

/**
 * Zooms to `scale` while keeping the image point under `anchor` fixed on screen.
 * `anchor` is relative to the viewport centre.
 */
export function zoomAround(view: View, scale: number, anchor: { x: number; y: number }): View {
  const ratio = scale / view.scale;
  return {
    scale,
    x: anchor.x - (anchor.x - view.x) * ratio,
    y: anchor.y - (anchor.y - view.y) * ratio,
  };
}

/** Next zoom preset strictly above (dir > 0) or below (dir < 0) the current scale. */
export function stepScale(scale: number, dir: 1 | -1): number {
  const eps = 1e-3;
  if (dir > 0) return ZOOM_STEPS.find((s) => s > scale * (1 + eps)) ?? MAX_SCALE;
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
    if (ZOOM_STEPS[i] < scale * (1 - eps)) return ZOOM_STEPS[i];
  }
  return ZOOM_STEPS[0];
}

/** Logarithmic mapping between a 0–1 slider position and a scale. */
export function sliderToScale(t: number, min: number, max = MAX_SCALE): number {
  const clamped = Math.min(1, Math.max(0, t));
  return Math.exp(Math.log(min) + clamped * (Math.log(max) - Math.log(min)));
}

export function scaleToSlider(scale: number, min: number, max = MAX_SCALE): number {
  if (max <= min) return 0;
  return (Math.log(scale) - Math.log(min)) / (Math.log(max) - Math.log(min));
}

/** Zoom factor for one wheel event, for mice (lines) and touchpads (pixels) alike. */
export function wheelFactor(deltaY: number, deltaMode: number): number {
  const px = deltaMode === 1 ? deltaY * 33 : deltaMode === 2 ? deltaY * 400 : deltaY;
  const clamped = Math.max(-240, Math.min(240, px));
  return Math.exp(-clamped * 0.0016);
}

export function formatPercent(scale: number): string {
  const p = scale * 100;
  return `${p < 10 ? p.toFixed(1).replace(/\.0$/, "") : Math.round(p)}%`;
}
