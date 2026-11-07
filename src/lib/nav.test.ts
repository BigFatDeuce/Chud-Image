import { describe, expect, it } from "vitest";
import { dirName, extension, fileName, indexAfterRemoval, relocate, stepIndex } from "./nav";

describe("stepIndex", () => {
  it("moves inside the list", () => {
    expect(stepIndex(2, 5, 1, false)).toEqual({ index: 3, wrapped: false });
    expect(stepIndex(2, 5, -1, false)).toEqual({ index: 1, wrapped: false });
  });

  it("stops at the ends without wrapping", () => {
    expect(stepIndex(4, 5, 1, false)).toBeNull();
    expect(stepIndex(0, 5, -1, false)).toBeNull();
  });

  it("wraps around when enabled", () => {
    expect(stepIndex(4, 5, 1, true)).toEqual({ index: 0, wrapped: true });
    expect(stepIndex(0, 5, -1, true)).toEqual({ index: 4, wrapped: true });
  });

  it("does nothing with zero or one image", () => {
    expect(stepIndex(0, 0, 1, true)).toBeNull();
    expect(stepIndex(0, 1, 1, true)).toBeNull();
  });
});

describe("after deletion", () => {
  it("shows the next image, or the previous one at the end", () => {
    expect(indexAfterRemoval(2, 4)).toBe(2);
    expect(indexAfterRemoval(4, 4)).toBe(3);
    expect(indexAfterRemoval(0, 0)).toBe(-1);
  });
});

describe("relocate", () => {
  it("finds the same file after a refresh", () => {
    expect(relocate(["a", "b", "c"], "c", 0)).toBe(2);
  });
  it("falls back to the nearest position when the file vanished", () => {
    expect(relocate(["a", "b"], "z", 5)).toBe(1);
    expect(relocate([], "z", 0)).toBe(-1);
  });
});

describe("paths", () => {
  it("splits Windows and Unix paths", () => {
    expect(fileName("C:\\Photos\\Ete 2024\\IMG_01.JPG")).toBe("IMG_01.JPG");
    expect(fileName("/home/me/pic.png")).toBe("pic.png");
    expect(dirName("C:\\Photos\\a.jpg")).toBe("C:\\Photos");
    expect(dirName("/home/me/pic.png")).toBe("/home/me");
    expect(extension("/x/archive.tar.GZ")).toBe("gz");
    expect(extension("/x/.hidden")).toBe("");
  });
});
