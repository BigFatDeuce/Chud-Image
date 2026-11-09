import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Download, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../lib/i18n";
import { RELEASES_URL, type Updater } from "../lib/updater";
import { Modal } from "./Modal";

function useAppVersion() {
  const [version, setVersion] = useState("");
  useEffect(() => {
    getVersion().then(setVersion).catch(() => undefined);
  }, []);
  return version;
}

/** One line of status plus the matching action; used in Settings and in the dialog. */
export function UpdateStatus({ updater, onOpenDialog, hideAction }: { updater: Updater; onOpenDialog?: () => void; hideAction?: boolean }) {
  const { t } = useI18n();
  const version = useAppVersion();
  const s = updater.state;
  const busy = s.phase === "checking" || s.phase === "downloading" || s.phase === "installing";

  let line = "";
  if (s.phase === "checking") line = t("update.checking");
  else if (s.phase === "upToDate") line = t("update.upToDate");
  else if (s.phase === "available") line = t("update.available", { v: s.version });
  else if (s.phase === "downloading") line = t("update.downloading", { p: s.progress == null ? "" : `${Math.round(s.progress * 100)} %` });
  else if (s.phase === "installing") line = t("update.installing");
  else if (s.phase === "error") line = t("update.error");

  return (
    <div className="update-status">
      <div className="update-lines">
        <span>{t("update.current", { v: version || "…" })}</span>
        {line && <small className={s.phase === "available" ? "update-new" : s.phase === "error" ? "update-err" : ""}>{line}</small>}
        {s.phase === "downloading" && (
          <div className="progress">
            <div className={`progress-bar${s.progress == null ? " indeterminate" : ""}`} style={{ width: s.progress == null ? undefined : `${s.progress * 100}%` }} />
          </div>
        )}
      </div>
      {hideAction && (s.phase === "available" || s.phase === "downloading" || s.phase === "installing") ? null : s.phase === "available" ? (
        <button className="btn btn-primary" onClick={onOpenDialog ?? (() => void updater.install())}>
          <Download size={15} />
          {onOpenDialog ? t("update.title") : t("update.install")}
        </button>
      ) : (
        <button className="btn btn-default" disabled={busy} onClick={() => void updater.checkNow(false)}>
          <RefreshCw size={15} className={s.phase === "checking" ? "spin" : ""} />
          {t("update.check")}
        </button>
      )}
    </div>
  );
}

export function UpdateDialog({ updater, onClose }: { updater: Updater; onClose: () => void }) {
  const { t } = useI18n();
  const s = updater.state;
  const busy = s.phase === "downloading" || s.phase === "installing";
  const available = s.phase === "available";

  return (
    <Modal
      title={t("update.title")}
      onClose={busy ? () => undefined : onClose}
      width={460}
      footer={
        available ? (
          <>
            <button className="btn btn-default" onClick={onClose}>
              {t("update.later")}
            </button>
            {updater.canInstall ? (
              <button className="btn btn-primary" data-autofocus onClick={() => void updater.install()}>
                <Download size={15} />
                {t("update.install")}
              </button>
            ) : (
              <button className="btn btn-primary" data-autofocus onClick={() => void openUrl(RELEASES_URL)}>
                {t("update.download")}
              </button>
            )}
          </>
        ) : (
          <button className="btn btn-default" disabled={busy} onClick={onClose}>
            {t("common.close")}
          </button>
        )
      }
    >
      <UpdateStatus updater={updater} hideAction />
      {available && !updater.canInstall && <p className="update-hint">{t("update.packageHint")}</p>}
      {available && s.notes && (
        <div className="update-notes">
          <h3>{t("update.notes")}</h3>
          <pre>{s.notes}</pre>
        </div>
      )}
    </Modal>
  );
}
