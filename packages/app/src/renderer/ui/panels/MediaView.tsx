// Dosyalar — medya: one video, sound, picture or PDF of the project, streamed from the engine.
//
// The file never passes through the WebSocket: `files.mediaUrl` answers a short-lived URL on the engine's HTTP
// listener that serves exactly this file (with Range, so seeking works), and the element below loads it. The URL
// belongs to this view: it is given back (`files.mediaRevoke`) when the view closes or shows another file, and the
// engine drops it when the connection does.
//
// Isolation: <video>, <audio> and <img> only decode — they run nothing (an SVG inside <img> has no scripts and no
// network). A PDF is shown by Chromium's built-in viewer in a frame of the engine's origin: it cannot reach this
// page, the main process lets that frame load nothing but a media URL, and the engine answers it as
// `application/pdf` with `nosniff` and a sandboxing policy. (The frame has no `sandbox` attribute: Chromium does
// not start its PDF viewer in a sandboxed frame.)
import { FILES_MEDIA_PDF_FRAGMENT, type FileMediaKind } from "@kokpit/shared";
import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from "react";
import type { EngineClient } from "../../engine/types.ts";
import { t as translate, useT } from "../../../i18n/index.ts";
import type { UiConfig } from "../config.ts";
import { errorMessage, isDisconnected } from "../errors.ts";
import { whenConnected } from "../hooks/when-connected.ts";
import { formatBytes } from "./files-format.ts";
import { MEDIA_ERROR, mediaFailure, mediaFileUrl, noPictureNote } from "./files-view.ts";

export interface MediaViewProps {
  client: EngineClient;
  config: UiConfig;
  /** ws:// address of the engine; media is served on the same host and port. */
  engineUrl: string | undefined;
  target: { projectId: string } | { cardId: string };
  path: string;
  kind: FileMediaKind;
  /** Takes the keyboard when it appears (the large preview): Space then plays / pauses at once. */
  autoFocus?: boolean;
}

type State =
  | { status: "loading" }
  | { status: "ready"; url: string; mime: string; size: string }
  | { status: "failed"; message: string };

export function MediaView({ client, config, engineUrl, target, path, kind, autoFocus }: MediaViewProps) {
  const t = useT();
  const [state, setState] = useState<State>({ status: "loading" });
  const [actualSize, setActualSize] = useState(false);
  const [noPicture, setNoPicture] = useState(false);
  /** URL path the engine issued last; revoked when replaced or on unmount. */
  const issued = useRef<string | null>(null);
  /** Consecutive failures of the element since it last played (or showed) something. */
  const failures = useRef(0);
  /** Where a player was when its URL had to be replaced. */
  const resumeAt = useRef(0);
  const engineUrlRef = useRef(engineUrl);
  engineUrlRef.current = engineUrl;
  const targetKey = "cardId" in target ? `c:${target.cardId}` : `p:${target.projectId}`;
  const targetRef = useRef(target);
  targetRef.current = target;
  const alive = useRef(true);

  const revoke = useCallback((): void => {
    const old = issued.current;
    issued.current = null;
    if (old !== null) client.request("files.mediaRevoke", { path: old }).catch(() => {});
  }, [client]);

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await client.request("files.mediaUrl", { ...targetRef.current, path });
      if (!alive.current) {
        client.request("files.mediaRevoke", { path: r.path }).catch(() => {});
        return;
      }
      revoke();
      issued.current = r.path;
      const url = mediaFileUrl(engineUrlRef.current, r.path);
      setState(url ? { status: "ready", url, mime: r.mime, size: formatBytes(r.size) } : { status: "failed", message: translate("files.media.badUrl") });
    } catch (err) {
      if (alive.current && !isDisconnected(err)) setState({ status: "failed", message: errorMessage(err) });
    }
  }, [client, path, revoke]);

  useEffect(() => {
    alive.current = true;
    failures.current = 0;
    resumeAt.current = 0;
    setState({ status: "loading" });
    setActualSize(false);
    setNoPicture(false);
    // Every (re)connection needs a new URL: the engine ends a connection's URLs with it.
    const off = whenConnected(client, load);
    return () => {
      alive.current = false;
      off();
      revoke();
    };
  }, [client, targetKey, path, load, revoke]);

  /**
   * The element could not load or play. Once, ask the engine again — it re-checks the file, and an expired URL is
   * simply replaced. A second failure in a row is the file's content: say what it is.
   */
  const onFailure = (code: number | undefined, at: number): void => {
    if (state.status !== "ready") return;
    if (failures.current < config.filesMediaRetries) {
      failures.current++;
      resumeAt.current = at;
      void load();
      return;
    }
    setState({
      status: "failed",
      message: kind === "image" ? t("files.media.imageFailed") : mediaFailure(code, { kind, mime: state.mime, size: state.size }),
    });
  };

  const onPlayerError = (e: SyntheticEvent<HTMLMediaElement>): void => {
    const el = e.currentTarget;
    onFailure(el.error?.code ?? MEDIA_ERROR.network, Number.isFinite(el.currentTime) ? el.currentTime : 0);
  };
  const onMetadata = (e: SyntheticEvent<HTMLMediaElement>): void => {
    const el = e.currentTarget;
    if (resumeAt.current > 0) {
      el.currentTime = resumeAt.current;
      resumeAt.current = 0;
    }
    if (el instanceof HTMLVideoElement) setNoPicture(el.videoWidth === 0 || el.videoHeight === 0);
  };
  const onPlayable = (): void => {
    failures.current = 0;
  };
  /** Gives a player or picture the keyboard when it appears in (or is taken to) the large preview. */
  const focusWhenLarge = useCallback(
    (el: HTMLElement | null): void => {
      if (el && autoFocus) el.focus({ preventScroll: true });
    },
    [autoFocus],
  );

  if (state.status === "loading") return <p className="kp-files__hint">{t("files.media.loading")}</p>;
  if (state.status === "failed") {
    return (
      <p role="alert" className="kp-error kp-files__alert">
        {state.message}
      </p>
    );
  }

  const { url } = state;
  if (kind === "video") {
    return (
      <div className="kp-files__media">
        {noPicture && (
          <p role="alert" className="kp-error kp-files__alert">
            {noPictureNote(state)}
          </p>
        )}
        {/* Space plays / pauses while the player has focus (the element's own behaviour; nothing global is bound). */}
        <video
          key={url}
          className="kp-files__player"
          src={url}
          controls
          preload="metadata"
          playsInline
          ref={focusWhenLarge}
          tabIndex={0}
          aria-label={t("files.media.videoLabel", { path })}
          onError={onPlayerError}
          onLoadedMetadata={onMetadata}
          onCanPlay={onPlayable}
        />
      </div>
    );
  }
  if (kind === "audio") {
    return (
      <div className="kp-files__media">
        <audio
          key={url}
          className="kp-files__player kp-files__player--audio"
          src={url}
          controls
          preload="metadata"
          ref={focusWhenLarge}
          tabIndex={0}
          aria-label={t("files.media.audioLabel", { path })}
          onError={onPlayerError}
          onLoadedMetadata={onMetadata}
          onCanPlay={onPlayable}
        />
      </div>
    );
  }
  if (kind === "image") {
    return (
      <div className={`kp-files__media kp-files__media--image${actualSize ? " kp-files__media--actual" : ""}`}>
        <button
          type="button"
          className="kp-files__zoom"
          aria-pressed={actualSize}
          ref={focusWhenLarge}
          title={actualSize ? t("files.media.fit") : t("files.media.actualSize")}
          aria-label={actualSize ? t("files.media.fitImage") : t("files.media.showActualSize")}
          onClick={() => setActualSize((v) => !v)}
        >
          <img key={url} className="kp-files__image" src={url} alt={path} draggable={false} onLoad={onPlayable} onError={() => onFailure(undefined, 0)} />
        </button>
      </div>
    );
  }
  return (
    <div className="kp-files__media kp-files__media--pdf">
      {/* Without the viewer's own toolbar: it would show the URL's token as the document's name. */}
      <iframe key={url} className="kp-files__pdf" title={`PDF: ${path}`} src={`${url}${FILES_MEDIA_PDF_FRAGMENT}`} referrerPolicy="no-referrer" />
    </div>
  );
}
