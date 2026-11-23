// İş C — Harita: the project's graphify map, framed from the engine in a sandboxed iframe.
//
// Isolation: `sandbox="allow-scripts"` without `allow-same-origin` gives the map an opaque origin, so it
// can run its own scripts but cannot reach this page (window.kokpit, DOM, storage), open popups or
// navigate the app. The engine also sends `Content-Security-Policy: sandbox …` with the file, and the
// Electron preload only runs in the main frame.
import type { MapInfo, Project } from "@kokpit/shared";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { PanelTitle } from "./PanelTitle.tsx";
import type { EngineClient } from "../engine/types.ts";
import { intlLocale, t as translate, useT } from "../../i18n/index.ts";
import { errorMessage, isDisconnected } from "./errors.ts";
import { whenConnected } from "./hooks/when-connected.ts";
import { mapFrameUrl } from "./map-url.ts";

export interface MapPanelProps {
  client: EngineClient;
  project: Project;
  /** ws:// address of the engine; the map is served on the same host and port. */
  engineUrl: string | undefined;
  /** Opens a project terminal running `command`; rejects with the engine error. */
  onUpdate(command: string): Promise<void>;
}

const SANDBOX = "allow-scripts";

/** Identity of the map file; a new token is fetched only when this changes. */
const mapKey = (info: MapInfo): string | null => (info.available ? `${info.file ?? ""}@${info.generatedAt ?? ""}` : null);

export function MapPanel({ client, project, engineUrl, onUpdate }: MapPanelProps) {
  const t = useT();
  const titleId = useId();
  const projectId = project.id;
  const [info, setInfo] = useState<MapInfo | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const [updating, setUpdating] = useState(false);
  const loadedKey = useRef<string | null>(null);

  const engineUrlRef = useRef(engineUrl);
  engineUrlRef.current = engineUrl;

  useEffect(() => {
    let disposed = false;
    loadedKey.current = null;
    setInfo(null);
    setSrc(null);
    setError(null);

    const check = async (): Promise<void> => {
      try {
        const next = await client.request("map.info", { projectId });
        if (disposed) return;
        setInfo(next);
        const key = mapKey(next);
        if (key === null) {
          loadedKey.current = null;
          setSrc(null);
          setError(null);
          return;
        }
        if (key === loadedKey.current) return;
        const { path } = await client.request("map.token", { projectId });
        if (disposed) return;
        const url = mapFrameUrl(engineUrlRef.current, path);
        if (!url) {
          setSrc(null);
          setError(translate("map.badUrl"));
          return;
        }
        loadedKey.current = key;
        setSrc(url);
        setError(null);
      } catch (err) {
        if (!disposed && !isDisconnected(err)) setError(translate("map.openFailed", { error: errorMessage(err) }));
      }
    };

    const offConnected = whenConnected(client, check);
    // A finished `/graphify` run ends its terminal: look again then.
    const offEvent = client.onEvent((e) => {
      if (e.name === "terminals.changed" && e.projectId === projectId) void check();
    });
    return () => {
      disposed = true;
      offConnected();
      offEvent();
    };
  }, [client, projectId]);

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setFull(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [full]);

  const update = useCallback(async (): Promise<void> => {
    if (!info?.updateCommand || updating) return;
    setUpdating(true);
    setError(null);
    try {
      await onUpdate(info.updateCommand);
    } catch (err) {
      setError(translate("map.terminalFailed", { error: errorMessage(err) }));
    } finally {
      setUpdating(false);
    }
  }, [info, onUpdate, updating]);

  const generated = info?.available && info.generatedAt ? new Date(info.generatedAt).toLocaleString(intlLocale()) : null;

  return (
    <section className={`kp-panel kp-map${full ? " kp-map--full" : ""}`} aria-labelledby={titleId}>
      <PanelTitle id={titleId}>{t("map.title")}</PanelTitle>
      {(generated || src || info?.updateCommand) && (
        <div className="kp-panel__bar">
          {generated && <span className="kp-map__meta">{generated}</span>}
          <span className="kp-panel__actions">
            {src && (
              <button type="button" className="kp-btn" aria-pressed={full} onClick={() => setFull((f) => !f)}>
                {full ? t("map.exitFullScreen") : t("map.fullScreen")}
              </button>
            )}
            {info?.updateCommand && (
              <button type="button" className="kp-btn kp-btn--primary" disabled={updating} onClick={() => void update()}>
                {t("map.update")}
              </button>
            )}
          </span>
        </div>
      )}
      {error && (
        <p role="alert" className="kp-error">
          {error}
        </p>
      )}
      {src ? (
        <iframe className="kp-map__frame" title={t("map.title")} src={src} sandbox={SANDBOX} referrerPolicy="no-referrer" />
      ) : (
        info &&
        !info.available && (
          <div className="kp-placeholder__body">
            <p className="kp-map__hint">
              {t("map.emptyLead")} <strong>{t("map.update")}</strong> {t("map.emptyTail")}
            </p>
            {info.updateCommand && <code className="kp-map__cmd">{info.updateCommand}</code>}
          </div>
        )
      )}
    </section>
  );
}
