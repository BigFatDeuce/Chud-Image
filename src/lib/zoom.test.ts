import { describe, expect, it } from "vitest";
import {
  clampPan,
  clampScale,
  fitScale,
  formatPercent,
  keptView,
  MAX_SCALE,
  minScale,
  rotatedSize,
  scaleToSlider,
  sliderToScale,
  stepScale,
  wheelFactor,
  zoomAround,
} from "./zoom";

describe("fitScale", () => {
  it("shrinks large images to the viewport, keeping the aspect ratio", () => {
    expect(fitScale({ w: 4000, h: 3000 }, { w: 800, h: 600 })).toBeCloseTo(0.2);
    expect(fitScale({ w: 4000, h: 1000 }, { w: 800, h: 600 })).toBeCloseTo(0.2);
    expect(fitScale({ w: 1000, h: 4000 }, { w: 800, h: 600 })).toBeCloseTo(0.15);
  });

  it("never enlarges small images unless asked", () => {
    expect(fitScale({ w: 200, h: 100 }, { w: 800, h: 600 })).toBe(1);
    expect(fitScale({ w: 200, h: 100 }, { w: 800, h: 600 }, 0, true)).toBe(4);
  });

  it("accounts for quarter-turn rotations", () => {
    expect(rotatedSize({ w: 4, h: 3 }, 1)).toEqual({ w: 3, h: 4 });
    expect(rotatedSize({ w: 4, h: 3 }, 2)).toEqual({ w: 4, h: 3 });
    expect(rotatedSize({ w: 4, h: 3 }, -1)).toEqual({ w: 3, h: 4 });
    expect(fitScale({ w: 4000, h: 3000 }, { w: 800, h: 600 }, 1)).toBeCloseTo(0.15);
  });

  it("handles degenerate sizes", () => {
    expect(fitScale({ w: 0, h: 0 }, { w: 800, h: 600 })).toBe(1);
    expect(fitScale({ w: 100, h: 100 }, { w: 0, h: 0 })).toBe(1);
  });
});

describe("limits", () => {
  it("clamps between a fraction of fit and the maximum", () => {
    expect(minScale(1)).toBe(0.1);
    expect(minScale(0.05)).toBeCloseTo(0.005);
    expect(clampScale(1000, 1)).toBe(MAX_SCALE);
    expect(clampScale(0.0001, 0.5)).toBeCloseTo(0.05);
  });
});

describe("zoomAround", () => {
  it("keeps the point under the cursor fixed", () => {
    const view = { scale: 1, x: 0, y: 0 };
    const anchor = { x: 100, y: -50 };
    const next = zoomAround(view, 2, anchor);
    const before = { x: (anchor.x - view.x) / view.scale, y: (anchor.y - view.y) / view.scale };
    const after = { x: (anchor.x - next.x) / next.scale, y: (anchor.y - next.y) / next.scale };
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("zooming around the centre keeps the image centred", () => {
    expect(zoomAround({ scale: 1, x: 0, y: 0 }, 3, { x: 0, y: 0 })).toEqual({ scale: 3, x: 0, y: 0 });
  });
});

describe("clampPan", () => {
  it("centres images smaller than the viewport", () => {
    expect(clampPan({ scale: 0.1, x: 300, y: -200 }, { w: 1000, h: 1000 }, { w: 800, h: 600 })).toEqual({ scale: 0.1, x: 0, y: 0 });
  });

  it("prevents gaps at the edges of large images", () => {
    // Displayed 2000x1000 in an 800x600 viewport: x within +-600, y within +-200.
    const v = clampPan({ scale: 1, x: 5000, y: -5000 }, { w: 2000, h: 1000 }, { w: 800, h: 600 });
    expect(v).toEqual({ scale: 1, x: 600, y: -200 });
  });

  it("uses the rotated size", () => {
    const v = clampPan({ scale: 1, x: 5000, y: 5000 }, { w: 2000, h: 1000 }, { w: 800, h: 600 }, 1);
    expect(v).toEqual({ scale: 1, x: 100, y: 700 });
  });
});

describe("zoom steps and slider", () => {
  it("steps through presets in both directions", () => {
    expect(stepScale(1, 1)).toBe(1.25);
    expect(stepScale(1, -1)).toBe(0.75);
    expect(stepScale(0.9, 1)).toBe(1);
    expect(stepScale(0.9, -1)).toBe(0.75);
    expect(stepScale(MAX_SCALE, 1)).toBe(MAX_SCALE);
    expect(stepScale(0.001, -1)).toBe(0.02);
  });

  it("maps the slider logarithmically and reversibly", () => {
    const min = 0.05;
    expect(sliderToScale(0, min)).toBeCloseTo(min);
    expect(sliderToScale(1, min)).toBeCloseTo(MAX_SCALE);
    for (const s of [0.1, 0.5, 1, 4, 20]) expect(sliderToScale(scaleToSlider(s, min), min)).toBeCloseTo(s);
  });

  it("converts wheel deltas into gentle zoom factors", () => {
    expect(wheelFactor(-100, 0)).toBeGreaterThan(1);
    expect(wheelFactor(100, 0)).toBeLessThan(1);
    expect(wheelFactor(-3, 1)).toBeCloseTo(wheelFactor(-99, 0));
    expect(wheelFactor(-100000, 0)).toBeLessThan(1.5);
  });

  it("formats percentages", () => {
    expect(formatPercent(1)).toBe("100%");
    expect(formatPercent(0.125)).toBe("13%");
    expect(formatPercent(0.05)).toBe("5%");
    expect(formatPercent(0.025)).toBe("2.5%");
  });
});

describe("zoom kept between pictures", () => {
  const vp = { w: 1000, h: 800 };

  it("keeps the scale and the offset when the next picture allows it", () => {
    const img = { w: 4000, h: 3000 };
    const fit = fitScale(img, vp);
    expect(keptView({ scale: 2, x: 300, y: -200 }, fit, img, vp)).toEqual({ scale: 2, x: 300, y: -200 });
  });

  it("clamps the offset so the next picture still fills the view", () => {
    const img = { w: 1200, h: 900 };
    // At 100% the picture overflows by 200 x 100: at most 100 x 50 off centre.
    expect(keptView({ scale: 1, x: 900, y: -900 }, fitScale(img, vp), img, vp)).toEqual({ scale: 1, x: 100, y: -50 });
  });

  it("centres a picture smaller than the view and respects the zoom limits", () => {
    const small = { w: 200, h: 100 };
    const v = keptView({ scale: 2, x: 500, y: 500 }, fitScale(small, vp), small, vp);
    expect(v).toEqual({ scale: 2, x: 0, y: 0 });
    const huge = { w: 40000, h: 30000 };
    expect(keptView({ scale: 64, x: 0, y: 0 }, fitScale(huge, vp), huge, vp).scale).toBe(32);
  });

  it("uses the rotated size of the next picture", () => {
    const img = { w: 1200, h: 900 };
    // Rotated: 900 x 1200, so it overflows vertically only.
    expect(keptView({ scale: 1, x: 300, y: 300 }, fitScale(img, vp, 1), img, vp, 1)).toEqual({ scale: 1, x: 0, y: 200 });
  });
});
