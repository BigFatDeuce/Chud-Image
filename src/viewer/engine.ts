// The image stage: an imperative engine (outside React) that owns the <img>, zoom, pan,
// rotation, animations and transitions, so that 60 fps interactions never re-render the
// interface.

import {
  clampPan,
  clampScale,
  fitScale,
  rotatedSize,
  stepScale,
  wheelFactor,
  zoomAround,
  type Size,
} from "../lib/zoom";
import { DEFAULT_GLITCH, GlitchRenderer } from "./glitch";

export type TransitionKind = "glitch" | "fade" | "none";

export interface EngineEvents {
  onZoom(scale: number, isFit: boolean, canPan: boolean): void;
  onLoaded(size: Size): void;
  onFailed(): void;
  onLoading(loading: boolean): void;
  onWheelNavigate(dir: 1 | -1): void;
}

export interface EngineOptions {
  wheelAction: "zoom" | "navigate";
  transition: TransitionKind;
}

export interface ShowRequest {
  url: string;
  /** Tried when `url` fails (backend decoding of a format the webview rejected). */
  fallbackUrl?: string;
  /** Pending rotation, in clockwise quarter turns. */
  turns: number;
  /** Whether this change may be animated (navigation) or must be instant (open, reload). */
  transition: boolean;
  /** Draw a checkerboard behind the picture (formats that may contain transparency). */
  checker: boolean;
}

interface State {
  scale: number;
  x: number;
  y: number;
  angle: number;
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

export class ViewerEngine {
  private readonly frame: HTMLDivElement;
  private readonly fxCanvas: HTMLCanvasElement;
  private readonly fadeCanvas: HTMLCanvasElement;
  private glitch: GlitchRenderer | null | undefined;
  private img: HTMLImageElement | null = null;
  private imgUrl = "";
  private checker = false;
  private natural: Size = { w: 0, h: 0 };
  private cur: State = { scale: 1, x: 0, y: 0, angle: 0 };
  private tgt: State = { scale: 1, x: 0, y: 0, angle: 0 };
  private committedScale = 1;
  private fitMode = true;
  private animating = false;
  private raf = 0;
  private lastTime = 0;
  private loadToken = 0;
  private lastShow = 0;
  /** Bumped by every transition so a superseded one never tears down its successor. */
  private transitionGen = 0;
  private lastWheelNav = 0;
  private preloaded = new Map<string, Promise<HTMLImageElement>>();
  private drag: { id: number; sx: number; sy: number; ox: number; oy: number } | null = null;
  private readonly resizeObserver: ResizeObserver;
  private readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  private fadeTimer = 0;

  constructor(
    private readonly stage: HTMLElement,
    private readonly events: EngineEvents,
    private opts: EngineOptions,
  ) {
    this.frame = document.createElement("div");
    this.frame.className = "viewer-frame";
    this.fxCanvas = document.createElement("canvas");
    this.fxCanvas.className = "viewer-fx";
    this.fadeCanvas = document.createElement("canvas");
    this.fadeCanvas.className = "viewer-fade";
    stage.prepend(this.frame, this.fxCanvas, this.fadeCanvas);

    stage.addEventListener("wheel", this.onWheel, { passive: false });
    stage.addEventListener("pointerdown", this.onPointerDown);
    stage.addEventListener("pointermove", this.onPointerMove);
    stage.addEventListener("pointerup", this.onPointerUp);
    stage.addEventListener("pointercancel", this.onPointerUp);
    stage.addEventListener("dblclick", this.onDoubleClick);
    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(stage);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.glitch?.cancel();
    this.resizeObserver.disconnect();
    this.stage.removeEventListener("wheel", this.onWheel);
    this.stage.removeEventListener("pointerdown", this.onPointerDown);
    this.stage.removeEventListener("pointermove", this.onPointerMove);
    this.stage.removeEventListener("pointerup", this.onPointerUp);
    this.stage.removeEventListener("pointercancel", this.onPointerUp);
    this.stage.removeEventListener("dblclick", this.onDoubleClick);
    this.frame.remove();
    this.fxCanvas.remove();
    this.fadeCanvas.remove();
  }

  setOptions(opts: EngineOptions) {
    this.opts = opts;
  }

  // ---------------------------------------------------------------- geometry

  private viewport(): Size {
    return { w: this.stage.clientWidth, h: this.stage.clientHeight };
  }

  /** Image size in CSS pixels at scale 1 (one image pixel per device pixel). */
  private imageCss(): Size {
    const dpr = window.devicePixelRatio || 1;
    return { w: this.natural.w / dpr, h: this.natural.h / dpr };
  }

  private turns(): number {
    return Math.round(this.tgt.angle / 90);
  }

  private fitValue(): number {
    return fitScale(this.imageCss(), this.viewport(), this.turns());
  }

  private canPan(): boolean {
    if (!this.img) return false;
    const r = rotatedSize(this.imageCss(), this.turns());
    const vp = this.viewport();
    return r.w * this.tgt.scale > vp.w + 0.5 || r.h * this.tgt.scale > vp.h + 0.5;
  }

  private emitZoom() {
    const canPan = this.canPan();
    this.stage.classList.toggle("can-pan", canPan);
    this.events.onZoom(this.tgt.scale, this.fitMode, canPan);
  }

  // ---------------------------------------------------------------- rendering

  private commit() {
    this.committedScale = this.cur.scale;
    const css = this.imageCss();
    this.frame.style.width = `${css.w * this.committedScale}px`;
    this.frame.style.height = `${css.h * this.committedScale}px`;
    this.frame.style.willChange = "auto";
    if (this.img) this.img.style.imageRendering = this.cur.scale >= 3 ? "pixelated" : "auto";
  }

  private apply() {
    const dpr = window.devicePixelRatio || 1;
    const css = this.imageCss();
    const vp = this.viewport();
    const w = css.w * this.committedScale;
    const h = css.h * this.committedScale;
    let tx = vp.w / 2 + this.cur.x - w / 2;
    let ty = vp.h / 2 + this.cur.y - h / 2;
    if (!this.animating) {
      tx = Math.round(tx * dpr) / dpr;
      ty = Math.round(ty * dpr) / dpr;
    }
    const ratio = this.cur.scale / this.committedScale;
    this.frame.style.transform = `translate(${tx}px, ${ty}px) rotate(${this.cur.angle}deg) scale(${ratio})`;
  }

  private tick = (now: number) => {
    const dt = Math.min(0.05, Math.max(0.001, (now - this.lastTime) / 1000));
    this.lastTime = now;
    const k = 1 - Math.exp(-dt * 18);
    const c = this.cur;
    const t = this.tgt;
    c.scale = Math.exp(lerp(Math.log(c.scale), Math.log(t.scale), k));
    c.x = lerp(c.x, t.x, k);
    c.y = lerp(c.y, t.y, k);
    c.angle = lerp(c.angle, t.angle, k);
    const settled =
      Math.abs(Math.log(c.scale / t.scale)) < 0.002 &&
      Math.abs(c.x - t.x) < 0.3 &&
      Math.abs(c.y - t.y) < 0.3 &&
      Math.abs(c.angle - t.angle) < 0.05;
    if (settled) {
      this.raf = 0;
      this.animating = false;
      this.cur = { ...t };
      this.commit();
      this.apply();
      return;
    }
    this.apply();
    this.raf = requestAnimationFrame(this.tick);
  };

  private animate() {
    if (this.reducedMotion.matches) return this.jump();
    if (!this.raf) {
      this.animating = true;
      this.frame.style.willChange = "transform";
      this.lastTime = performance.now();
      this.raf = requestAnimationFrame(this.tick);
    }
  }

  private jump() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.animating = false;
    this.cur = { ...this.tgt };
    this.commit();
    this.apply();
  }

  // ---------------------------------------------------------------- zoom API

  zoomTo(scale: number, anchor?: { x: number; y: number }, animate = true) {
    if (!this.img) return;
    const vp = this.viewport();
    const fit = this.fitValue();
    const s = clampScale(scale, fit);
    const a = anchor ? { x: anchor.x - vp.w / 2, y: anchor.y - vp.h / 2 } : { x: 0, y: 0 };
    const v = clampPan(zoomAround(this.tgt, s, a), this.imageCss(), vp, this.turns());
    this.tgt = { ...this.tgt, ...v };
    this.fitMode = Math.abs(s - fit) < 1e-4;
    if (animate) this.animate();
    else this.jump();
    this.emitZoom();
  }

  /** Steps through the zoom presets, stopping at the fitted size on the way. */
  zoomStep(dir: 1 | -1, anchor?: { x: number; y: number }) {
    if (!this.img) return;
    const fit = this.fitValue();
    const current = this.tgt.scale;
    let next = stepScale(current, dir);
    if ((dir < 0 && current > fit + 1e-4 && next < fit) || (dir > 0 && current < fit - 1e-4 && next > fit)) next = fit;
    this.zoomTo(next, anchor);
  }

  fitToWindow(animate = true) {
    if (!this.img) return;
    this.tgt = { ...this.tgt, scale: this.fitValue(), x: 0, y: 0 };
    this.fitMode = true;
    if (animate) this.animate();
    else this.jump();
    this.emitZoom();
  }

  actualSize(anchor?: { x: number; y: number }) {
    this.zoomTo(1, anchor);
  }

  toggleFitActual(anchor?: { x: number; y: number }) {
    if (!this.img) return;
    const fit = this.fitValue();
    if (this.fitMode) this.zoomTo(Math.abs(fit - 1) < 1e-3 ? 2 : 1, anchor);
    else this.fitToWindow();
  }

  /** Visual rotation by `turns` clockwise quarter turns (negative = counter-clockwise). */
  rotateBy(turns: number) {
    if (!this.img) return;
    this.tgt.angle += 90 * turns;
    if (this.fitMode) {
      this.tgt = { ...this.tgt, scale: this.fitValue(), x: 0, y: 0 };
    } else {
      this.tgt = { ...this.tgt, ...clampPan(this.tgt, this.imageCss(), this.viewport(), this.turns()) };
    }
    this.animate();
    this.emitZoom();
  }

  /** Resets the rotation to an absolute number of quarter turns, without animation. */
  setTurns(turns: number) {
    if (!this.img) return;
    this.tgt.angle = turns * 90;
    this.cur.angle = this.tgt.angle;
    this.fitToWindow(false);
  }

  getScale() {
    return this.tgt.scale;
  }

  getMinScale() {
    return Math.min(0.1, this.fitValue() / 10);
  }

  currentImage(): HTMLImageElement | null {
    return this.img;
  }

  // ---------------------------------------------------------------- input

  private onWheel = (e: WheelEvent) => {
    if (!this.img) return;
    if (e.ctrlKey || this.opts.wheelAction === "zoom") {
      e.preventDefault();
      const rect = this.stage.getBoundingClientRect();
      const fit = this.fitValue();
      const current = this.tgt.scale;
      let s = current * wheelFactor(e.deltaY, e.deltaMode);
      // Pause on the fitted size and on 100 % when passing through them.
      for (const magnet of [fit, 1]) {
        if ((current > magnet + 1e-4 && s < magnet) || (current < magnet - 1e-4 && s > magnet)) s = magnet;
      }
      this.zoomTo(s, { x: e.clientX - rect.left, y: e.clientY - rect.top });
    } else {
      e.preventDefault();
      const now = performance.now();
      if (Math.abs(e.deltaY) < 4 || now - this.lastWheelNav < 220) return;
      this.lastWheelNav = now;
      this.events.onWheelNavigate(e.deltaY > 0 ? 1 : -1);
    }
  };

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || !this.img || !this.canPan()) return;
    if ((e.target as HTMLElement).closest("button, .no-pan")) return;
    this.stage.setPointerCapture(e.pointerId);
    this.drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: this.tgt.x, oy: this.tgt.y };
    this.stage.classList.add("dragging");
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    const v = clampPan(
      { scale: this.tgt.scale, x: this.drag.ox + e.clientX - this.drag.sx, y: this.drag.oy + e.clientY - this.drag.sy },
      this.imageCss(),
      this.viewport(),
      this.turns(),
    );
    this.tgt.x = this.cur.x = v.x;
    this.tgt.y = this.cur.y = v.y;
    if (!this.animating) this.apply();
  };

  private onPointerUp = (e: PointerEvent) => {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    this.drag = null;
    this.stage.classList.remove("dragging");
    if (this.stage.hasPointerCapture(e.pointerId)) this.stage.releasePointerCapture(e.pointerId);
  };

  private onDoubleClick = (e: MouseEvent) => {
    if (!this.img || (e.target as HTMLElement).closest("button, .no-pan")) return;
    const rect = this.stage.getBoundingClientRect();
    this.toggleFitActual({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  private onResize() {
    if (!this.img) return;
    if (this.fitMode) {
      this.tgt = { ...this.tgt, scale: this.fitValue(), x: 0, y: 0 };
    } else {
      this.tgt = { ...this.tgt, ...clampPan(this.tgt, this.imageCss(), this.viewport(), this.turns()) };
    }
    this.jump();
    this.emitZoom();
  }

  // ---------------------------------------------------------------- loading

  private createImage(url: string): Promise<HTMLImageElement> {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.draggable = false;
    img.src = url;
    return img.decode().then(
      () => img,
      (err) => {
        if (img.complete && img.naturalWidth > 0) return img;
        throw err;
      },
    );
  }

  private load(url: string): Promise<HTMLImageElement> {
    const cached = this.preloaded.get(url);
    if (cached) {
      this.preloaded.delete(url);
      return cached.catch(() => this.createImage(url));
    }
    return this.createImage(url);
  }

  /** Decodes upcoming pictures in the background and releases all others. */
  preload(urls: string[]) {
    const keep = new Set(urls);
    for (const [url, promise] of this.preloaded) {
      if (!keep.has(url)) {
        this.preloaded.delete(url);
        promise.then((img) => (img.src = ""), () => undefined);
      }
    }
    for (const url of urls) {
      if (url && url !== this.imgUrl && !this.preloaded.has(url)) {
        const p = this.createImage(url);
        p.catch(() => undefined);
        this.preloaded.set(url, p);
      }
    }
  }

  /** Displays a picture; resolves to false when it failed or was superseded. */
  async show(req: ShowRequest): Promise<boolean> {
    const token = ++this.loadToken;
    const spinner = window.setTimeout(() => token === this.loadToken && this.events.onLoading(true), 150);
    let img: HTMLImageElement | null = null;
    let url = req.url;
    try {
      img = await this.load(req.url);
    } catch {
      if (req.fallbackUrl && token === this.loadToken) {
        try {
          url = req.fallbackUrl;
          img = await this.load(req.fallbackUrl);
        } catch {
          img = null;
        }
      }
    }
    window.clearTimeout(spinner);
    if (token !== this.loadToken) return false;
    this.events.onLoading(false);
    if (!img) {
      this.clear(false);
      this.events.onFailed();
      return false;
    }

    // Fast navigation still glitches every time: when a glitch is already on screen the
    // next one starts from the frame being shown, so the effect chains without a gap.
    const now = performance.now();
    const rapid = now - this.lastShow < 450;
    this.lastShow = now;
    const kind: TransitionKind =
      req.transition && !this.reducedMotion.matches && this.img ? this.opts.transition : "none";
    const before = kind === "none" ? null : (kind === "glitch" && this.liveGlitchFrame()) || this.snapshot();

    this.cancelTransition();
    this.setImage(img, url, req.turns, req.checker);
    this.events.onLoaded({ w: this.natural.w, h: this.natural.h });
    if (before) void this.runTransition(kind, before, rapid);
    return true;
  }

  private setImage(img: HTMLImageElement, url: string, turns: number, checker: boolean) {
    const previous = this.img;
    if (previous && previous !== img && this.imgUrl) {
      // Keep the previous picture decoded: going back is then instant.
      this.preloaded.set(this.imgUrl, Promise.resolve(previous));
    }
    img.className = "viewer-img";
    img.alt = "";
    this.frame.replaceChildren(img);
    this.frame.classList.toggle("checker", checker);
    this.img = img;
    this.imgUrl = url;
    this.checker = checker;
    this.natural = { w: img.naturalWidth || 1024, h: img.naturalHeight || 1024 };
    this.tgt = { scale: 1, x: 0, y: 0, angle: turns * 90 };
    this.cur = { ...this.tgt };
    this.fitToWindow(false);
  }

  clear(resetToken = true) {
    if (resetToken) this.loadToken++;
    this.cancelTransition();
    this.frame.replaceChildren();
    this.img = null;
    this.imgUrl = "";
    this.stage.classList.remove("can-pan");
    this.events.onZoom(1, true, false);
  }

  // ---------------------------------------------------------------- transitions

  private checkerPattern(ctx: CanvasRenderingContext2D): CanvasPattern | string {
    const styles = getComputedStyle(this.stage);
    const a = styles.getPropertyValue("--checker-a").trim() || "#ffffff";
    const b = styles.getPropertyValue("--checker-b").trim() || "#e5e5e5";
    const tile = document.createElement("canvas");
    tile.width = tile.height = 16;
    const t = tile.getContext("2d")!;
    t.fillStyle = a;
    t.fillRect(0, 0, 16, 16);
    t.fillStyle = b;
    t.fillRect(0, 0, 8, 8);
    t.fillRect(8, 8, 8, 8);
    return ctx.createPattern(tile, "repeat") ?? a;
  }

  /** A copy of the glitch frame currently on screen, if a glitch is playing. */
  private liveGlitchFrame(): HTMLCanvasElement | null {
    const fx = this.fxCanvas;
    if (!fx.classList.contains("active") || fx.width < 2 || fx.height < 2) return null;
    const vp = this.viewport();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(vp.w * dpr);
    const h = Math.round(vp.h * dpr);
    if (w !== fx.width || h !== fx.height) return null;
    const copy = document.createElement("canvas");
    copy.width = w;
    copy.height = h;
    try {
      copy.getContext("2d")?.drawImage(fx, 0, 0);
    } catch {
      return null;
    }
    return copy;
  }

  /** Renders the stage as it currently looks into a canvas. */
  private snapshot(): HTMLCanvasElement | null {
    const vp = this.viewport();
    if (vp.w < 2 || vp.h < 2) return null;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(vp.w * dpr);
    canvas.height = Math.round(vp.h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = getComputedStyle(this.stage).backgroundColor || "#000";
    ctx.fillRect(0, 0, vp.w, vp.h);
    if (this.img) {
      const css = this.imageCss();
      const w = css.w * this.cur.scale;
      const h = css.h * this.cur.scale;
      ctx.translate(vp.w / 2 + this.cur.x, vp.h / 2 + this.cur.y);
      ctx.rotate((this.cur.angle * Math.PI) / 180);
      if (this.checker) {
        ctx.fillStyle = this.checkerPattern(ctx);
        ctx.fillRect(-w / 2, -h / 2, w, h);
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      try {
        ctx.drawImage(this.img, -w / 2, -h / 2, w, h);
      } catch {
        return null;
      }
    }
    return canvas;
  }

  private cancelTransition() {
    this.glitch?.cancel();
    this.fxCanvas.classList.remove("active");
    window.clearTimeout(this.fadeTimer);
    this.fadeCanvas.classList.remove("active", "fading");
  }

  private async runTransition(kind: TransitionKind, before: HTMLCanvasElement, rapid = false) {
    const gen = ++this.transitionGen;
    if (kind === "glitch") {
      if (this.glitch === undefined) this.glitch = GlitchRenderer.create(this.fxCanvas);
      const after = this.snapshot();
      if (this.glitch && after) {
        try {
          this.fxCanvas.classList.add("active");
          // Quicker bursts while the user is flicking through, so it never feels laggy.
          await this.glitch.play(before, after, rapid ? { ...DEFAULT_GLITCH, duration: 340 } : DEFAULT_GLITCH);
        } catch {
          // Tainted canvas or lost context: the picture is already in place.
        } finally {
          // A newer transition may already be drawing on this canvas: leave it alone.
          if (gen === this.transitionGen) this.fxCanvas.classList.remove("active");
        }
        return;
      }
    }
    // Cross-fade: the previous picture fades out over the new one.
    const c = this.fadeCanvas;
    c.width = before.width;
    c.height = before.height;
    c.getContext("2d")?.drawImage(before, 0, 0);
    c.classList.remove("fading");
    c.classList.add("active");
    void c.offsetWidth;
    c.classList.add("fading");
    this.fadeTimer = window.setTimeout(() => c.classList.remove("active", "fading"), 360);
  }
}
