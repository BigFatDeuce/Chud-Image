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

export function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function dirName(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : path;
}

export function extension(path: string): string {
  const name = fileName(path);
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}
