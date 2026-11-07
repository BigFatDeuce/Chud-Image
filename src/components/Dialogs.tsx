import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import logo from "../logo.svg";
import type { Settings } from "../lib/api";
import { useI18n, type Key } from "../lib/i18n";
import { Modal } from "./Modal";

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map(([v, label]) => (
        <button key={v} role="radio" aria-checked={value === v} className={value === v ? "on" : ""} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="toggle-row">
      <span>{label}</span>
      <input type="checkbox" className="toggle" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <div className="field-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      {children}
    </div>
  );
}

export function SettingsDialog({ settings, onChange, onClose }: { settings: Settings; onChange: (s: Partial<Settings>) => void; onClose: () => void }) {
  const { t } = useI18n();
  const intervals = [2, 3, 4, 5, 8, 10, 15, 30, 60];
  return (
    <Modal title={t("settings.title")} onClose={onClose} width={500} className="settings-dialog">
      <section className="settings-section">
        <h3>{t("settings.appearance")}</h3>
        <Field label={t("settings.theme")}>
          <Segmented
            value={settings.theme}
            onChange={(theme) => onChange({ theme })}
            options={[
              ["system", t("theme.system")],
              ["light", t("theme.light")],
              ["dark", t("theme.dark")],
            ]}
          />
        </Field>
        <Field label={t("settings.background")}>
          <Segmented
            value={settings.background}
            onChange={(background) => onChange({ background })}
            options={[
              ["auto", t("bg.auto")],
              ["black", t("bg.black")],
              ["gray", t("bg.gray")],
              ["white", t("bg.white")],
            ]}
          />
        </Field>
        <Field label={t("settings.language")}>
          <Segmented
            value={settings.language}
            onChange={(language) => onChange({ language })}
            options={[
              ["system", t("lang.system")],
              ["fr", "Français"],
              ["en", "English"],
            ]}
          />
        </Field>
        <Toggle label={t("settings.checker")} checked={settings.transparencyChecker} onChange={(v) => onChange({ transparencyChecker: v })} />
      </section>

      <section className="settings-section">
        <h3>{t("settings.navigation")}</h3>
        <Field label={t("settings.wheel")} hint={t("settings.wheelHint")}>
          <Segmented
            value={settings.wheelAction}
            onChange={(wheelAction) => onChange({ wheelAction })}
            options={[
              ["zoom", t("wheel.zoom")],
              ["navigate", t("wheel.navigate")],
            ]}
          />
        </Field>
        <Field label={t("settings.transition")}>
          <Segmented
            value={settings.transition}
            onChange={(transition) => onChange({ transition })}
            options={[
              ["glitch", t("tr.glitch")],
              ["fade", t("tr.fade")],
              ["none", t("tr.none")],
            ]}
          />
        </Field>
        <Toggle label={t("settings.wrap")} checked={settings.wrapNavigation} onChange={(v) => onChange({ wrapNavigation: v })} />
        <Toggle label={t("settings.confirmDelete")} checked={settings.confirmDelete} onChange={(v) => onChange({ confirmDelete: v })} />
      </section>

      <section className="settings-section">
        <h3>{t("settings.slideshow")}</h3>
        <Field label={t("settings.interval")}>
          <select className="select" value={settings.slideshowInterval} onChange={(e) => onChange({ slideshowInterval: Number(e.target.value) })}>
            {[...new Set([...intervals, settings.slideshowInterval])].sort((a, b) => a - b).map((n) => (
              <option key={n} value={n}>
                {t("seconds", { n })}
              </option>
            ))}
          </select>
        </Field>
        <Toggle label={t("settings.loop")} checked={settings.slideshowLoop} onChange={(v) => onChange({ slideshowLoop: v })} />
        <Toggle label={t("settings.autohide")} checked={settings.autohideControls} onChange={(v) => onChange({ autohideControls: v })} />
      </section>
    </Modal>
  );
}

const SHORTCUTS: [string[], Key][] = [
  [["←", "→"], "sc.prevNext"],
  [["Home", "End"], "sc.firstLast"],
  [["kb.space"], "sc.space"],
  [["+", "−"], "sc.zoom"],
  [["Ctrl", "0"], "sc.fit"],
  [["Ctrl", "1"], "sc.actual"],
  [["R", "kb.shift+R"], "sc.rotate"],
  [["Ctrl", "S"], "sc.save"],
  [["Ctrl", "kb.shift", "S"], "sc.saveAs"],
  [["Ctrl", "O"], "sc.open"],
  [["Ctrl", "P"], "sc.print"],
  [["kb.del"], "sc.delete"],
  [["Alt", "Enter"], "sc.info"],
  [["F11"], "sc.fullscreen"],
  [["F5"], "sc.slideshow"],
  [["Esc"], "sc.escape"],
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const label = (k: string) =>
    k.startsWith("kb.") ? k.split("+").map((part) => (part.startsWith("kb.") ? t(part as Key) : part)).join("+") : k;
  return (
    <Modal title={t("shortcuts.title")} onClose={onClose} width={520} className="shortcuts-dialog">
      <dl className="shortcut-list">
        {SHORTCUTS.map(([keys, desc]) => (
          <div className="shortcut-row" key={desc}>
            <dt>
              {keys.map((k, i) => (
                <kbd key={i}>{label(k)}</kbd>
              ))}
            </dt>
            <dd>{t(desc)}</dd>
          </div>
        ))}
      </dl>
      <h3 className="shortcut-sub">{t("sc.mouse")}</h3>
      <dl className="shortcut-list">
        <div className="shortcut-row">
          <dt><kbd>{t("kb.wheel")}</kbd></dt>
          <dd>{t("sc.wheel")}</dd>
        </div>
        <div className="shortcut-row">
          <dt><kbd>{t("kb.drag")}</kbd></dt>
          <dd>{t("sc.drag")}</dd>
        </div>
        <div className="shortcut-row">
          <dt><kbd>{t("kb.dblclick")}</kbd></dt>
          <dd>{t("sc.dblclick")}</dd>
        </div>
      </dl>
    </Modal>
  );
}

export function AboutDialog({ extensions, onClose }: { extensions: string[]; onClose: () => void }) {
  const { t } = useI18n();
  const [version, setVersion] = useState("");
  useEffect(() => {
    getVersion().then(setVersion).catch(() => undefined);
  }, []);
  return (
    <Modal title={t("about.title")} onClose={onClose} width={440} className="about-dialog">
      <div className="about">
        <img src={logo} alt="" className="about-logo" />
        <h2>Chud Image</h2>
        {version && <p className="muted">{t("about.version", { v: version })}</p>}
        <p>{t("about.tagline")}</p>
        <button className="btn btn-default" onClick={() => openUrl("https://github.com/BigFatDeuce/Chud-Image")}>
          <ExternalLink size={14} /> {t("about.github")}
        </button>
        <div className="about-formats">
          <h3>{t("about.formats")}</h3>
          <p>{extensions.map((e) => e.toUpperCase()).join(" · ")}</p>
        </div>
      </div>
    </Modal>
  );
}
