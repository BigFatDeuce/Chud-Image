// Print layout: paper sizes, orientation and image placement (all in millimetres).

export type PaperId = "a4" | "letter" | "legal" | "a3" | "a5" | "photo10x15" | "photo13x18";
export type PrintOrientation = "auto" | "portrait" | "landscape";
export type PrintSize = "fit" | "actual";
export type PrintMargins = "none" | "narrow" | "normal";

export interface PrintOptions {
  paper: PaperId;
  orientation: PrintOrientation;
  size: PrintSize;
  margins: PrintMargins;
}

export const PAPERS: Record<PaperId, { w: number; h: number; label: string }> = {
  a4: { w: 210, h: 297, label: "A4" },
  letter: { w: 215.9, h: 279.4, label: "Letter" },
  legal: { w: 215.9, h: 355.6, label: "Legal" },
  a3: { w: 297, h: 420, label: "A3" },
  a5: { w: 148, h: 210, label: "A5" },
  photo10x15: { w: 101.6, h: 152.4, label: "10 × 15 cm" },
  photo13x18: { w: 127, h: 178, label: "13 × 18 cm" },
};

export const DEFAULT_PRINT: PrintOptions = { paper: "a4", orientation: "auto", size: "fit", margins: "normal" };

export function marginMm(m: PrintMargins): number {
  return m === "none" ? 0 : m === "narrow" ? 6.35 : 12.7;
}

/** Page size in mm; "auto" picks the orientation that matches the picture. */
export function pageSize(opts: PrintOptions, image: { w: number; h: number }): { w: number; h: number } {
  const p = PAPERS[opts.paper];
  const short = Math.min(p.w, p.h);
  const long = Math.max(p.w, p.h);
  const landscape = opts.orientation === "landscape" || (opts.orientation === "auto" && image.w > image.h);
  return landscape ? { w: long, h: short } : { w: short, h: long };
}

/**
 * Where the picture lands on the page, in mm. It is always centred and never cropped:
 * "fit" fills the printable area, "actual" uses the file's resolution (96 ppi when
 * unknown) but still shrinks to the printable area when too large.
 */
export function placement(opts: PrintOptions, image: { w: number; h: number }, dpi: number | null) {
  const page = pageSize(opts, image);
  const m = marginMm(opts.margins);
  const area = { w: Math.max(1, page.w - 2 * m), h: Math.max(1, page.h - 2 * m) };
  let w: number;
  let h: number;
  if (opts.size === "actual") {
    const ppi = dpi && dpi > 1 ? dpi : 96;
    w = (image.w / ppi) * 25.4;
    h = (image.h / ppi) * 25.4;
  } else {
    w = area.w;
    h = (area.w * image.h) / image.w;
  }
  const k = Math.min(1, area.w / w, area.h / h);
  w *= k;
  h *= k;
  return { page, margin: m, x: (page.w - w) / 2, y: (page.h - h) / 2, w, h };
}

/** Lays the picture out in the hidden print container and opens the system print dialog. */
export async function printImage(src: string, opts: PrintOptions, image: { w: number; h: number }, dpi: number | null) {
  const layout = placement(opts, image, dpi);
  let style = document.getElementById("print-page-style") as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = "print-page-style";
    document.head.appendChild(style);
  }
  style.textContent = `@page { size: ${layout.page.w}mm ${layout.page.h}mm; margin: ${layout.margin}mm; }`;
  const root = document.getElementById("print-root")!;
  const img = new Image();
  img.src = src;
  img.style.width = `${layout.w}mm`;
  img.style.height = `${layout.h}mm`;
  root.replaceChildren(img);
  try {
    await img.decode();
  } catch {
    /* printed anyway: the browser will show what it can */
  }
  const cleanup = () => {
    root.replaceChildren();
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  window.print();
}
