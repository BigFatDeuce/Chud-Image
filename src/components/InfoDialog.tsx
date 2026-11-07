import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ChevronRight, Copy, FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { api, toAppError, type ImageInfo } from "../lib/api";
import { useI18n, type Key } from "../lib/i18n";
import { Modal } from "./Modal";

export function formatBytes(n: number, lang: string): string {
  const units = lang === "fr" ? ["o", "Ko", "Mo", "Go"] : ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const num = new Intl.NumberFormat(lang, { maximumFractionDigits: i === 0 ? 0 : v < 10 ? 2 : 1 }).format(v);
  return `${num} ${units[i]}`;
}

function formatExifDate(s: string, lang: string): string {
  const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):?(\d{2})?/.exec(s);
  if (!m) return s;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
  return isNaN(d.getTime()) ? s : d.toLocaleString(lang, { dateStyle: "long", timeStyle: "short" });
}

interface Props {
  path: string;
  displayed: { w: number; h: number } | null;
  onClose: () => void;
  onToast: (text: string) => void;
}

export function InfoDialog({ path, displayed, onClose, onToast }: Props) {
  const { t, lang } = useI18n();
  const [info, setInfo] = useState<ImageInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setInfo(null);
    api
      .imageInfo(path)
      .then((i) => alive && setInfo(i))
      .catch((e) => alive && setError(t(`error.${toAppError(e).code}` as Key)));
    return () => {
      alive = false;
    };
  }, [path, t]);

  const date = (ms: number | null) => (ms ? new Date(ms).toLocaleString(lang, { dateStyle: "long", timeStyle: "short" }) : null);

  const rows = (pairs: [Key, string | null | undefined][]) =>
    pairs
      .filter(([, v]) => v)
      .map(([k, v]) => (
        <div className="info-row" key={k}>
          <dt>{t(k)}</dt>
          <dd>{v}</dd>
        </div>
      ));

  let dims: string | null = null;
  if (info) {
    // Prefer what is actually displayed (orientation applied, decoded size of RAW previews).
    const w = displayed?.w ?? info.width;
    const h = displayed?.h ?? info.height;
    if (w && h) {
      const mp = (w * h) / 1e6;
      dims = `${w} × ${h} px · ${t("info.megapixels", { n: mp.toLocaleString(lang, { maximumFractionDigits: 1 }) })}`;
    }
  }

  const camera = info ? [info.cameraMake, info.cameraModel].filter(Boolean).join(" ").replace(/^(\S+) \1 /i, "$1 ") : null;

  return (
    <Modal
      title={t("info.title")}
      onClose={onClose}
      width={520}
      className="info-dialog"
      footer={
        <>
          <button
            className="btn btn-default"
            onClick={() => navigator.clipboard.writeText(path).then(() => onToast(t("toast.copied")))}
          >
            <Copy size={14} /> {t("info.copyPath")}
          </button>
          <button className="btn btn-default" onClick={() => revealItemInDir(path)}>
            <FolderOpen size={14} /> {t("info.reveal")}
          </button>
          <button className="btn btn-primary" onClick={onClose} data-autofocus>
            {t("common.close")}
          </button>
        </>
      }
    >
      {error && <p className="info-error">{error}</p>}
      {!info && !error && <p className="muted">{t("info.loading")}</p>}
      {info && (
        <div className="info-sections">
          <section>
            <h3>{t("info.file")}</h3>
            <dl>
              {rows([
                ["info.name", info.name],
                ["info.format", info.formatName],
                ["info.size", `${formatBytes(info.fileSize, lang)} (${info.fileSize.toLocaleString(lang)} ${lang === "fr" ? "octets" : "bytes"})`],
                ["info.folder", info.folder],
                ["info.modified", date(info.modified)],
                ["info.created", date(info.created)],
              ])}
            </dl>
          </section>
          <section>
            <h3>{t("info.image")}</h3>
            <dl>
              {rows([
                ["info.dimensions", dims],
                ["info.resolution", info.dpiX ? `${Math.round(info.dpiX)} × ${Math.round(info.dpiY ?? info.dpiX)} ${t("unit.dpi")}` : null],
                ["info.colorSpace", info.colorSpace],
                ["info.orientation", info.orientation && info.orientation !== 1 ? String(info.orientation) : null],
              ])}
            </dl>
          </section>
          {(info.dateTaken || camera || info.exposureTime || info.gps) && (
            <section>
              <h3>{t("info.camera")}</h3>
              <dl>
                {rows([
                  ["info.dateTaken", info.dateTaken ? formatExifDate(info.dateTaken, lang) : null],
                  ["info.cameraModel", camera],
                  ["info.lens", info.lens],
                  ["info.exposure", info.exposureTime],
                  ["info.aperture", info.fNumber],
                  ["info.iso", info.iso],
                  ["info.focal", info.focalLength],
                  ["info.focal35", info.focalLength35mm],
                  ["info.bias", info.exposureBias],
                  ["info.flash", info.flash],
                  ["info.whiteBalance", info.whiteBalance],
                  ["info.software", info.software],
                  ["info.artist", info.artist],
                  ["info.copyright", info.copyright],
                  [
                    "info.gps",
                    info.gps
                      ? `${info.gps.latitude.toFixed(6)}, ${info.gps.longitude.toFixed(6)}${info.gps.altitude != null ? ` · ${Math.round(info.gps.altitude)} m` : ""}`
                      : null,
                  ],
                ])}
              </dl>
            </section>
          )}
          {info.exif.length > 0 ? (
            <details className="exif-all">
              <summary>
                <ChevronRight size={14} className="chev" />
                {t("info.allExif", { count: info.exif.length })}
              </summary>
              <table>
                <tbody>
                  {info.exif.map((e, i) => (
                    <tr key={i}>
                      <th title={e.group}>{e.tag}</th>
                      <td>{e.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          ) : (
            <p className="muted small">{t("info.noExif")}</p>
          )}
        </div>
      )}
    </Modal>
  );
}
