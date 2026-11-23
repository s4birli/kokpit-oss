// İş F — Dosyalar: the selected project's (or card's) folder on the engine machine, as a lazy tree with a
// read-only preview. The engine keeps every path inside the folder; this panel only ever sends paths it
// built from names the engine listed. Expanded folders, the selected file and the divider persist per project/card.
//
// Room: the tree and the preview never share one scrolling column. A wide panel shows them side by side; a narrow
// one (the default left column) stacks them, each scrolling on its own, with a divider between. Since a column
// that narrow cannot show a file readably, a click there opens the file in the LARGE preview, which covers the
// window until Esc / "Küçült"; in a wide panel the same is one click on ⤢ (or a double click on the file).
// Text is shown with line numbers; video, sound, pictures and PDFs stream from the engine (MediaView.tsx).
import type { Card, FileEntry, FileReadResult, Project } from "@kokpit/shared";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import type { EngineClient } from "../../engine/types.ts";
import { t as translate, useT } from "../../../i18n/index.ts";
import type { UiConfig } from "../config.ts";
import { errorMessage, isDisconnected } from "../errors.ts";
import { whenConnected } from "../hooks/when-connected.ts";
import type { PanelDefinition, PanelStateStore } from "../layout/contract.ts";
import { PanelTitle } from "../PanelTitle.tsx";
import { childPath, formatBytes, lineNumbers, utf8Length } from "./files-format.ts";
import { chooseViewer, clampSplit, filesLayout, type FilesLayout } from "./files-view.ts";
import { MediaView } from "./MediaView.tsx";
import "./files.css";
import { copyValue } from "../copy-menu.ts";

export interface FilesPanelProps {
  client: EngineClient;
  config: UiConfig;
  project: Project | null;
  card: Card | null;
  state: PanelStateStore;
  /** ws:// address of the engine; media files stream from the same host and port. */
  engineUrl?: string | undefined;
  /**
   * Yollar: a file a terminal named ("Dosyalar'da göster", a click on a path): its folders are opened, the file is
   * selected and shown large; a folder is expanded. A new `seq` repeats the request.
   */
  focus?: { filePath?: string; fileIsDir?: boolean; seq: number } | null | undefined;
}

type DirState =
  | { status: "loading" }
  | { status: "ok"; entries: FileEntry[]; truncated: boolean }
  | { status: "error"; message: string };

export type Preview = { status: "loading" } | { status: "ok"; result: FileReadResult } | { status: "error"; message: string };

const EXPANDED_KEY = "expanded";
const SELECTED_KEY = "selected";
/** The tree's share of the panel, per layout: `{ side?: number, stacked?: number }`. */
const SPLIT_KEY = "split";

function readExpanded(state: PanelStateStore): string[] {
  const v = state.get<unknown>(EXPANDED_KEY);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function readSelected(state: PanelStateStore): string | null {
  const v = state.get<unknown>(SELECTED_KEY);
  return typeof v === "string" ? v : null;
}

function readSplit(state: PanelStateStore): Partial<Record<FilesLayout, unknown>> {
  const v = state.get<unknown>(SPLIT_KEY);
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Partial<Record<FilesLayout, unknown>>) : {};
}

const isFolder = (e: FileEntry): boolean => e.kind === "dir" || e.target === "dir";
const isPreviewable = (e: FileEntry): boolean => e.kind === "file" || e.target === "file";
const isMissing = (err: unknown): boolean =>
  err instanceof Error && "code" in err && (err as { code: unknown }).code === "NOT_FOUND";

/** The folders above `path`, outermost first: "a/b/c.txt" → ["a", "a/b"]. */
export function ancestorsOf(path: string): string[] {
  const parts = path.split("/").filter((s) => s !== "");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

export function FilesPanel({ client, config, project, card, state, engineUrl, focus }: FilesPanelProps) {
  const t = useT();
  const titleId = useId();
  const previewId = useId();
  const target = useMemo(
    () => (card ? { cardId: card.id } : project ? { projectId: project.id } : null),
    [card, project],
  );
  const remote = !card && project?.location.kind === "ssh";

  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<string[]>(() => readExpanded(state));
  const [selected, setSelected] = useState<string | null>(() => readSelected(state));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [rootError, setRootError] = useState<string | null>(null);
  const [layout, setLayout] = useState<FilesLayout>("stacked");
  const [split, setSplit] = useState(() => readSplit(state));
  /** The large preview is open (never persisted: a restart shows the panel, not a covered window). */
  const [large, setLarge] = useState(false);
  /** Bumped by Yenile: media views ask for a fresh URL. */
  const [reloadSeq, setReloadSeq] = useState(0);

  // Latest values for async callbacks (they outlive renders).
  const live = useRef({ expanded, selected, disposed: false });
  live.current.expanded = expanded;
  live.current.selected = selected;

  const persistExpanded = useCallback(
    (next: string[]) => {
      setExpanded(next);
      live.current.expanded = next;
      state.set(EXPANDED_KEY, next);
    },
    [state],
  );
  const persistSelected = useCallback(
    (next: string | null) => {
      setSelected(next);
      live.current.selected = next;
      state.set(SELECTED_KEY, next);
    },
    [state],
  );

  const loadDir = useCallback(
    async (path: string): Promise<void> => {
      if (!target) return;
      setDirs((d) => (d[path]?.status === "ok" ? d : { ...d, [path]: { status: "loading" } }));
      try {
        const r = await client.request("files.list", { ...target, path });
        if (live.current.disposed) return;
        setDirs((d) => ({ ...d, [path]: { status: "ok", entries: r.entries, truncated: r.truncated } }));
        if (path === "") setRootError(null);
      } catch (err) {
        if (live.current.disposed || isDisconnected(err)) return;
        if (path === "") {
          setRootError(errorMessage(err));
          return;
        }
        if (isMissing(err)) {
          // Gone since it was expanded (or persisted): forget it.
          setDirs((d) => {
            const { [path]: _gone, ...rest } = d;
            return rest;
          });
          persistExpanded(live.current.expanded.filter((p) => p !== path));
          return;
        }
        setDirs((d) => ({ ...d, [path]: { status: "error", message: errorMessage(err) } }));
      }
    },
    [client, target, persistExpanded],
  );

  const loadPreview = useCallback(
    async (path: string): Promise<void> => {
      if (!target) return;
      setPreview({ status: "loading" });
      try {
        const result = await client.request("files.read", { ...target, path });
        if (live.current.disposed || live.current.selected !== path) return;
        setPreview({ status: "ok", result });
      } catch (err) {
        if (live.current.disposed || isDisconnected(err) || live.current.selected !== path) return;
        if (isMissing(err)) {
          persistSelected(null);
          setPreview(null);
          setLarge(false);
          return;
        }
        setPreview({ status: "error", message: errorMessage(err) });
      }
    },
    [client, target, persistSelected],
  );

  /** Root, every expanded folder and the selected file, fresh from the engine. */
  const reloadAll = useCallback(async (): Promise<void> => {
    const { expanded: open, selected: file } = live.current;
    await Promise.all([loadDir(""), ...open.map((p) => loadDir(p)), ...(file !== null ? [loadPreview(file)] : [])]);
  }, [loadDir, loadPreview]);

  useEffect(() => {
    live.current.disposed = false;
    if (!target || remote) return;
    const off = whenConnected(client, reloadAll);
    return () => {
      live.current.disposed = true;
      off();
    };
  }, [client, target, remote, reloadAll]);

  // ---- room: side by side when wide, stacked when narrow ----
  const bodyRef = useRef<HTMLDivElement>(null);
  const hasBody = project !== null && !remote && rootError === null;
  useEffect(() => {
    const body = bodyRef.current;
    if (!hasBody || !body || typeof ResizeObserver === "undefined") return;
    const measure = (): void => setLayout(filesLayout(body.getBoundingClientRect().width, config));
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    measure();
    return () => observer.disconnect();
  }, [hasBody, config]);

  const ratio = clampSplit(split[layout], layout, config);
  const setRatio = (next: number): void => {
    const value = { ...split, [layout]: clampSplit(next, layout, config) };
    setSplit(value);
    state.set(SPLIT_KEY, value);
  };
  const onDividerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const body = bodyRef.current;
    if (!body) return;
    e.preventDefault();
    const move = (ev: PointerEvent): void => {
      const rect = body.getBoundingClientRect();
      if (layout === "side" && rect.width > 0) setRatio((ev.clientX - rect.left) / rect.width);
      if (layout === "stacked" && rect.height > 0) setRatio((ev.clientY - rect.top) / rect.height);
    };
    const up = (ev: PointerEvent): void => {
      move(ev);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  const onDividerKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const [less, more] = layout === "side" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
    const step = e.key === more ? 1 : e.key === less ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    setRatio(ratio + step * config.filesSplitKeyStep);
  };

  // ---- large preview ----
  const isLarge = large && selected !== null;
  const restoreFocus = useRef<HTMLElement | null>(null);
  const closeLarge = useCallback((): void => {
    setLarge(false);
    restoreFocus.current?.focus();
    restoreFocus.current = null;
  }, []);
  const previewRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!isLarge) return;
    // The keyboard goes to the preview: its player takes it itself (MediaView, so Space plays); otherwise "Küçült".
    const el = previewRef.current;
    if (el && !el.contains(document.activeElement)) el.querySelector<HTMLElement>("[data-files-large]")?.focus();
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      closeLarge();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isLarge, closeLarge]);

  const toggle = (path: string): void => {
    if (expanded.includes(path)) {
      persistExpanded(expanded.filter((p) => p !== path));
      return;
    }
    persistExpanded([...expanded, path]);
    if (dirs[path]?.status !== "ok") void loadDir(path);
  };

  const open = (path: string, from: HTMLElement, enlarge: boolean): void => {
    if (enlarge) {
      restoreFocus.current = from;
      setLarge(true);
    }
    if (path === selected && preview?.status === "ok") return;
    persistSelected(path);
    void loadPreview(path);
  };

  // ---- Yollar: show a file a terminal named ----
  const handledFocus = useRef(0);
  const focusPath = focus?.filePath;
  const focusSeq = focus?.seq ?? 0;
  const focusIsDir = focus?.fileIsDir === true;
  useEffect(() => {
    if (focusPath === undefined || handledFocus.current === focusSeq || !target || remote) return;
    handledFocus.current = focusSeq;
    const folders = [...ancestorsOf(focusPath), ...(focusIsDir && focusPath !== "" ? [focusPath] : [])];
    const open = [...new Set([...live.current.expanded, ...folders])];
    persistExpanded(open);
    for (const dir of folders) void loadDir(dir);
    if (focusIsDir) return;
    // The focus returns to where it was (the terminal) when the large preview closes.
    restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    persistSelected(focusPath);
    setLarge(true);
    void loadPreview(focusPath);
  }, [focusPath, focusSeq, focusIsDir, target, remote, persistExpanded, persistSelected, loadDir, loadPreview]);

  const closePreview = (): void => {
    setLarge(false);
    persistSelected(null);
    setPreview(null);
    restoreFocus.current = null;
  };

  function renderDir(path: string, depth: number): ReactElement {
    const dir = dirs[path];
    const style = { "--kp-files-depth": depth } as CSSProperties;
    if (!dir || dir.status === "loading") {
      return (
        <li className="kp-files__note" style={style}>
          {t("files.panel.loading")}
        </li>
      );
    }
    if (dir.status === "error") {
      return (
        <li className="kp-files__note kp-error" style={style}>
          {dir.message}
        </li>
      );
    }
    if (dir.entries.length === 0) {
      return (
        <li className="kp-files__note" style={style}>
          {t("files.panel.emptyFolder")}
        </li>
      );
    }
    return (
      <>
        {dir.entries.map((e) => {
          const p = childPath(path, e.name);
          const folder = isFolder(e);
          const isOpen = folder && expanded.includes(p);
          const usable = folder || isPreviewable(e);
          return (
            <li key={e.name} className="kp-files__item">
              <button
                type="button"
                className={`kp-files__entry kp-files__entry--${folder ? "dir" : "file"}${e.kind === "symlink" ? " kp-files__entry--link" : ""}`}
                style={style}
                disabled={!usable}
                title={usable ? undefined : t("files.panel.linkNote")}
                aria-expanded={folder ? isOpen : undefined}
                aria-current={!folder && selected === p ? true : undefined}
                {...copyValue(p)}
                // A narrow panel cannot show a file readably: there a click opens the large preview at once.
                onClick={(ev) => (folder ? toggle(p) : open(p, ev.currentTarget, layout === "stacked"))}
                onDoubleClick={(ev) => {
                  if (!folder) open(p, ev.currentTarget, true);
                }}
              >
                <span className="kp-files__icon" aria-hidden="true">
                  {folder ? (isOpen ? "▾" : "▸") : e.kind === "symlink" ? "↪" : "·"}
                </span>
                <span className="kp-files__name">{e.name}</span>
              </button>
              {isOpen && <ul className="kp-files__group">{renderDir(p, depth + 1)}</ul>}
            </li>
          );
        })}
        {dir.truncated && (
          <li className="kp-files__note" style={style}>
            {t("files.panel.truncated", { count: dir.entries.length })}
          </li>
        )}
      </>
    );
  }

  // The project tab already shows the project; only a card needs naming here.
  const where = card ? card.name : "";

  let body: ReactElement;
  if (!project) {
    body = <p className="kp-placeholder__body">{t("files.panel.noProject")}</p>;
  } else if (remote) {
    body = <p className="kp-placeholder__body">{t("files.panel.sshNote")}</p>;
  } else if (rootError) {
    body = (
      <p role="alert" className="kp-error kp-files__alert">
        {rootError}
      </p>
    );
  } else {
    const showPreview = selected !== null;
    const tracks = `minmax(0, ${ratio}fr) var(--kp-files-divider) minmax(0, ${1 - ratio}fr)`;
    const bodyStyle: CSSProperties | undefined = showPreview
      ? layout === "side"
        ? { gridTemplateColumns: tracks }
        : { gridTemplateRows: tracks }
      : undefined;
    body = (
      <div
        ref={bodyRef}
        className={`kp-files__body kp-files__body--${layout}${showPreview ? " kp-files__body--split" : ""}`}
        style={bodyStyle}
      >
        <ul className="kp-files__tree" aria-label={t("files.panel.tree")}>
          {renderDir("", 0)}
        </ul>
        {showPreview && (
          <div
            role="separator"
            aria-label={t("files.panel.divider")}
            aria-orientation={layout === "side" ? "vertical" : "horizontal"}
            aria-valuemin={config.filesSplitMinRatio * 100}
            aria-valuemax={(1 - config.filesSplitMinRatio) * 100}
            aria-valuenow={Math.round(ratio * 1000) / 10}
            tabIndex={0}
            className="kp-files__divider"
            onPointerDown={onDividerDown}
            onKeyDown={onDividerKey}
          />
        )}
        {showPreview && (
          <section
            ref={previewRef}
            className={`kp-files__preview${isLarge ? " kp-files__preview--large" : ""}`}
            aria-labelledby={previewId}
          >
            <h4 id={previewId} className="kp-files__preview-title">
              {t("files.panel.preview")}
            </h4>
            <FilePreview
              path={selected}
              preview={preview}
              media={target ? { client, config, engineUrl, target, reloadSeq, autoFocus: isLarge } : undefined}
              actions={
                <>
                  <button
                    type="button"
                    className="kp-btn kp-btn--quiet kp-btn--icon"
                    aria-pressed={isLarge}
                    aria-label={isLarge ? t("files.panel.shrink") : t("files.panel.enlarge")}
                    title={isLarge ? t("files.panel.shrinkTitle") : t("files.panel.enlargeTitle")}
                    data-files-large=""
                    onClick={(ev) => {
                      if (isLarge) closeLarge();
                      else {
                        restoreFocus.current = ev.currentTarget;
                        setLarge(true);
                      }
                    }}
                  >
                    {isLarge ? "⤡" : "⤢"}
                  </button>
                  <button type="button" className="kp-btn kp-btn--quiet kp-btn--icon" aria-label={t("files.panel.closePreview")} title={t("files.panel.closePreview")} onClick={closePreview}>
                    ×
                  </button>
                </>
              }
            />
          </section>
        )}
      </div>
    );
  }

  return (
    <section className="kp-panel kp-files" aria-labelledby={titleId}>
      <PanelTitle id={titleId}>{t("files.title")}</PanelTitle>
      {project && !remote && (
        <div className="kp-panel__bar">
          {where && <span className="kp-files__where">{where}</span>}
          <span className="kp-panel__actions">
            <button
              type="button"
              className="kp-btn kp-btn--quiet kp-btn--icon"
              aria-label={t("files.panel.reload")}
              title={t("files.panel.reload")}
              onClick={() => {
                setReloadSeq((n) => n + 1);
                void reloadAll();
              }}
            >
              ↻
            </button>
          </span>
        </div>
      )}
      {body}
    </section>
  );
}

export interface FilePreviewMedia {
  client: EngineClient;
  config: UiConfig;
  engineUrl: string | undefined;
  target: { projectId: string } | { cardId: string };
  /** A new value makes the media view ask the engine again. */
  reloadSeq?: number;
  autoFocus?: boolean;
}

export interface FilePreviewProps {
  path: string | null;
  preview: Preview | null;
  /** BCP 47 locale of the sizes; the active language's when absent. */
  locale?: string | undefined;
  /** Buttons at the right end of the path line. */
  actions?: ReactNode;
  /** Where media files stream from. Absent = media files only get the "binary" note (e.g. the Claude panel). */
  media?: FilePreviewMedia | undefined;
}

/** Read-only preview of one file (also used by the Claude panel). */
export function FilePreview({ path, preview, locale, actions, media }: FilePreviewProps) {
  const t = useT();
  if (path === null || preview === null) {
    return <p className="kp-files__hint">{t("files.preview.pick")}</p>;
  }
  const size = preview.status === "ok" ? formatBytes(preview.result.size, locale) : null;
  // One slim line: the path (the whole of it in the tooltip and on right click), the size, the actions.
  const head = (
    <div className="kp-files__head">
      <p className="kp-files__path" title={path} {...copyValue(path)}>
        {path}
      </p>
      {size && <span className="kp-files__size">{size}</span>}
      {actions && <span className="kp-files__head-actions">{actions}</span>}
    </div>
  );
  if (preview.status === "loading") {
    return (
      <>
        {head}
        <p className="kp-files__hint">{t("files.preview.loading")}</p>
      </>
    );
  }
  if (preview.status === "error") {
    return (
      <>
        {head}
        <p role="alert" className="kp-error kp-files__alert">
          {preview.message}
        </p>
      </>
    );
  }
  const { result } = preview;
  const viewer = chooseViewer(result);
  if (viewer !== "text" && viewer !== "binary" && media) {
    return (
      <>
        {head}
        <MediaView
          key={`${path}#${media.reloadSeq ?? 0}`}
          client={media.client}
          config={media.config}
          engineUrl={media.engineUrl}
          target={media.target}
          path={path}
          kind={viewer}
          autoFocus={media.autoFocus === true}
        />
      </>
    );
  }
  if (result.text === undefined || result.binary) {
    return (
      <>
        {head}
        <p className="kp-files__hint">{t("files.preview.binary", { size: size ?? "" })}</p>
      </>
    );
  }
  const text = result.text;
  return (
    <>
      {head}
      {result.truncated && (
        <p className="kp-files__hint">
          {t("files.preview.truncated", { shown: formatBytes(utf8Length(text), locale), size: size ?? "" })}
        </p>
      )}
      <div className="kp-files__code-wrap" tabIndex={0}>
        <pre className="kp-files__gutter" aria-hidden="true">
          {lineNumbers(text)}
        </pre>
        <pre className="kp-files__code">
          <code>{text}</code>
        </pre>
      </div>
    </>
  );
}

/** Registry entry (İş L): `filesPanel,` in layout/registry.ts. */
export const filesPanel: PanelDefinition = {
  id: "files",
  get title() {
    return translate("files.title");
  },
  available: ({ project }) => project !== null,
  render: (ctx) => (
    <FilesPanel
      key={ctx.card ? `c:${ctx.card.id}` : `p:${ctx.project?.id ?? ""}`}
      client={ctx.client}
      config={ctx.config}
      project={ctx.project}
      card={ctx.card}
      state={ctx.state}
      engineUrl={ctx.engineUrl}
      focus={ctx.focus}
    />
  ),
};
