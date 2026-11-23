// İş B: "Uzantılar" menu of the Tarayıcı panel. Developer (unpacked) extensions are folders on the engine
// machine, loaded into the project's Chrome by the engine and re-loaded on every start. Web Store extensions are
// installed once in the profile's own Chrome window: the install prompt is Chrome UI, not page content, so it
// never shows in the streamed panel. Gizli tarayıcı: the browser runs hidden on the engine machine's screen; the
// "<machine> ekranında göster" toggle here shows its real window for such Chrome UI (the project's browser.window).
import type { BrowserExtension, BrowserWindowMode } from "@kokpit/shared";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import type { EngineClient } from "../engine/types.ts";
import { errorMessage, isDisconnected } from "./errors.ts";
import { browserWindowHint, browserWindowLabel } from "./browser-window.ts";
import { useT } from "../../i18n/index.ts";

export interface BrowserExtensionsProps {
  client: EngineClient;
  projectId: string;
  /** The browser is running (only then there is a window to bring to front). */
  running: boolean;
  /** The project's window mode on the engine machine's screen (absent in the project = "hidden"). */
  window: BrowserWindowMode;
  /** The engine machine's name, for the labels ("Mac mini"). */
  machineName: string;
}

export function BrowserExtensions({ client, projectId, running, window: savedWindow, machineName }: BrowserExtensionsProps) {
  const t = useT();
  const toggleId = useId();
  // Shown at once; the project's own value (a projects.changed later) wins when it arrives.
  const [windowMode, setWindowMode] = useState(savedWindow);
  useEffect(() => setWindowMode(savedWindow), [savedWindow]);
  const headingId = useId();
  const inputId = useId();
  const [list, setList] = useState<BrowserExtension[] | null>(null);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setList((await client.request("browser.extensions.list", { projectId })).extensions);
    } catch (err) {
      if (!isDisconnected(err)) setError(errorMessage(err));
    }
  }, [client, projectId]);

  // The running Chrome is the source of "yüklü": re-read when it starts or stops.
  useEffect(() => {
    void refresh();
  }, [refresh, running]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const load = (e: FormEvent) => {
    e.preventDefault();
    const dir = path.trim();
    if (!dir.startsWith("/")) {
      setError(t("browser.extensions.needAbsolutePath"));
      return;
    }
    void run(async () => {
      setList((await client.request("browser.extensions.loadUnpacked", { projectId, path: dir })).extensions);
      setPath("");
    });
  };

  const remove = (dir: string) =>
    void run(async () => {
      setList((await client.request("browser.extensions.remove", { projectId, path: dir })).extensions);
    });

  const show = () =>
    void run(async () => {
      await client.request("browser.showWindow", { projectId });
    });

  /** The engine restarts a running browser in the new mode (its tabs come back). */
  const toggleWindow = (visible: boolean) => {
    const next: BrowserWindowMode = visible ? "visible" : "hidden";
    const before = windowMode;
    setWindowMode(next);
    void run(async () => {
      try {
        await client.request("projects.update", { projectId, browser: { runOn: "engine", window: next } });
      } catch (err) {
        setWindowMode(before);
        throw err;
      }
    });
  };
  const showLabel = browserWindowLabel(machineName);

  return (
    <section className="kp-browser__ext" aria-labelledby={headingId}>
      <h4 id={headingId} className="kp-browser__ext-title">
        {t("browser.extensions.title")}
      </h4>
      {list !== null && list.length === 0 && <p className="kp-browser__note">{t("browser.extensions.none")}</p>}
      {list !== null && list.length > 0 && (
        <ul className="kp-browser__ext-list">
          {list.map((x) => {
            const label = x.name ?? x.path;
            return (
              <li key={x.path} className="kp-browser__ext-item">
                <span className="kp-browser__ext-name" title={x.path}>
                  {label}
                  {x.version !== undefined && <span className="kp-browser__note"> {x.version}</span>}
                </span>
                {x.name !== undefined && <span className="kp-browser__note kp-browser__ext-path">{x.path}</span>}
                <span className="kp-browser__note">{x.loaded ? t("browser.extensions.loaded") : x.error ? t("browser.extensions.notLoaded", { error: x.error }) : t("browser.extensions.loadsOnOpen")}</span>
                <button type="button" className="kp-btn kp-btn--quiet" aria-label={t("browser.extensions.removeFor", { label })} disabled={busy} onClick={() => remove(x.path)}>
                  {t("browser.extensions.remove")}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <form className="kp-browser__ext-form" onSubmit={load}>
        <label htmlFor={inputId} className="kp-browser__note">
          {t("browser.extensions.folder")}
        </label>
        <input
          id={inputId}
          className="kp-input kp-input--mono"
          value={path}
          placeholder={t("browser.extensions.folderPlaceholder")}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setPath(e.target.value)}
        />
        <button type="submit" className="kp-btn" disabled={busy}>
          {t("browser.extensions.load")}
        </button>
      </form>
      {error && (
        <p role="alert" className="kp-error">
          {error}
        </p>
      )}
      <p className="kp-browser__note">
        {t("browser.extensions.webStoreNote", { label: showLabel, machine: machineName })}
      </p>
      <div className="kp-browser__actions">
        <label className="kp-radio" htmlFor={toggleId} title={browserWindowHint()}>
          <input
            id={toggleId}
            type="checkbox"
            checked={windowMode === "visible"}
            disabled={busy}
            onChange={(e) => toggleWindow(e.target.checked)}
          />
          {showLabel}
        </label>
        {running && windowMode === "visible" && (
          <button type="button" className="kp-btn" disabled={busy} onClick={show}>
            {t("browser.extensions.bringToFront")}
          </button>
        )}
      </div>
    </section>
  );
}
