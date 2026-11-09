import { describe, expect, it } from "vitest";
import { actionFor, type KeyLike } from "./shortcuts";

const key = (k: string, extra: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  code: "",
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...extra,
});

describe("keyboard shortcuts", () => {
  it("maps the documented keys", () => {
    expect(actionFor(key("ArrowLeft"))).toBe("prev");
    expect(actionFor(key("ArrowRight"))).toBe("next");
    expect(actionFor(key(" "))).toBe("space");
    expect(actionFor(key("+"))).toBe("zoomIn");
    expect(actionFor(key("="))).toBe("zoomIn");
    expect(actionFor(key("-"))).toBe("zoomOut");
    expect(actionFor(key("Delete"))).toBe("delete");
    expect(actionFor(key("F11"))).toBe("fullscreen");
    expect(actionFor(key("Escape"))).toBe("escape");
    expect(actionFor(key("r"))).toBe("rotateRight");
    expect(actionFor(key("R", { shiftKey: true }))).toBe("rotateLeft");
    expect(actionFor(key("e"))).toBe("edit");
  });

  it("maps Ctrl combinations", () => {
    expect(actionFor(key("0", { ctrlKey: true, code: "Digit0" }))).toBe("fit");
    expect(actionFor(key("1", { ctrlKey: true, code: "Digit1" }))).toBe("actual");
    expect(actionFor(key("o", { ctrlKey: true }))).toBe("open");
    expect(actionFor(key("O", { ctrlKey: true, shiftKey: true }))).toBe("openFolder");
    expect(actionFor(key("p", { ctrlKey: true }))).toBe("print");
    expect(actionFor(key("s", { ctrlKey: true }))).toBe("save");
    expect(actionFor(key("S", { ctrlKey: true, shiftKey: true }))).toBe("saveAs");
    expect(actionFor(key("c", { ctrlKey: true }))).toBe("copy");
  });

  it("works with AZERTY digits (Ctrl+à / Ctrl+&)", () => {
    expect(actionFor(key("à", { ctrlKey: true, code: "Digit0" }))).toBe("fit");
    expect(actionFor(key("&", { ctrlKey: true, code: "Digit1" }))).toBe("actual");
  });

  it("leaves unrelated keys alone", () => {
    expect(actionFor(key("r", { ctrlKey: true }))).toBeNull();
    expect(actionFor(key("a"))).toBeNull();
    expect(actionFor(key("Enter", { altKey: true }))).toBe("info");
  });
});
