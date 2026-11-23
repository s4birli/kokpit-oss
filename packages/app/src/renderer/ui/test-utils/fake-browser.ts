// İş B: in-memory browser behind FakeEngineClient (browser.* requests, frames, acks, input).
import type { BrowserContextInfo, BrowserExtension, BrowserFrameMessage, BrowserInputEvent, BrowserResultMap, BrowserState, ParamsOf } from "@kokpit/shared";
import { EngineRequestError } from "../../engine/types.ts";
import { defaultUiConfig } from "../config.ts";

type BrowserMethod = keyof BrowserResultMap;
type Handlers = { [M in BrowserMethod]: (p: ParamsOf<M>) => BrowserResultMap[M] };

export class FakeBrowser {
  readonly running = new Map<string, BrowserState>();
  readonly inputs: Array<{ projectId: string; event: BrowserInputEvent }> = [];
  readonly acks: Array<{ projectId: string; frameId: number }> = [];
  /** projectId → last screencast.start params. */
  readonly screencasts = new Map<string, ParamsOf<"browser.screencast.start">>();
  readonly frameListeners = new Map<string, Set<(f: BrowserFrameMessage) => void>>();
  /** Kopyalama: what is selected in the remote page, what the context request answers, and every clipboard request. */
  readonly clipboard = {
    selection: "",
    context: { hasSelection: false, editable: false } as BrowserContextInfo,
    calls: [] as Array<["copy", string, boolean] | ["paste", string, string] | ["context", string, number, number]>,
    /** Thrown by the next copy / paste / context (then cleared). */
    error: undefined as EngineRequestError | undefined,
  };
  private clipboardFailure(projectId: string): void {
    this.need(projectId);
    const err = this.clipboard.error;
    this.clipboard.error = undefined;
    if (err) throw err;
  }
  private seq = 0;
  private tabSeq = 0;
  /**
   * The engine owns each project's zoom: projectId → the zoom a user chose (null = the default, as a choice);
   * absent = nobody chose one. Tests play "another app zoomed" by setting it and emitting `browser.changed`.
   */
  readonly zooms = new Map<string, number | null>();
  defaultZoom = defaultUiConfig.browserZoom;
  /** Projects whose page viewport this app (the fake's one connection) drives. */
  readonly owned = new Set<string>();
  /** Projects whose page viewport ANOTHER app drives: this app's size reports count only with `interaction`. */
  readonly otherOwns = new Set<string>();

  zoomOf(projectId: string): number {
    return this.zooms.get(projectId) ?? this.defaultZoom;
  }

  /** Another app's user used its panel: it drives the project's viewport now. */
  takeOver(projectId: string): void {
    this.owned.delete(projectId);
    this.otherOwns.add(projectId);
  }

  /** The state as the engine answers it to this connection. */
  private seen(projectId: string, s: BrowserState): { browser: BrowserState } {
    return { browser: { ...s, zoom: this.zoomOf(projectId), viewportOwner: this.owned.has(projectId) } };
  }

  private need(projectId: string): BrowserState {
    const s = this.running.get(projectId);
    if (!s) throw new EngineRequestError("NOT_FOUND", "Tarayıcı açık değil");
    return s;
  }

  private nav(projectId: string, url: string): { browser: BrowserState } {
    const s = this.need(projectId);
    const tabs = s.tabs.map((t) => (t.id === s.activeTabId ? { ...t, url, title: url } : t));
    const next = { ...s, tabs };
    this.running.set(projectId, next);
    return this.seen(projectId, next);
  }

  /** Yollar: every `browser.openFile` request, oldest first. */
  readonly openedFiles: ParamsOf<"browser.openFile">[] = [];
  /** Yollar: terminalId → projectId, for `browser.openFile` requests that name a terminal. */
  fileProjects: Record<string, string> = {};

  readonly handlers: Handlers = {
    "browser.open": ({ projectId }) => {
      const s = this.running.get(projectId) ?? { running: true, tabs: [{ id: "T1", title: "about:blank", url: "about:blank" }], activeTabId: "T1" };
      this.running.set(projectId, s);
      return this.seen(projectId, s);
    },
    "browser.close": ({ projectId }) => {
      this.running.delete(projectId);
      this.screencasts.delete(projectId);
      return {};
    },
    "browser.tabs": ({ projectId }) => this.seen(projectId, this.running.get(projectId) ?? { running: false, tabs: [] }),
    "browser.navigate": ({ projectId, url }) => this.nav(projectId, url),
    "browser.back": ({ projectId }) => this.seen(projectId, this.need(projectId)),
    "browser.forward": ({ projectId }) => this.seen(projectId, this.need(projectId)),
    "browser.reload": ({ projectId }) => this.seen(projectId, this.need(projectId)),
    "browser.selectTab": ({ projectId, tabId }) => {
      const s = this.need(projectId);
      const next = { ...s, activeTabId: tabId };
      this.running.set(projectId, next);
      return this.seen(projectId, next);
    },
    "browser.newTab": ({ projectId, url }) => {
      const s = this.need(projectId);
      const id = `T${Math.max(s.tabs.length, this.tabSeq) + 1}`;
      this.tabSeq = Math.max(s.tabs.length, this.tabSeq) + 1;
      const next = { ...s, tabs: [...s.tabs, { id, title: url ?? "about:blank", url: url ?? "about:blank" }], activeTabId: id };
      this.running.set(projectId, next);
      return this.seen(projectId, next);
    },
    // Like the engine: starts the browser when needed; the link gets a new, active tab (a started browser's blank
    // tab is replaced).
    "browser.openUrl": ({ projectId, url }) => {
      const s = this.running.get(projectId);
      this.tabSeq = Math.max(s?.tabs.length ?? 0, this.tabSeq) + 1;
      const id = `T${this.tabSeq}`;
      const next: BrowserState = { running: true, tabs: [...(s?.tabs ?? []), { id, title: url, url }], activeTabId: id };
      this.running.set(projectId, next);
      return this.seen(projectId, next);
    },
    // Yollar: like the engine, the file gets a preview address of its own and a new, active tab. The project is the
    // one named, or the one `fileProjects` says the terminal belongs to.
    "browser.openFile": (ref) => {
      const projectId = ref.projectId ?? (ref.terminalId !== undefined ? this.fileProjects[ref.terminalId] : undefined) ?? "";
      this.openedFiles.push(ref);
      return this.handlers["browser.openUrl"]({ projectId, url: `http://127.0.0.1:7420/files/preview/${"t".repeat(43)}/${ref.path.slice(ref.path.lastIndexOf("/") + 1)}` });
    },
    "browser.closeTab": ({ projectId, tabId }) => {
      const s = this.need(projectId);
      const at = s.tabs.findIndex((t) => t.id === tabId);
      if (at < 0) throw new EngineRequestError("NOT_FOUND", "Sekme bulunamadı");
      let tabs = s.tabs.filter((t) => t.id !== tabId);
      // Like the engine: Chrome is never left without a page.
      if (tabs.length === 0) tabs = [{ id: `T${++this.tabSeq + 1000}`, title: "about:blank", url: "about:blank" }];
      const activeTabId = s.activeTabId === tabId ? (tabs[at] ?? tabs[at - 1] ?? tabs[0])!.id : s.activeTabId;
      const next: BrowserState = { ...s, tabs, ...(activeTabId !== undefined ? { activeTabId } : {}) };
      this.running.set(projectId, next);
      return this.seen(projectId, next);
    },
    "browser.screencast.start": (p) => {
      this.need(p.projectId);
      this.screencasts.set(p.projectId, p);
      return {};
    },
    "browser.screencast.stop": ({ projectId }) => {
      this.screencasts.delete(projectId);
      // Like the engine: a viewer that stops watching no longer drives the viewport.
      this.owned.delete(projectId);
      return {};
    },
    "browser.extensions.list": ({ projectId }) => ({ extensions: this.extensions.get(projectId) ?? [] }),
    "browser.extensions.loadUnpacked": ({ projectId, path }) => {
      if (!path.endsWith("/ext")) throw new EngineRequestError("INVALID", `Klasörde manifest.json yok: ${path}`);
      const list = (this.extensions.get(projectId) ?? []).filter((e) => e.path !== path);
      list.push({ path, id: "abcdefghijklmnopabcdefghijklmnop", name: "Test uzantısı", version: "1.0.0", loaded: true });
      this.extensions.set(projectId, list);
      if (!this.running.has(projectId)) this.handlers["browser.open"]({ projectId });
      return { extensions: list };
    },
    "browser.extensions.remove": ({ projectId, path }) => {
      const list = (this.extensions.get(projectId) ?? []).filter((e) => e.path !== path);
      this.extensions.set(projectId, list);
      return { extensions: list };
    },
    "browser.showWindow": ({ projectId }) => {
      this.need(projectId);
      this.shown.push(projectId);
      return {};
    },
    "browser.copy": ({ projectId, cut }) => {
      this.clipboardFailure(projectId);
      this.clipboard.calls.push(["copy", projectId, cut === true]);
      return { text: this.clipboard.selection };
    },
    "browser.paste": ({ projectId, text }) => {
      this.clipboardFailure(projectId);
      this.clipboard.calls.push(["paste", projectId, text]);
      return {};
    },
    "browser.context": ({ projectId, x, y }) => {
      this.clipboardFailure(projectId);
      this.clipboard.calls.push(["context", projectId, x, y]);
      return this.clipboard.context;
    },
    // The engine's rule (engine: decideZoom): only a user action changes a chosen zoom; a hand-over ("adopt") or an
    // old app's copy (no mode) counts only while nobody chose one. Tests read client.callsOf("browser.zoom.set").
    "browser.zoom.set": ({ projectId, zoom, mode }) => {
      const chosen = this.zooms.has(projectId);
      if (mode === "user") {
        this.zooms.set(projectId, zoom);
        return { zoom: this.zoomOf(projectId), applied: true };
      }
      if (zoom === null) throw new EngineRequestError("INVALID", "Geçersiz yakınlaştırma isteği");
      if (!chosen && !(mode === undefined && zoom === this.defaultZoom)) {
        this.zooms.set(projectId, zoom);
        return { zoom, applied: true };
      }
      if (chosen && mode === undefined && zoom !== this.zoomOf(projectId)) throw new EngineRequestError("INVALID", "Bu uygulama sürümü eski");
      return { zoom: this.zoomOf(projectId), applied: false };
    },
    // The engine's rule: the size counts from the viewport owner, from anyone when nobody owns, and from whoever
    // says its user just used the panel. Tests read client.callsOf("browser.viewport.set").
    "browser.viewport.set": ({ projectId, interaction }) => {
      if (interaction !== true && this.otherOwns.has(projectId)) return { applied: false };
      this.otherOwns.delete(projectId);
      this.owned.add(projectId);
      return { applied: true };
    },
  };
  readonly extensions = new Map<string, BrowserExtension[]>();
  readonly shown: string[] = [];

  onFrame(projectId: string, cb: (f: BrowserFrameMessage) => void): () => void {
    let set = this.frameListeners.get(projectId);
    if (!set) this.frameListeners.set(projectId, (set = new Set()));
    set.add(cb);
    return () => set.delete(cb);
  }

  /** Pushes a frame to the panel as the engine would. */
  emitFrame(projectId: string, metadata: Partial<BrowserFrameMessage["metadata"]> = {}): BrowserFrameMessage {
    const frame: BrowserFrameMessage = {
      type: "browser.frame",
      projectId,
      frameId: ++this.seq,
      data: "/9j/4AAQSkZJRg==",
      metadata: { deviceWidth: 1280, deviceHeight: 800, pageScaleFactor: 1, offsetTop: 0, scrollOffsetX: 0, scrollOffsetY: 0, ...metadata },
    };
    for (const cb of [...(this.frameListeners.get(projectId) ?? [])]) cb(frame);
    return frame;
  }
}
