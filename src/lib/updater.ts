// In-app updates: checks the latest GitHub release (signed latest.json), downloads and
// installs it. Windows runs the installer passively and restarts; an AppImage replaces
// itself and relaunches. Linux .deb/.rpm installs belong to the package manager, so for
// those we only announce the update and link to the release page.

import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

export const RELEASES_URL = "https://github.com/BigFatDeuce/Chud-Image/releases/latest";

export type UpdatePhase =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "upToDate"; checkedAt: number }
  | { phase: "available"; version: string; notes: string }
  | { phase: "downloading"; version: string; progress: number | null }
  | { phase: "installing"; version: string }
  | { phase: "error"; message: string };

export interface Updater {
  state: UpdatePhase;
  /** False for Linux .deb/.rpm installs: updates come from the package manager. */
  canInstall: boolean;
  checkNow: (silent?: boolean) => Promise<void>;
  install: () => Promise<void>;
}

/** Delay before the automatic check, so it never competes with opening the first photo. */
const STARTUP_DELAY = 4000;
/** Long sessions get re-checked now and then. */
const RECHECK_EVERY = 6 * 60 * 60 * 1000;

export function useUpdater(autoCheck: boolean, ready: boolean): Updater {
  const [state, setState] = useState<UpdatePhase>({ phase: "idle" });
  const [canInstall, setCanInstall] = useState(true);
  const update = useRef<Update | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    api.installKind().then((k) => setCanInstall(k !== "package")).catch(() => undefined);
  }, []);

  const checkNow = useCallback(async (silent = false) => {
    if (busy.current) return;
    busy.current = true;
    if (!silent) setState({ phase: "checking" });
    try {
      const found = await check({ timeout: 20_000 });
      update.current = found;
      if (found) {
        setState({ phase: "available", version: found.version, notes: found.body?.trim() ?? "" });
      } else if (!silent) {
        setState({ phase: "upToDate", checkedAt: Date.now() });
      } else {
        setState((s) => (s.phase === "idle" || s.phase === "error" ? { phase: "upToDate", checkedAt: Date.now() } : s));
      }
    } catch (e) {
      // A silent background check never bothers anyone (offline, GitHub down…).
      if (!silent) setState({ phase: "error", message: String(e) });
    } finally {
      busy.current = false;
    }
  }, []);

  const install = useCallback(async () => {
    const found = update.current;
    if (!found || busy.current) return;
    busy.current = true;
    let total = 0;
    let received = 0;
    setState({ phase: "downloading", version: found.version, progress: null });
    try {
      await found.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          received += event.data.chunkLength;
          setState({ phase: "downloading", version: found.version, progress: total ? received / total : null });
        } else if (event.event === "Finished") {
          setState({ phase: "installing", version: found.version });
        }
      });
      // Windows quits by itself to run the installer; elsewhere restart into the new version.
      await relaunch();
    } catch (e) {
      setState({ phase: "error", message: String(e) });
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    if (!autoCheck || !ready) return;
    const first = window.setTimeout(() => void checkNow(true), STARTUP_DELAY);
    const again = window.setInterval(() => void checkNow(true), RECHECK_EVERY);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(again);
    };
  }, [autoCheck, ready, checkNow]);

  return { state, canInstall, checkNow, install };
}
