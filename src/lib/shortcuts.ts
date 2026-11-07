export type Action =
  | "prev"
  | "next"
  | "first"
  | "last"
  | "space"
  | "zoomIn"
  | "zoomOut"
  | "fit"
  | "actual"
  | "open"
  | "openFolder"
  | "print"
  | "save"
  | "saveAs"
  | "delete"
  | "fullscreen"
  | "slideshow"
  | "escape"
  | "rotateRight"
  | "rotateLeft"
  | "info"
  | "shortcuts"
  | "closeImage"
  | "copy";

export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * Maps a key press to an action. Digits use physical key codes so Ctrl+0 / Ctrl+1 also
 * work on AZERTY keyboards, where the unshifted key produces "à" or "&".
 */
export function actionFor(e: KeyLike): Action | null {
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

  if (ctrl && !e.altKey) {
    if (e.code === "Digit0" || e.code === "Numpad0") return "fit";
    if (e.code === "Digit1" || e.code === "Numpad1") return "actual";
    if (key === "o") return e.shiftKey ? "openFolder" : "open";
    if (key === "p") return "print";
    if (key === "s") return e.shiftKey ? "saveAs" : "save";
    if (key === "i") return "info";
    if (key === "w") return "closeImage";
    if (key === "c" && !e.shiftKey) return "copy";
    // Windows Photo Viewer's own rotation shortcuts.
    if (key === "." || e.code === "Period") return "rotateRight";
    if (key === "," || e.code === "Comma") return "rotateLeft";
    if (key === "+" || key === "=" || e.code === "NumpadAdd") return "zoomIn";
    if (key === "-" || e.code === "NumpadSubtract") return "zoomOut";
    return null;
  }
  if (e.altKey) {
    return e.key === "Enter" ? "info" : null;
  }

  switch (e.key) {
    case "ArrowLeft":
    case "PageUp":
      return "prev";
    case "ArrowRight":
    case "PageDown":
      return "next";
    case "Home":
      return "first";
    case "End":
      return "last";
    case " ":
    case "Spacebar":
      return "space";
    case "Delete":
      return "delete";
    case "F11":
      return "fullscreen";
    case "F5":
      return "slideshow";
    case "F1":
      return "shortcuts";
    case "Escape":
      return "escape";
  }
  if (key === "+" || key === "=" || e.code === "NumpadAdd") return "zoomIn";
  if (key === "-" || key === "_" || e.code === "NumpadSubtract") return "zoomOut";
  if (key === "r") return e.shiftKey ? "rotateLeft" : "rotateRight";
  return null;
}

/** True when the key press is aimed at a text field and must not trigger shortcuts. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== "string") return false;
  const el = target as HTMLElement;
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea" || tag === "select" || el.isContentEditable) return true;
  if (tag === "input") {
    const type = ((el as HTMLInputElement).type || "text").toLowerCase();
    return !["checkbox", "radio", "range", "button", "submit"].includes(type);
  }
  return false;
}
