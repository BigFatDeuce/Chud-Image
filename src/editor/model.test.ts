import { describe, expect, it } from "vitest";
import {
  applyAdjust,
  channelLuts,
  cropRect,
  DEFAULT_THRESHOLD,
  thresholdMask,
  dragCrop,
  FILTERS,
  fitAspect,
  flipState,
  hitAnnotation,
  initialState,
  isPristine,
  NEUTRAL,
  rotateState,
  type Annotation,
  type EditState,
  type Pt,
} from "./model";

const SRC = { w: 400, h: 300 };

describe("orientation", () => {
  it("swaps the size on quarter turns", () => {
    const s = rotateState(initialState(), SRC, 1);
    expect(cropRect(s, SRC)).toEqual({ x: 0, y: 0, w: 300, h: 400 });
  });

  it("moves drawings and the crop with the picture", () => {
    const s: EditState = { ...initialState(), crop: { x: 10, y: 20, w: 100, h: 50 }, annotations: [{ kind: "line", a: [10, 20], b: [110, 70], color: "#000", size: 2 }] };
    const r = rotateState(s, SRC, 1);
    // (x, y) -> (H - y, x) with H = 300
    expect(r.crop).toEqual({ x: 230, y: 10, w: 50, h: 100 });
    const line = r.annotations[0] as Extract<Annotation, { a: Pt }>;
    expect(line.a).toEqual([280, 10]);
    expect(line.b).toEqual([230, 110]);
  });

  it("four turns, or turning back, give the original state", () => {
    const s: EditState = { ...initialState(), crop: { x: 5, y: 6, w: 70, h: 80 }, flipH: true };
    let r = s;
    for (let i = 0; i < 4; i++) r = rotateState(r, SRC, 1);
    expect(r).toEqual(s);
    expect(rotateState(rotateState(s, SRC, 1), SRC, -1)).toEqual(s);
  });

  it("a quarter turn swaps the mirror axes", () => {
    const s = flipState(initialState(), SRC, "h");
    const r = rotateState(s, SRC, 1);
    expect([r.flipH, r.flipV]).toEqual([false, true]);
  });

  it("mirrors drawings inside the picture", () => {
    const s = { ...initialState(), annotations: [{ kind: "text", at: [30, 40], text: "hi", color: "#fff", size: 20 } as Annotation] };
    const f = flipState(s, SRC, "h");
    expect((f.annotations[0] as Extract<Annotation, { kind: "text" }>).at).toEqual([370, 40]);
  });

  it("knows when nothing changed", () => {
    expect(isPristine(initialState(1), 1)).toBe(true);
    expect(isPristine(rotateState(initialState(1), SRC, 1), 1)).toBe(false);
  });
});

describe("crop", () => {
  it("fits an aspect ratio inside the picture", () => {
    expect(fitAspect({ x: 0, y: 0, w: 400, h: 300 }, 1)).toEqual({ x: 50, y: 0, w: 300, h: 300 });
    expect(fitAspect({ x: 0, y: 0, w: 400, h: 300 }, 16 / 9)).toEqual({ x: 0, y: 37.5, w: 400, h: 225 });
  });

  it("drags edges and stays inside the picture", () => {
    const start = { x: 100, y: 100, w: 100, h: 100 };
    expect(dragCrop(start, "se", 50, 20, SRC, null)).toEqual({ x: 100, y: 100, w: 150, h: 120 });
    expect(dragCrop(start, "nw", -500, -500, SRC, null)).toEqual({ x: 0, y: 0, w: 200, h: 200 });
    expect(dragCrop(start, "move", 1000, 0, SRC, null)).toEqual({ x: 300, y: 100, w: 100, h: 100 });
  });

  it("never collapses below the minimum size", () => {
    const r = dragCrop({ x: 100, y: 100, w: 100, h: 100 }, "e", -400, 0, SRC, null, 16);
    expect(r.w).toBe(16);
  });

  it("keeps the aspect ratio when locked", () => {
    const r = dragCrop({ x: 0, y: 0, w: 100, h: 100 }, "se", 60, 10, SRC, 1);
    expect(r.w).toBeCloseTo(r.h);
    const wide = dragCrop({ x: 0, y: 0, w: 160, h: 90 }, "e", 1000, 0, SRC, 16 / 9);
    expect(wide.w / wide.h).toBeCloseTo(16 / 9);
    expect(wide.x + wide.w).toBeLessThanOrEqual(SRC.w);
    expect(wide.y + wide.h).toBeLessThanOrEqual(SRC.h);
  });

  it("moving never resizes, even a crop smaller than the current minimum", () => {
    const small = { x: 10, y: 10, w: 10, h: 6 };
    expect(dragCrop(small, "move", 5, 7, { w: 100, h: 100 }, null, 16)).toEqual({ x: 15, y: 17, w: 10, h: 6 });
    expect(dragCrop(small, "move", 500, -500, { w: 100, h: 100 }, 16 / 9, 16)).toEqual({ x: 90, y: 0, w: 10, h: 6 });
  });

  it("keeps a locked ratio at the minimum size (regression IMG-03)", () => {
    const r = dragCrop({ x: 0, y: 0, w: 100, h: 100 }, "se", -99, -99, { w: 100, h: 100 }, 16 / 9);
    expect(r.w / r.h).toBeCloseTo(16 / 9, 6);
    expect(Math.min(r.w, r.h)).toBeGreaterThanOrEqual(16 - 1e-9);
  });

  it("any drag stays inside the picture, above the minimum and on ratio", () => {
    // Small deterministic PRNG so failures are reproducible.
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const handles = ["n", "s", "e", "w", "ne", "nw", "se", "sw", "move"] as const;
    const ratios = [null, 1, 4 / 3, 3 / 2, 16 / 9, 3 / 4, 9 / 16, 400 / 300];
    const eps = 1e-6;
    for (let i = 0; i < 4000; i++) {
      const bounds = { w: 40 + Math.floor(rnd() * 800), h: 40 + Math.floor(rnd() * 800) };
      const min = 4 + rnd() * 20;
      const w = min + rnd() * (bounds.w - min);
      const h = min + rnd() * (bounds.h - min);
      const start = { x: rnd() * (bounds.w - w), y: rnd() * (bounds.h - h), w, h };
      const handle = handles[i % handles.length];
      const ratio = ratios[Math.floor(rnd() * ratios.length)];
      const dx = (rnd() - 0.5) * bounds.w * 3;
      const dy = (rnd() - 0.5) * bounds.h * 3;
      const r = dragCrop(start, handle, dx, dy, bounds, handle === "move" ? null : ratio, min);
      const ctx = JSON.stringify({ i, bounds, min, start, handle, ratio, dx, dy, r });
      expect(r.x, ctx).toBeGreaterThanOrEqual(-eps);
      expect(r.y, ctx).toBeGreaterThanOrEqual(-eps);
      expect(r.x + r.w, ctx).toBeLessThanOrEqual(bounds.w + eps);
      expect(r.y + r.h, ctx).toBeLessThanOrEqual(bounds.h + eps);
      const minFits = !ratio || (Math.max(min, min * ratio) <= bounds.w && Math.max(min, min / ratio) <= bounds.h);
      if (minFits) {
        expect(Math.min(r.w, r.h), ctx).toBeGreaterThanOrEqual(min - eps);
        if (ratio && handle !== "move") expect(Math.abs(r.w / r.h - ratio), ctx).toBeLessThan(1e-6);
      }
    }
  });
});

describe("adjustments", () => {
  it("neutral settings leave pixels untouched", () => {
    const [r, g, b] = channelLuts(NEUTRAL);
    for (const i of [0, 64, 128, 200, 255]) {
      expect(r[i]).toBe(i);
      expect(g[i]).toBe(i);
      expect(b[i]).toBe(i);
    }
    const px = new Uint8ClampedArray([10, 120, 250, 255]);
    applyAdjust(px, 1, 1, NEUTRAL);
    expect([...px]).toEqual([10, 120, 250, 255]);
  });

  it("black & white removes colour, keeps alpha", () => {
    const px = new Uint8ClampedArray([200, 40, 40, 128]);
    applyAdjust(px, 1, 1, { ...NEUTRAL, saturation: -100 });
    expect(px[0]).toBe(px[1]);
    expect(px[1]).toBe(px[2]);
    expect(px[3]).toBe(128);
  });

  it("brightness and warmth move the right way", () => {
    const px = new Uint8ClampedArray([100, 100, 100, 255]);
    applyAdjust(px, 1, 1, { ...NEUTRAL, brightness: 50 });
    expect(px[0]).toBeGreaterThan(100);
    const warm = new Uint8ClampedArray([100, 100, 100, 255]);
    applyAdjust(warm, 1, 1, { ...NEUTRAL, warmth: 60 });
    expect(warm[0]).toBeGreaterThan(warm[2]);
  });

  it("the vignette darkens corners, not the centre", () => {
    const w = 21;
    const px = new Uint8ClampedArray(w * w * 4).fill(200);
    applyAdjust(px, w, w, { ...NEUTRAL, vignette: 100 });
    const at = (x: number, y: number) => px[(y * w + x) * 4];
    expect(at(10, 10)).toBe(200);
    expect(at(0, 0)).toBeLessThan(100);
  });

  it("every filter is a valid set of adjustments", () => {
    for (const f of Object.values(FILTERS)) {
      for (const v of Object.values(f)) expect(Math.abs(v)).toBeLessThanOrEqual(100);
    }
  });
});

describe("eraser hit test", () => {
  it("touches strokes and shapes near their outline only", () => {
    const pen: Annotation = { kind: "pen", points: [[0, 0], [100, 0]], color: "#000", size: 4, opacity: 1 };
    expect(hitAnnotation(pen, [50, 3], 2)).toBe(true);
    expect(hitAnnotation(pen, [50, 30], 2)).toBe(false);
    const rect: Annotation = { kind: "rect", a: [0, 0], b: [100, 100], color: "#000", size: 2 };
    expect(hitAnnotation(rect, [100, 50], 3)).toBe(true);
    expect(hitAnnotation(rect, [50, 50], 3)).toBe(false);
    const ellipse: Annotation = { kind: "ellipse", a: [0, 0], b: [100, 100], color: "#000", size: 2 };
    expect(hitAnnotation(ellipse, [100, 50], 3)).toBe(true);
    expect(hitAnnotation(ellipse, [50, 50], 3)).toBe(false);
  });
});

describe("background removal", () => {
  it("keeps the subject, drops the background, softens the edge", () => {
    const a = thresholdMask(new Uint8Array([0, 60, 128, 200, 255]), DEFAULT_THRESHOLD);
    const alpha = [3, 7, 11, 15, 19].map((i) => a[i]);
    expect(alpha[0]).toBe(0);
    expect(alpha[4]).toBe(255);
    expect(alpha[2]).toBeGreaterThan(100);
    expect(alpha[2]).toBeLessThan(160);
    for (let i = 1; i < alpha.length; i++) expect(alpha[i]).toBeGreaterThanOrEqual(alpha[i - 1]);
  });

  it("a higher threshold removes more", () => {
    const m = new Uint8Array([170]);
    expect(thresholdMask(m, 90)[3]).toBeLessThan(thresholdMask(m, 50)[3]);
    expect(thresholdMask(m, 20)[3]).toBe(255);
  });

  it("counts as an edit", () => {
    expect(isPristine({ ...initialState(), bg: { threshold: 50 } })).toBe(false);
  });
});
