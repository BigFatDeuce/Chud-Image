import { Printer } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../lib/i18n";
import { DEFAULT_PRINT, PAPERS, placement, type PaperId, type PrintOptions } from "../lib/print";
import { Modal } from "./Modal";

interface Props {
  src: string;
  image: { w: number; h: number };
  dpi: number | null;
  onPrint: (opts: PrintOptions) => void;
  onClose: () => void;
}

let remembered: PrintOptions = DEFAULT_PRINT;

export function PrintDialog({ src, image, dpi, onPrint, onClose }: Props) {
  const { t } = useI18n();
  const [opts, setOpts] = useState<PrintOptions>(remembered);
  const set = (p: Partial<PrintOptions>) => setOpts((o) => (remembered = { ...o, ...p }));
  const layout = placement(opts, image, dpi);

  // Preview box: the page scaled into at most 250 × 300 px.
  const k = Math.min(250 / layout.page.w, 300 / layout.page.h);
  const px = (mm: number) => mm * k;

  const seg = <T extends string>(value: T, options: [T, string][], on: (v: T) => void) => (
    <div className="segmented" role="radiogroup">
      {options.map(([v, label]) => (
        <button key={v} role="radio" aria-checked={value === v} className={value === v ? "on" : ""} onClick={() => on(v)}>
          {label}
        </button>
      ))}
    </div>
  );

  return (
    <Modal
      title={t("print.title")}
      onClose={onClose}
      width={640}
      className="print-dialog"
      footer={
        <>
          <button className="btn btn-default" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn btn-primary" onClick={() => onPrint(opts)} data-autofocus>
            <Printer size={14} /> {t("print.print")}
          </button>
        </>
      }
    >
      <div className="print-layout">
        <div className="print-preview">
          <div className="paper" style={{ width: px(layout.page.w), height: px(layout.page.h) }}>
            {layout.margin > 0 && (
              <div
                className="paper-margin"
                style={{ inset: px(layout.margin) }}
              />
            )}
            <img
              src={src}
              alt=""
              style={{ left: px(layout.x), top: px(layout.y), width: px(layout.w), height: px(layout.h) }}
            />
          </div>
          <span className="paper-caption">
            {PAPERS[opts.paper].label} · {layout.page.w > layout.page.h ? t("or.landscape") : t("or.portrait")}
          </span>
        </div>
        <div className="print-options">
          <div className="field">
            <div className="field-label"><span>{t("print.paper")}</span></div>
            <select className="select" value={opts.paper} onChange={(e) => set({ paper: e.target.value as PaperId })}>
              {(Object.keys(PAPERS) as PaperId[]).map((id) => (
                <option key={id} value={id}>
                  {PAPERS[id].label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <div className="field-label"><span>{t("print.orientation")}</span></div>
            {seg(opts.orientation, [["auto", t("or.auto")], ["portrait", t("or.portrait")], ["landscape", t("or.landscape")]], (orientation) => set({ orientation }))}
          </div>
          <div className="field">
            <div className="field-label"><span>{t("print.size")}</span></div>
            {seg(opts.size, [["fit", t("size.fit")], ["actual", t("size.actual")]], (size) => set({ size }))}
          </div>
          <div className="field">
            <div className="field-label"><span>{t("print.margins")}</span></div>
            {seg(opts.margins, [["none", t("m.none")], ["narrow", t("m.narrow")], ["normal", t("m.normal")]], (margins) => set({ margins }))}
          </div>
          <p className="muted small">{t("print.note")}</p>
        </div>
      </div>
    </Modal>
  );
}
