import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowDownToLine, Copy, Maximize, Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import logoTiny from "../brand/logo-tiny.svg";
import logoSmall from "../brand/logo-small.svg";
import { useI18n } from "../lib/i18n";
import { MenuBar, type Menu } from "./MenuBar";

interface Props {
  menus: Menu[];
  fileName: string | null;
  position: string | null;
  onFullscreen: () => void;
  onClose: () => void;
  /** Version number when an update is waiting; shows a pill in the title bar. */
  updateVersion?: string | null;
  onUpdate?: () => void;
}

export function TitleBar({ menus, fileName, position, onFullscreen, onClose, updateVersion, onUpdate }: Props) {
  const { t } = useI18n();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    const sync = () => win.isMaximized().then(setMaximized).catch(() => undefined);
    sync();
    win.onResized(sync).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, []);

  const win = getCurrentWindow();

  return (
    <header className="titlebar" data-tauri-drag-region onDoubleClick={(e) => {
      if ((e.target as HTMLElement).hasAttribute("data-tauri-drag-region")) win.toggleMaximize();
    }}>
      <img className="titlebar-logo" src={logoTiny} srcSet={`${logoTiny} 1x, ${logoSmall} 1.5x`} alt="" draggable={false} />
      <MenuBar menus={menus} />
      <div className="titlebar-title" data-tauri-drag-region>
        {fileName ? (
          <>
            <span className="title-file" data-tauri-drag-region>{fileName}</span>
            {position && <span className="title-pos" data-tauri-drag-region>{position}</span>}
            <span className="title-app" data-tauri-drag-region>— {t("app.name")}</span>
          </>
        ) : (
          <span className="title-file" data-tauri-drag-region>{t("app.name")}</span>
        )}
      </div>
      <div className="window-controls">
        {updateVersion && (
          <button className="update-pill" onClick={onUpdate} data-tip={t("update.available", { v: updateVersion })} data-tip-pos="below">
            <ArrowDownToLine size={13} strokeWidth={2.2} />
            {t("update.badge")}
          </button>
        )}
        <button className="wc-btn" onClick={onFullscreen} data-tip={`${t("win.fullscreen")} (F11)`} data-tip-pos="below">
          <Maximize size={14} strokeWidth={1.8} />
        </button>
        <button className="wc-btn" onClick={() => win.minimize()} aria-label={t("win.minimize")}>
          <Minus size={16} strokeWidth={1.5} />
        </button>
        <button className="wc-btn" onClick={() => win.toggleMaximize()} aria-label={maximized ? t("win.restore") : t("win.maximize")}>
          {maximized ? <Copy size={13} strokeWidth={1.5} style={{ transform: "scaleX(-1)" }} /> : <Square size={12} strokeWidth={1.5} />}
        </button>
        <button className="wc-btn wc-close" onClick={onClose} aria-label={t("win.close")}>
          <X size={17} strokeWidth={1.5} />
        </button>
      </div>
    </header>
  );
}
