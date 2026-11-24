export interface StepResult {
  index: number;
  /** True when the step went past an end and came back from the other side. */
  wrapped: boolean;
}

/**
 * Moves `delta` images from `index` in a list of `count`. Without wrapping, stepping past
 * either end returns null so the caller can simply do nothing.
 */
export function stepIndex(index: number, count: number, delta: number, wrap: boolean): StepResult | null {
  if (count <= 0) return null;
  const target = index + delta;
  if (target >= 0 && target < count) return { index: target, wrapped: false };
  if (!wrap || count === 1) return null;
  return { index: ((target % count) + count) % count, wrapped: true };
}

/** After removing the item at `removed`, which index should be shown (or -1 when empty)? */
export function indexAfterRemoval(removed: number, newCount: number): number {
  if (newCount <= 0) return -1;
  return Math.min(removed, newCount - 1);
}

/** Finds `path` in a refreshed listing, falling back to the closest previous position. */
export function relocate(files: string[], path: string | null, previousIndex: number): number {
  if (files.length === 0) return -1;
  if (path) {
    const i = files.indexOf(path);
    if (i >= 0) return i;
  }
  return Math.min(Math.max(previousIndex, 0), files.length - 1);
}

/**
 * POSIX paths (starting with "/") only use "/" as a separator: a backslash is a legal
 * character in a Linux file name. Everything else is treated as a Windows path.
 */
const isPosix = (path: string) => path.startsWith("/");
const lastSep = (path: string) => (isPosix(path) ? path.lastIndexOf("/") : Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));

export function fileName(path: string): string {
  return path.slice(lastSep(path) + 1) || path;
}

/** The folder holding `path`, keeping roots whole ("/", "C:\") and "." for a bare name. */
export function dirName(path: string): string {
  const i = lastSep(path);
  if (i < 0) return ".";
  if (i === 0) return path[0];
  // "C:\photo.jpg" → "C:\", not the drive-relative "C:".
  if (i === 2 && path[1] === ":") return path.slice(0, 3);
  return path.slice(0, i);
}

/** Appends a file name to a folder without doubling the separator. */
export function joinPath(dir: string, name: string): string {
  if (dir === "" || dir === ".") return name;
  if (/[\\/]$/.test(dir)) return dir + name;
  return dir + (isPosix(dir) || (!dir.includes("\\") && dir.includes("/")) ? "/" : "\\") + name;
}

/** Whether two folder paths name the same folder, ignoring a trailing separator. */
export function sameFolder(a: string, b: string): boolean {
  const norm = (p: string) => (p.length > 1 && /[\\/]$/.test(p) && !/^[A-Za-z]:[\\/]$/.test(p) ? p.slice(0, -1) : p);
  const x = norm(a);
  const y = norm(b);
  return isPosix(x) ? x === y : x.toLowerCase() === y.toLowerCase();
}

export function extension(path: string): string {
  const name = fileName(path);
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}
