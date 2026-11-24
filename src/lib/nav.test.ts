import { describe, expect, it } from "vitest";
import { dirName, extension, fileName, indexAfterRemoval, joinPath, relocate, sameFolder, stepIndex } from "./nav";

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

describe("folder of a path (regression IMG-02)", () => {
  it("keeps the root of POSIX and Windows paths", () => {
    expect(dirName("/photo.jpg")).toBe("/");
    expect(dirName("C:\\photo.jpg")).toBe("C:\\");
    expect(dirName("C:/photo.jpg")).toBe("C:/");
  });

  it("handles nested, UNC and relative paths", () => {
    expect(dirName("/home/me/Pictures/été.jpg")).toBe("/home/me/Pictures");
    expect(dirName("C:\\Users\\me\\a.png")).toBe("C:\\Users\\me");
    expect(dirName("\\\\nas\\share\\a.png")).toBe("\\\\nas\\share");
    expect(dirName("photo.jpg")).toBe(".");
    expect(dirName("sub/photo.jpg")).toBe("sub");
  });

  it("treats a backslash in a Linux file name as part of the name", () => {
    expect(dirName("/home/me/odd\\name.jpg")).toBe("/home/me");
    expect(fileName("/home/me/odd\\name.jpg")).toBe("odd\\name.jpg");
  });

  it("joins without doubling separators", () => {
    expect(joinPath("/", "a.jpg")).toBe("/a.jpg");
    expect(joinPath("C:\\", "a.jpg")).toBe("C:\\a.jpg");
    expect(joinPath("C:\\Photos", "a.jpg")).toBe("C:\\Photos\\a.jpg");
    expect(joinPath("/home/me", "a.jpg")).toBe("/home/me/a.jpg");
    expect(joinPath("\\\\nas\\share", "a.jpg")).toBe("\\\\nas\\share\\a.jpg");
    expect(joinPath(dirName("/photo.jpg"), "photo-edit.jpg")).toBe("/photo-edit.jpg");
  });

  it("compares folders regardless of a trailing separator", () => {
    expect(sameFolder(dirName("C:\\x.jpg"), "C:\\")).toBe(true);
    expect(sameFolder("/home/me/", "/home/me")).toBe(true);
    expect(sameFolder("/home/me", "/home/you")).toBe(false);
  });
});
