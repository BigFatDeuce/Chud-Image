import { describe, expect, it } from "vitest";
import { annotationBounds, keepInFrame, pickAnnotation, snapMove, translateAnnotation, type Annotation } from "./model";

const red = "#ef4444";
const text: Annotation = { kind: "text", at: [100, 50], text: "Hello", color: red, size: 20 };
const rect: Annotation = { kind: "rect", a: [10, 10], b: [110, 60], color: red, size: 4 };
const pen: Annotation = { kind: "pen", points: [[0, 0], [30, 40], [60, 10]], color: red, size: 6, opacity: 1 };
const arrow: Annotation = { kind: "arrow", a: [200, 200], b: [300, 200], color: red, size: 4 };
const measure = (a: Annotation & { kind: "text" }) => ({ w: a.text.length * 10, h: a.size * 1.2 });

describe("annotation bounds", () => {
  it("covers the text box", () => {
    expect(annotationBounds(text, measure)).toEqual({ x: 100, y: 50, w: 50, h: 24 });
  });

  it("includes the thickness of lines", () => {
    expect(annotationBounds(rect)).toEqual({ x: 8, y: 8, w: 104, h: 54 });
    expect(annotationBounds(pen)).toEqual({ x: -3, y: -3, w: 66, h: 46 });
    // The arrow head is wider than the shaft.
    expect(annotationBounds(arrow).h).toBeGreaterThan(4);
  });
});

describe("moving annotations", () => {
  it("moves every point of every kind, exactly", () => {
    for (const a of [text, rect, pen, arrow]) {
      const moved = translateAnnotation(a, 12.5, -7.25);
      const b0 = annotationBounds(a, measure);
      const b1 = annotationBounds(moved, measure);
      expect(b1.x - b0.x).toBeCloseTo(12.5, 10);
      expect(b1.y - b0.y).toBeCloseTo(-7.25, 10);
      expect(b1.w).toBeCloseTo(b0.w, 10);
      expect(b1.h).toBeCloseTo(b0.h, 10);
      // Moving back gives the very same annotation: no drift after many moves.
      expect(translateAnnotation(moved, -12.5, 7.25)).toEqual(a);
    }
  });

  it("keeps colour, size and text", () => {
    const moved = translateAnnotation(text, 5, 5);
    expect(moved).toMatchObject({ kind: "text", text: "Hello", color: red, size: 20, at: [105, 55] });
  });
});

describe("picking an annotation", () => {
  const list = [rect, text, pen];

  it("finds the topmost one under the pointer", () => {
    expect(pickAnnotation(list, [120, 60], 2, measure)).toBe(1);
    expect(pickAnnotation(list, [30, 40], 2, measure)).toBe(2);
    expect(pickAnnotation(list, [500, 500], 2, measure)).toBe(-1);
  });

  it("selects a shape from its inside when nothing else is there", () => {
    expect(pickAnnotation([rect], [60, 35], 2, measure)).toBe(0);
  });

  it("prefers an outline to the inside of a shape on top", () => {
    const big: Annotation = { kind: "rect", a: [0, 0], b: [400, 400], color: red, size: 2 };
    // The pen stroke lies inside the big rectangle drawn after it.
    expect(pickAnnotation([pen, big], [30, 40], 2, measure)).toBe(0);
  });

  it("can be limited to some kinds", () => {
    expect(pickAnnotation(list, [30, 40], 2, measure, (a) => a.kind === "text")).toBe(-1);
    expect(pickAnnotation(list, [110, 55], 2, measure, (a) => a.kind === "text")).toBe(1);
  });
});

describe("snapping", () => {
  const frame = { x: 0, y: 0, w: 1000, h: 600 };
  const box = { x: 100, y: 100, w: 200, h: 100 };

  it("centres on the picture when close enough", () => {
    // Box centre would be at 498 → snaps to 500.
    const s = snapMove(box, 298, 0, frame, 5);
    expect(s.dx).toBe(300);
    expect(s.guides.x).toEqual([500]);
  });

  it("aligns edges with the picture's edges", () => {
    const s = snapMove(box, -97, 397, frame, 5);
    expect(s.dx).toBe(-100);
    expect(s.dy).toBe(400);
    expect(s.guides).toEqual({ x: [0], y: [600] });
  });

  it("does nothing when far from any guide", () => {
    expect(snapMove(box, 40, 40, frame, 5)).toEqual({ dx: 40, dy: 40, guides: { x: [], y: [] } });
  });
});

describe("staying on the picture", () => {
  const frame = { x: 0, y: 0, w: 1000, h: 600 };
  const box = { x: 100, y: 100, w: 200, h: 100 };

  it("lets an annotation hang over the edge but not leave the picture", () => {
    expect(keepInFrame(box, -10000, -10000, frame, 20)).toEqual([-280, -180]);
    expect(keepInFrame(box, 10000, 10000, frame, 20)).toEqual([880, 480]);
    expect(keepInFrame(box, 30, -40, frame, 20)).toEqual([30, -40]);
  });
});
