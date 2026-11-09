import {
  ChevronDown,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SquarePen,
  Scan,
  Shrink,
  SkipBack,
  SkipForward,
  Trash2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../lib/i18n";
import { formatPercent, MAX_SCALE, scaleToSlider, sliderToScale } from "../lib/zoom";

interface Props {
  hasImage: boolean;
  scale: number;
  isFit: boolean;
  minScale: number;
  canPrev: boolean;
  canNext: boolean;
  slideshowActive: boolean;
  playing: boolean;
  hidden: boolean;
  onZoomStep: (dir: 1 | -1) => void;
  onZoomTo: (scale: number) => void;
  onFitToggle: () => void;
  onPrev: () => void;
  onNext: () => void;
  onPlay: () => void;
  onRotate: (turns: 1 | -1) => void;
  onDelete: () => void;
  onEdit: () => void;
}

function ZoomPopover({ scale, min, onChange, onClose }: { scale: number; min: number; onChange: (s: number) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest(".zoom-level")) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose());
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [onClose]);
  return (
    <div className="zoom-popover no-pan" ref={ref}>
      <span className="zoom-popover-max">{formatPercent(MAX_SCALE)}</span>
      <input
        className="zoom-slider"
        type="range"
        min={0}
        max={1000}
        value={Math.round(scaleToSlider(scale, min) * 1000)}
        onChange={(e) => onChange(sliderToScale(Number(e.target.value) / 1000, min))}
        aria-label="zoom"
      />
      <span className="zoom-popover-min">{formatPercent(min)}</span>
    </div>
  );
}

export function Toolbar(p: Props) {
  const { t } = useI18n();
  const [zoomOpen, setZoomOpen] = useState(false);
  const off = !p.hasImage;

  return (
    <footer className={`toolbar${p.hidden ? " is-hidden" : ""}`}>
      <div className="toolbar-inner">
        <div className="tb-group">
          <button className="tb-btn" disabled={off} onClick={() => p.onZoomStep(-1)} data-tip={`${t("tb.zoomOut")} (−)`}>
            <ZoomOut size={19} />
          </button>
          <div className="zoom-wrap">
            <button className="zoom-level" disabled={off} onClick={() => setZoomOpen((o) => !o)} data-tip={t("tb.zoomLevel")}>
              <span>{off ? "—" : formatPercent(p.scale)}</span>
              <ChevronDown size={13} strokeWidth={2.2} />
            </button>
            {zoomOpen && p.hasImage && (
              <ZoomPopover scale={p.scale} min={p.minScale} onChange={p.onZoomTo} onClose={() => setZoomOpen(false)} />
            )}
          </div>
          <button className="tb-btn" disabled={off} onClick={() => p.onZoomStep(1)} data-tip={`${t("tb.zoomIn")} (+)`}>
            <ZoomIn size={19} />
          </button>
          <button
            className="tb-btn"
            disabled={off}
            onClick={p.onFitToggle}
            data-tip={p.isFit ? `${t("tb.actual")} (Ctrl+1)` : `${t("tb.fit")} (Ctrl+0)`}
          >
            {p.isFit ? <Scan size={19} /> : <Shrink size={19} />}
          </button>
        </div>

        <div className="tb-nav">
          <button className="tb-btn tb-nav-btn" disabled={!p.canPrev} onClick={p.onPrev} data-tip={`${t("tb.prev")} (←)`}>
            <SkipBack size={19} fill="currentColor" strokeWidth={1.6} />
          </button>
          <button
            className={`tb-orb${p.playing ? " playing" : ""}`}
            disabled={off}
            onClick={p.onPlay}
            data-tip={p.playing ? `${t("tb.pause")} (${t("kb.space")})` : p.slideshowActive ? t("tb.resume") : `${t("tb.play")} (F5)`}
          >
            {p.playing ? <Pause size={20} fill="currentColor" strokeWidth={1.5} /> : <Play size={20} fill="currentColor" strokeWidth={1.5} className="orb-play" />}
          </button>
          <button className="tb-btn tb-nav-btn" disabled={!p.canNext} onClick={p.onNext} data-tip={`${t("tb.next")} (→)`}>
            <SkipForward size={19} fill="currentColor" strokeWidth={1.6} />
          </button>
        </div>

        <div className="tb-group">
          <button className="tb-btn" disabled={off} onClick={() => p.onRotate(-1)} data-tip={`${t("tb.rotateLeft")} (${t("kb.shift")}+R)`}>
            <RotateCcw size={19} />
          </button>
          <button className="tb-btn" disabled={off} onClick={() => p.onRotate(1)} data-tip={`${t("tb.rotateRight")} (R)`}>
            <RotateCw size={19} />
          </button>
          <span className="tb-sep" />
          <button className="tb-btn" disabled={off} onClick={p.onEdit} data-tip={`${t("tb.edit")} (E)`}>
            <SquarePen size={19} />
          </button>
          <button className="tb-btn tb-danger" disabled={off} onClick={p.onDelete} data-tip={`${t("tb.delete")} (${t("kb.del")})`}>
            <Trash2 size={19} />
          </button>
        </div>
      </div>
    </footer>
  );
}
