// İş B: one real Chrome per project on the engine machine, with its own persistent profile
// (<dataDir>/<profilesDirName>/<projectId>) and DevTools bound to 127.0.0.1 only. The app sees it as a
// CDP screencast and drives it with CDP input; agents in the project's terminals reach the same browser
// through KOKPIT_CDP_URL.
import { execFile, spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { isAbsolute, join } from "node:path";
import {
  BROWSER_LIMITS,
  type BrowserContextInfo,
  type BrowserExtension,
  type BrowserFrameMessage,
  type BrowserFrameMetadata,
  type BrowserInputEvent,
  type BrowserModifiers,
  type BrowserState,
  type BrowserTab,
  type BrowserWindowMode,
  type BrowserZoomMode,
  type Project,
} from "@kokpit/shared";
import type { Params, SharedKey } from "@kokpit/shared/i18n";
import type { BrowserConfig } from "./browser-config.ts";
import { contextScript, parseContext, parseSelection, selectionScript } from "./browser-clipboard.ts";
import {
  findProfileChrome,
  isChromeExecutable,
  lsofExecutable,
  lsofListenPorts,
  singletonLockPid,
  verifyProfileChrome,
  type ProfileChrome,
} from "./browser-window.ts";
import { applyIdentity, identityFromProbe, probeChromeIdentity, type ChromeProbe, type HiddenIdentity, type IdentityHandle } from "./browser-identity.ts"; // Gizli tarayıcı kimliği
import { callInIsolatedWorld, type IsolatedCall } from "./browser-isolated.ts"; // Girişler
import { createPortAllocator, preferredPort } from "./browser-ports.ts";
import { connectCdp, type CdpConnection } from "./cdp.ts";
import {
  errText,
  LiveTab,
  panelOverride,
  TAB_ACTIVATED_LOG,
  TITLE_BINDING,
  type LiveFrame,
  type PanelView,
  type ScreencastOptions,
} from "./browser-live.ts";
import { ViewportOwners, type ViewportReport } from "./viewport-owner.ts";
import { EngineError, engineError, type BrowserExtensionStore, type BrowserPortStore, type BrowserZoomStore, type Logger } from "./contracts.ts";

/** Env var that carries the project's DevTools endpoint into its terminals. */
export const ENV_CDP_URL = "KOKPIT_CDP_URL";
const LOOPBACK = "127.0.0.1";
const DEVTOOLS_ACTIVE_PORT = "DevToolsActivePort";
const BLANK = "about:blank";
/**
 * Log messages about a tab's life (one line each, with the tab's id): who opened, activated or closed what, and
 * when. They all start with "browser tab " — the app's e2e tab trace picks them out by that.
 */
const TAB_LOG = {
  created: "browser tab created",
  activated: TAB_ACTIVATED_LOG,
  closeAsked: "browser tab close asked",
  destroyed: "browser tab destroyed",
} as const;
const MAX_PROJECT_ID = 200;
const SAFE_PROFILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
/** Test Chrome: no macOS keychain access, so no system dialog ever appears. */
export const TEST_MODE_ARGS = ["--use-mock-keychain", "--password-store=basic"] as const;
/**
 * The documented switch for CDP Extensions.loadUnpacked, the only way left to add a developer extension
 * without the extensions page: branded Chrome ignores `--load-extension` since 137. (Chrome 157 on macOS
 * also accepts loadUnpacked over a --remote-debugging-port without it; the switch keeps versions that gate
 * the domain working.) DevTools is loopback-only and already grants full control of the browser, so the
 * switch adds no new reach.
 */
export const EXTENSION_DEBUGGING_ARG = "--enable-unsafe-extension-debugging";
const MANIFEST = "manifest.json";
// ---------- pure helpers ----------

export interface ChromeArgsInput {
  profileDir: string;
  port: number;
  headless: boolean;
  /** Test-only: never touch the macOS keychain (see BrowserConfig.testMode). */
  testMode: boolean;
  windowWidth: number;
  windowHeight: number;
  /** The profile has a session to restore: then no start URL (it would add a blank tab on every restart). */
  hasSavedSession?: boolean;
  /**
   * The project's window mode. "hidden": Chrome's headless mode — measured on macOS (Chrome 157): no window on
   * screen, no Dock icon or menu bar (background-only process), never the frontmost app, while screencast, input,
   * extensions, session restore and the DevTools port work as headful. Every headful variant (minimized,
   * off-screen, app hidden) came back: launching activates Chrome, Page.bringToFront / Target.activateTarget
   * un-minimize, un-hide and activate it, a page's window.open shows a new window. Absent = "visible".
   */
  window?: BrowserWindowMode;
  /**
   * "hidden" only: the User-Agent to present instead of headless Chrome's (which says "HeadlessChrome") — Chrome's
   * own without that token (browser-identity.ts). Its client hints are set over CDP (applyIdentity).
   */
  userAgent?: string;
  /**
   * Masaüstü's real Chrome: start with no window at all (`--no-startup-window`) and without restoring the last
   * session — restored windows would come back on the engine Mac's screen. Its pages open in minimized windows.
   */
  quiet?: boolean;
}

/** Chrome starts with no window (a quiet Chrome opens each page in a minimized window of its own). */
export const NO_STARTUP_WINDOW_ARG = "--no-startup-window";

/**
 * "Continue where you left off": restores the last session's tabs and — what matters — its session cookies, so
 * logins without an expiry survive engine/Chrome restarts. (The profile pref session.restore_on_startup cannot be
 * used: Chrome resets that tracked pref when it finds it written by someone else.)
 */
export const RESTORE_SESSION_ARG = "--restore-last-session";
/** Chrome's headless mode: the real browser (profile, extensions, sync) without any window on screen. */
export const HEADLESS_ARG = "--headless=new";
/** Where Chrome keeps the profile's saved sessions. */
const SESSIONS_DIR = ["Default", "Sessions"] as const;

export function hasSavedSession(profile: string): boolean {
  return existsSync(join(profile, ...SESSIONS_DIR));
}

/** argv for Chrome. DevTools listens on loopback only; the profile is the project's own. */
export function chromeArgs(o: ChromeArgsInput): string[] {
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) throw new Error(`invalid DevTools port ${o.port}`);
  if (!isAbsolute(o.profileDir)) throw new Error("profile dir must be absolute");
  // A hidden production browser keeps the real keychain (only `testMode` / test `headless` mock it).
  const hidden = o.window === "hidden";
  return [
    `--user-data-dir=${o.profileDir}`,
    `--remote-debugging-address=${LOOPBACK}`,
    `--remote-debugging-port=${o.port}`,
    "--no-first-run",
    "--no-default-browser-check",
    `--window-size=${o.windowWidth},${o.windowHeight}`,
    // Keep painting when the Mac mini's window is hidden or occluded: the screencast is the only viewer.
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    EXTENSION_DEBUGGING_ARG,
    ...(o.headless || hidden ? [HEADLESS_ARG] : []),
    ...(hidden && !o.headless && o.userAgent !== undefined ? [`--user-agent=${o.userAgent}`] : []),
    // Headless is test-only too, so it always gets the mock keychain: a test config that forgets
    // `testMode` must still never bring up the macOS keychain dialog.
    ...(o.testMode || o.headless ? TEST_MODE_ARGS : []),
    ...(o.quiet ? [NO_STARTUP_WINDOW_ARG] : [RESTORE_SESSION_ARG, ...(o.hasSavedSession ? [] : [BLANK])]),
  ];
}

/** `<root>/<projectId>`; refuses ids that could escape the root or read as an option. */
export function profileDir(root: string, projectId: string): string {
  if (
    projectId.length === 0 ||
    projectId.length > MAX_PROJECT_ID ||
    !SAFE_PROFILE_NAME.test(projectId) ||
    projectId === "." ||
    projectId === ".."
  ) {
    throw engineError("INVALID", "engine.browser.badProfileId", { projectId });
  }
  return join(root, projectId);
}

/**
 * An unpacked extension folder as the engine will use it: absolute, without `.`/`..` segments, an existing
 * directory holding a manifest.json file. Returns its real path (symlinks resolved, no trailing slash).
 */
export function checkExtensionDir(dir: string): string {
  const bad = (key: SharedKey, params?: Params) => engineError("INVALID", key, params);
  if (!dir.startsWith("/") || dir.length > BROWSER_LIMITS.maxExtensionPathLength) throw bad("engine.browser.extensionDirNotAbsolute");
  if (dir.includes("\0") || dir.split("/").some((seg) => seg === "." || seg === "..")) throw bad("engine.browser.extensionDirBadPath");
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    throw bad("engine.browser.extensionDirNotFound", { dir });
  }
  if (!statSync(real).isDirectory()) throw bad("engine.browser.notAFolder", { dir });
  let manifest = false;
  try {
    manifest = statSync(join(real, MANIFEST)).isFile();
  } catch {
    manifest = false;
  }
  if (!manifest) throw bad("engine.browser.noManifest", { manifest: MANIFEST, dir });
  return real;
}

/** What CDP Extensions.getExtensions reports per unpacked extension. */
export interface CdpExtensionInfo {
  id: string;
  name: string;
  version: string;
  path: string;
  enabled: boolean;
}

/**
 * The panel's list: remembered folders in order (with what Chrome reports, or the last load error), then
 * extensions the running Chrome has loaded from other folders (e.g. by an agent). `loaded: null` = not running.
 */
export function mergeExtensions(
  remembered: readonly string[],
  loaded: readonly CdpExtensionInfo[] | null,
  errors: ReadonlyMap<string, string>,
): BrowserExtension[] {
  const byPath = new Map((loaded ?? []).map((e) => [e.path, e] as const));
  const entry = (path: string): BrowserExtension => {
    const e = byPath.get(path);
    if (e) return { path, id: e.id, name: e.name, version: e.version, loaded: true };
    const error = errors.get(path);
    return { path, loaded: false, ...(error !== undefined ? { error } : {}) };
  };
  const known = new Set(remembered);
  return [...remembered.map(entry), ...(loaded ?? []).filter((e) => !known.has(e.path)).map((e) => entry(e.path))];
}

/** Port on the first line of Chrome's DevToolsActivePort file, or null. */
export function parseDevToolsActivePort(text: string): number | null {
  const first = text.split("\n")[0]?.trim() ?? "";
  if (!/^\d{1,5}$/.test(first)) return null;
  const port = Number(first);
  return port >= 1 && port <= 65535 ? port : null;
}

// FrameGate (screencast backpressure) lives in frame-gate.ts; the screen stream (Adım 9) shares it.
export { FrameGate } from "./frame-gate.ts";
// The live tab (session, size, screencast, input) lives in browser-live.ts; its pure helpers stay importable here.
export {
  afterPaint,
  mergeScreencast,
  modifierBits,
  panelOverride,
  TITLE_BINDING,
  TITLE_WATCHER,
  toCdpInput,
  within,
  zoomOverride,
  type CdpCall,
  type DeviceMetricsOverride,
  type PanelView,
  type ScreencastOptions,
} from "./browser-live.ts";
export type { ViewportReport } from "./viewport-owner.ts";

export { preferredPort };

export interface BrowserTerminalEnvOptions {
  /** Env names that get the CDP URL too (e.g. PLAYWRIGHT_MCP_CDP_ENDPOINT: a Playwright MCP started without args). */
  cdpEndpointEnv: readonly string[];
  /** Env names that get the project's output dir (e.g. PLAYWRIGHT_MCP_OUTPUT_DIR: keep its files out of the repo). */
  outputDirEnv: readonly string[];
  /** Adım 9 İş T: the project's own output folder; null = none can be named for this id (the names are left out). */
  outputDirFor: (projectId: string) => string | null;
}

/**
 * Terminal env for a project whose browser runs on the engine and whose terminal is local: KOKPIT_CDP_URL, and the
 * same URL / an output folder under the names agents' own browser tools read (so a user's global Playwright MCP
 * plugin drives this project's Chrome instead of launching its own, and writes outside the project).
 */
export function browserTerminalEnv(project: Project, cdpUrlFor: (projectId: string) => string, opts: BrowserTerminalEnvOptions): Record<string, string> {
  if (project.location.kind === "ssh" || project.browser?.runOn === "client") return {};
  const url = cdpUrlFor(project.id);
  const env: Record<string, string> = { [ENV_CDP_URL]: url };
  for (const name of opts.cdpEndpointEnv) env[name] = url;
  const outputDir = opts.outputDirEnv.length > 0 ? opts.outputDirFor(project.id) : null;
  if (outputDir !== null) for (const name of opts.outputDirEnv) env[name] = outputDir;
  return env;
}

/** `NAME=value` words a shell command may start with. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=\S*$/;

/**
 * Whether a terminal's start command runs one of `programs` (by its first word after env assignments, path
 * stripped): e.g. `claude …` starts the project's browser so its browser plugins can connect right away.
 */
export function commandStartsBrowser(command: string, programs: readonly string[]): boolean {
  const words = command.trim().split(/\s+/);
  const first = words.find((w) => !ENV_ASSIGNMENT.test(w));
  if (!first) return false;
  const program = first.slice(first.lastIndexOf("/") + 1);
  return programs.includes(program);
}

// ---------- manager ----------

/** A target as Chrome describes it (Target.getTargets, Target.targetCreated / targetInfoChanged). */
export type TargetInfo = { targetId: string; type: string; title: string; url: string; openerId?: string };
const toTab = (t: TargetInfo): BrowserTab => ({ id: t.targetId, title: t.title, url: t.url });

/**
 * The tab list after a Target.getTargets answer: the tabs known so far keep their order, pages not seen before
 * are appended, tabs Chrome no longer has are dropped. A `hidden` tab is never listed, even if Chrome names it.
 */
export function mergeTabs(known: Iterable<string>, infos: readonly TargetInfo[], hidden: (tabId: string) => boolean): Map<string, BrowserTab> {
  const fresh = new Map(infos.filter((t) => t.type === "page" && !hidden(t.targetId)).map((t) => [t.targetId, toTab(t)] as const));
  const ordered = new Map<string, BrowserTab>();
  for (const id of known) {
    const t = fresh.get(id);
    if (t) ordered.set(id, t);
  }
  for (const [id, t] of fresh) if (!ordered.has(id)) ordered.set(id, t);
  return ordered;
}

/** What `browser.zoom.set` does with a request, given what is stored for the project (see BrowserZoomStore). */
export type ZoomDecision = { kind: "store"; value: number | null } | { kind: "keep" } | { kind: "refuse" };

/**
 * The zoom is one value per project and only a user action changes it:
 * - "user": always stored (null = the configured default, as a choice);
 * - "adopt" (an app hands over the zoom it used to keep itself): stored only when nobody ever chose one;
 * - no mode (an app from before the engine owned the zoom re-sends its copy on every mount/reconnect): like
 *   "adopt", except that its default says nothing (it sent that for projects nobody zoomed) and that a value
 *   which would change a chosen zoom is refused — the old app's user sees why the page did not follow.
 */
export function decideZoom(
  stored: number | null | undefined,
  defaultZoom: number,
  zoom: number | null,
  mode: BrowserZoomMode | undefined,
): ZoomDecision {
  if (mode === "user") return { kind: "store", value: zoom };
  if (zoom === null) return { kind: "refuse" };
  if (stored === undefined) return mode === undefined && zoom === defaultZoom ? { kind: "keep" } : { kind: "store", value: zoom };
  return mode === undefined && zoom !== (stored ?? defaultZoom) ? { kind: "refuse" } : { kind: "keep" };
}

/** Bağlantılar: what `openUrl` does besides opening the link's own tab (see `BrowserManager.openUrl`). */
export type OpenUrlPlan = { kind: "replace"; tabId: string } | { kind: "new" };

/**
 * A link always gets a NEW tab, so nothing the user or an agent has open is replaced and a slow page (a dev server
 * compiling its first answer) cannot hold the request up. The one exception concerns what is left behind: a Chrome
 * that this very request started shows exactly one blank tab that nobody has used — that tab is closed once the
 * link's tab is in front ("replace"). A blank tab of a Chrome that was already running is left alone: an agent may
 * have just opened it.
 */
export function openUrlPlan(o: { started: boolean; tabs: readonly BrowserTab[]; activeTabId: string | undefined }): OpenUrlPlan {
  const only = o.tabs.length === 1 ? o.tabs[0] : undefined;
  return o.started && only !== undefined && only.url === BLANK && only.id === o.activeTabId ? { kind: "replace", tabId: only.id } : { kind: "new" };
}

/** What a log line may say about an opened link: scheme, host and port. Paths and queries can carry secrets. */
export function linkOrigin(url: string): string {
  try {
    const { origin } = new URL(url);
    return origin === "null" ? "" : origin;
  } catch {
    return "";
  }
}

export interface BrowserManager {
  /** Starts the project's Chrome, or reuses the running one. */
  open(projectId: string): Promise<BrowserState>;
  /** Closes it gracefully (profile flushed to disk). No-op when not running. */
  close(projectId: string): Promise<void>;
  /** Tab titles/URLs are re-read from Chrome on every call. */
  state(projectId: string): Promise<BrowserState>;
  navigate(projectId: string, url: string): Promise<BrowserState>;
  back(projectId: string): Promise<BrowserState>;
  forward(projectId: string): Promise<BrowserState>;
  /** `ignoreCache`: ⇧⌘R (Chrome's hard reload). */
  reload(projectId: string, ignoreCache?: boolean): Promise<BrowserState>;
  selectTab(projectId: string, tabId: string): Promise<BrowserState>;
  newTab(projectId: string, url?: string): Promise<BrowserState>;
  /**
   * Bağlantılar: shows `url` (http/https, already validated) in the project's Chrome — started if it is not
   * running — in a new, active tab; answers once the tab exists, not when the page has loaded (see `openUrlPlan`).
   * The address is never logged.
   */
  openUrl(projectId: string, url: string): Promise<BrowserState>;
  /** Closes one tab; the active one hands the view to a neighbour, the last one is replaced by a blank tab. */
  closeTab(projectId: string, tabId: string): Promise<BrowserState>;
  /** Frames of the active tab go to `send` until unsubscribe; `key` identifies the subscriber (a connection). */
  subscribe(projectId: string, key: object, opts: ScreencastOptions, send: (msg: BrowserFrameMessage) => void): Promise<void>;
  unsubscribe(projectId: string, key: object): void;
  /** Drops `key` from every project (connection closed). */
  unsubscribeAll(key: object): void;
  ack(projectId: string, key: object, frameId: number): void;
  input(projectId: string, event: BrowserInputEvent): Promise<void>;
  /**
   * Kopyalama: the text selected in the active tab's page ("" = nothing; never a password field). `cut` also
   * deletes an editable selection. Over `clipboardMaxChars`: INVALID. The text is never logged.
   */
  copySelection(projectId: string, opts: { cut: boolean }): Promise<string>;
  /** Kopyalama: inserts `text` at the caret of the active tab's page. Over `clipboardMaxChars`: INVALID. */
  pasteText(projectId: string, text: string): Promise<void>;
  /** Kopyalama: selection / focus / link at a page point, for the app's right-click menu. */
  contextAt(projectId: string, at: { x: number; y: number }): Promise<BrowserContextInfo>;
  /**
   * Girişler: calls one function in an isolated world of the active tab's main frame (browser-isolated.ts) and
   * returns its (untrusted) value. NOT_FOUND when the browser is not running; INVALID when the page is gone.
   * Neither the call nor its arguments are logged.
   */
  callIsolated(projectId: string, call: IsolatedCall): Promise<unknown>;
  /** `http://127.0.0.1:<port>` the project's Chrome listens (or will listen) on. */
  cdpUrlFor(projectId: string): string;
  /** Whether the project's Chrome is up right now. */
  isRunning(projectId: string): boolean;
  /** Remembered unpacked extensions, with what the running Chrome reports about each. */
  extensions(projectId: string): Promise<BrowserExtension[]>;
  /**
   * Checks `dir` (an existing folder with a manifest.json), starts the browser if needed, loads the extension
   * through CDP and remembers the folder, so every later start loads it again (Chrome forgets CDP-loaded ones).
   */
  loadExtension(projectId: string, dir: string): Promise<BrowserExtension[]>;
  /** Unloads (when running) and forgets the folder. */
  removeExtension(projectId: string, dir: string): Promise<BrowserExtension[]>;
  /** Brings the project's Chrome window to the front on the engine machine's screen ("visible" window mode only). */
  showWindow(projectId: string): Promise<void>;
  /**
   * Gizli tarayıcı: the project's window mode changed. A running Chrome in the other mode is closed gracefully and
   * started again in the new one: its tabs come back (session restore), and every viewer keeps its screencast.
   */
  applyWindow(projectId: string): Promise<void>;
  /** The project's page zoom: the user's choice (persisted), else the configured default. */
  zoomOf(projectId: string): number;
  /**
   * İş Z: changes the project's zoom — one value for every viewer, persisted (see `decideZoom` for who may change
   * it). Answers the zoom now in effect and whether the request set it; a refused request throws INVALID.
   */
  setZoom(projectId: string, zoom: number | null, mode?: BrowserZoomMode): Promise<{ zoom: number; applied: boolean }>;
  /**
   * A viewer reports its panel's size. Only the viewport owner's size is used: the page viewport of the project's
   * active tab becomes panel ÷ zoom (kept for later tabs/starts until the engine restarts). `interaction` makes the
   * reporter the owner; without it the report counts only from the owner or when nobody owns. Answers whether the
   * size was used. The owner sending the same size again asserts it again (heals a stale one).
   */
  setViewport(projectId: string, view: PanelView, by: ViewportReport): Promise<boolean>;
  /** Whether `key` is the viewer whose panel the page's viewport follows. */
  isViewportOwner(projectId: string, key: object): boolean;
  /** Running browsers' tab or URL changed, or a browser started/stopped. Returns unsubscribe. */
  onChange(cb: (projectId: string) => void): () => void;
  /**
   * Masaüstü: keeps a tab of the Chrome live beside the active one — its own CDP session, page size (its picture ÷
   * its zoom), screencast and input — under `key` (a window). Starts Chrome when needed. The tab is `opts.tabId`
   * when Chrome still has it (an engine restart that adopted the running Chrome), else a new one, in a window of its
   * own, at `opts.url`. Pinning a key that is pinned answers the live tab it has.
   */
  pin<M extends LiveFrame>(projectId: string, key: string, opts: PinOptions<M>): Promise<LiveTab<M>>;
  /** The live tab pinned under `key`, if Chrome runs and holds it. */
  pinned(projectId: string, key: string): LiveTab<LiveFrame> | undefined;
  /** Lets go of the pinned tab and closes it (no-op when not pinned). */
  unpin(projectId: string, key: string): Promise<void>;
  /**
   * A page opened a new page itself (`window.open`, `target=_blank`) whose opener is a PINNED tab: the pin's owner
   * decides what becomes of it (the Masaüstü shows it as a child window or closes it). Returns unsubscribe.
   */
  onPopup(cb: (projectId: string, popup: { tabId: string; openerId: string; url: string }) => void): () => void;
  /** The running Chrome's pages as Chrome reports them (with their openers); [] when it is not running. */
  pages(projectId: string): Promise<TargetInfo[]>;
  /** Closes every page except `keep` (and except pinned ones): tabs a restored session brought back. */
  closeOtherTabs(projectId: string, keep: ReadonlySet<string>): Promise<void>;
  shutdown(): Promise<void>;
}

export interface BrowserManagerDeps {
  config: BrowserConfig;
  /** `<dataDir>`; profiles live in `<dataDir>/<profilesDirName>`. */
  dataDir: string;
  logger: Logger;
  spawn?: typeof nodeSpawn;
  /** Where each project's unpacked-extension folders are remembered (default: memory only). */
  extensionStore?: BrowserExtensionStore;
  /** Adım 9 İş A: where each project's DevTools port is remembered (default: memory only, i.e. this run). */
  portStore?: BrowserPortStore;
  /** Where each project's zoom is remembered (default: memory only, i.e. this run). */
  zoomStore?: BrowserZoomStore;
  /**
   * Whether a started Chrome shows its first tab as the active one (default true). The Masaüstü's Chrome shows only
   * pinned tabs (one per window) and has no active tab of its own.
   */
  activateOnStart?: boolean;
  /**
   * Masaüstü's real Chrome (a visible, unmodified Chrome): no startup window, no session restore, every page opened
   * in a MINIMIZED window of its own — off the engine Mac's screen, still painting (measured, Chrome 157: minimized
   * with the backgrounding switches, a page streams ~23 frames/s, stays "visible" and takes input).
   */
  quietWindows?: boolean;
  /**
   * Whether live tabs get the title watcher (a binding and a script in the page). Default true; false for a Chrome
   * whose pages must stay untouched (the real Chrome): titles are then read from Chrome's target list.
   */
  pageScripts?: boolean;
  /** Adım 9 İş A: a project's Chrome is up and answering on `cdpUrlFor(projectId)`. A throw is logged. */
  onStarted?: (projectId: string) => void;
  /** Gizli tarayıcı: the project's window mode (default: every project "hidden"). Read at each start. */
  windowOf?: (projectId: string) => BrowserWindowMode;
  /**
   * What the installed Chrome reports of itself with no override (default: probeChromeIdentity — a throwaway
   * headless Chrome, once per manager). The hidden browsers' identity is built from it.
   */
  chromeProbe?: (fresh?: boolean) => Promise<ChromeProbe>;
  /** `ps -ax -ww -o pid=,uid=,command=` output (default: runs it): candidates for a Chrome left on a profile. */
  processList?: () => Promise<string>;
  /** Runs `lsof` with these args (default: config.lsofPath): what a candidate pid really runs and listens on. */
  lsof?: (args: string[]) => Promise<string>;
}

/** How a pinned tab is made and shown (BrowserManager.pin). */
export interface PinOptions<M extends LiveFrame> {
  url: string;
  /** The tab it had before, if any: kept when Chrome still has it. */
  tabId?: string | undefined;
  view(): PanelView | undefined;
  zoom(): number;
  frame(frameId: number, data: string, metadata: BrowserFrameMetadata): M;
  /** Its title or address changed, or it came into view. */
  changed(): void;
  /** Chrome closed it without `unpin`. */
  gone(): void;
}

/** A tab kept live beside the active one (a Masaüstü window). */
interface Pinned {
  live: LiveTab<LiveFrame>;
  /** Chrome closed the tab without `unpin` (the page closed itself, a crash, an agent). */
  gone(): void;
}

interface Instance {
  projectId: string;
  port: number;
  proc: ChildProcess | null;
  cdp: CdpConnection;
  tabs: Map<string, BrowserTab>;
  /** The active tab: what the project's Tarayıcı panel shows; it moves with tab switches. */
  main: LiveTab<BrowserFrameMessage>;
  /** Tabs kept live at the same time, each with its own session, size and screencast (Masaüstü windows). */
  pinned: Map<string, Pinned>;
  closing: boolean;
  /** Tabs we asked Chrome to close: hidden until Chrome reports them destroyed (getTargets may still list them). */
  closingTabs: Set<string>;
  /**
   * Tabs Chrome reported destroyed. Its Target.getTargets may still name one for a moment (seen under load: the
   * closed tab came back at the end of the list); kept here until an answer no longer names it.
   */
  destroyedTabs: Set<string>;
  /**
   * The tab the user asked for last (browser.selectTab). Switches run one at a time; a click that is overtaken by a
   * newer one while it waits for its turn is skipped, so a burst of clicks ends on the last one without showing
   * every tab in between.
   */
  wantedTab: string | undefined;
  /** Tab id → its close while that is under way: the same tab asked again joins it instead of closing twice. */
  closes: Map<string, Promise<BrowserState>>;
  /** Settles when every tab close asked so far is done (or failed): closes run one at a time. */
  closeQueue: Promise<void>;
  /** How it was started: "hidden" = headless (no window on the engine Mac's screen). */
  window: BrowserWindowMode;
  /** The browser process (ours or an adopted one), when known: a restart waits for it to exit. */
  pid: number | undefined;
  /** Gizli tarayıcı kimliği: set while this connection gives every target the hidden identity. */
  identity?: IdentityHandle;
}

type VersionInfo = { webSocketDebuggerUrl?: unknown };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `ps` output of a busy Mac: a few hundred processes with long command lines. */
const PS_MAX_BUFFER = 16 * 1024 * 1024;

/** Chrome's profile lock: a symlink to "<hostname>-<pid>". */
const SINGLETON_LOCK = "SingletonLock";

/** The pid a profile lock names, if the lock is a symlink owned by `uid`. */
function ownLink(path: string, uid: number): number | null {
  try {
    const st = lstatSync(path);
    return st.isSymbolicLink() && st.uid === uid ? singletonLockPid(readlinkSync(path)) : null;
  } catch {
    return null;
  }
}

/** The profile's DevToolsActivePort, if it is a regular file (not a link) owned by `uid`. */
function ownActivePort(path: string, uid: number): number | null {
  try {
    const st = lstatSync(path);
    return st.isFile() && st.uid === uid ? parseDevToolsActivePort(readFileSync(path, "utf8")) : null;
  } catch {
    return null;
  }
}

function resolved(path: string | null): string | null {
  if (path === null) return null;
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, but is not ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ host: LOOPBACK, port, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

function memoryPortStore(): BrowserPortStore {
  const m = new Map<string, number>();
  return {
    getBrowserPort: (id) => m.get(id),
    listBrowserPorts: () => Object.fromEntries(m),
    setBrowserPort: (id, port) => void (port === undefined ? m.delete(id) : m.set(id, port)),
  };
}

function memoryZoomStore(): BrowserZoomStore {
  const m = new Map<string, number | null>();
  return {
    getBrowserZoom: (id) => m.get(id),
    setBrowserZoom: (id, zoom) => void (zoom === undefined ? m.delete(id) : m.set(id, zoom)),
  };
}

function memoryExtensionStore(): BrowserExtensionStore {
  const m = new Map<string, string[]>();
  return {
    getBrowserExtensions: (id) => [...(m.get(id) ?? [])],
    setBrowserExtensions: (id, dirs) => void (dirs.length === 0 ? m.delete(id) : m.set(id, [...dirs])),
  };
}

/**
 * Gizli tarayıcı kimliği: asks the installed Chrome what it reports of itself (probeChromeIdentity) at the first
 * call, and hands every later call that answer; a failure, or a call with `fresh` (the installed Chrome changed),
 * is asked again. One per engine: the project and the Masaüstü managers share it (one throwaway Chrome, not two).
 */
export function chromeProbeOnce(config: BrowserConfig, spawn: typeof nodeSpawn = nodeSpawn): (fresh?: boolean) => Promise<ChromeProbe> {
  let asked: Promise<ChromeProbe> | undefined;
  return (fresh = false) => {
    if (fresh) asked = undefined;
    const p = (asked ??= probeChromeIdentity({
      chromePath: config.chromePath,
      // Never the real keychain, whatever the config says: the probe's profile is a throwaway.
      args: [HEADLESS_ARG, "--no-first-run", "--no-default-browser-check", ...TEST_MODE_ARGS, BLANK],
      url: config.identityProbeUrl,
      timeoutMs: config.startTimeoutMs,
      pollMs: config.pollIntervalMs,
      cdpTimeoutMs: config.cdpTimeoutMs,
      spawn,
    }).catch((err: unknown) => {
      if (asked === p) asked = undefined;
      throw err;
    }));
    return p;
  };
}

export function createBrowserManager(deps: BrowserManagerDeps): BrowserManager {
  const { config, logger } = deps;
  const spawn = deps.spawn ?? nodeSpawn;
  const windowOf = (projectId: string): BrowserWindowMode => (config.headless ? "hidden" : (deps.windowOf?.(projectId) ?? "hidden"));
  const runFile = (file: string, args: string[]) =>
    new Promise<string>((resolve, reject) =>
      execFile(file, args, { timeout: config.startTimeoutMs, maxBuffer: PS_MAX_BUFFER }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
    );
  const processList = deps.processList ?? (() => runFile(config.psPath, ["-ax", "-ww", "-o", "pid=,uid=,command="]));
  // lsof exits 1 when it finds nothing: that is an empty answer, not an error.
  const lsof = deps.lsof ?? ((args: string[]) => runFile(config.lsofPath, args).catch(() => ""));
  /**
   * The hidden browsers' identity: asked of the installed Chrome once per manager (best effort: none = headless
   * Chrome's own). A failed probe is asked again at the next start.
   */
  let hiddenIdentity: Promise<HiddenIdentity | undefined> | undefined;
  /** A started or adopted Chrome was not the probed build (updated on disk): the next start asks Chrome again. */
  let probeStale = false;
  const probeChrome = deps.chromeProbe ?? chromeProbeOnce(config, spawn);
  function identityFor(window: BrowserWindowMode): Promise<HiddenIdentity | undefined> {
    if (window !== "hidden" || config.headless || !config.hiddenIdentity || config.hiddenUserAgent === null) return Promise.resolve(undefined);
    const fresh = probeStale;
    probeStale = false;
    if (fresh) hiddenIdentity = undefined;
    const asked = (hiddenIdentity ??= probeChrome(fresh)
      .then((probe) => {
        const id = identityFromProbe(probe);
        if (!id) throw new Error(`unusable probe answer (${probe.product})`);
        logger.info("hidden browser identity", { product: id.product, userAgent: id.userAgent, metadata: id.userAgentMetadata !== undefined });
        return id;
      })
      .catch((err: unknown) => {
        logger.warn("chrome identity unknown; the hidden browser keeps headless Chrome's User-Agent", { err: errText(err) });
        if (hiddenIdentity === asked) hiddenIdentity = undefined;
        return undefined;
      }));
    return asked;
  }
  /**
   * The Chrome running the profile, verified (verifyProfileChrome): a process of our own user, named by the
   * profile's own lock, running the configured Chrome, listening on the DevTools port. Only such a process is ever
   * adopted, connected to or signalled; argv alone is anybody's to write. null = none, or not provably ours.
   */
  async function profileChrome(dir: string): Promise<ProfileChrome | null> {
    const uid = process.getuid?.();
    if (uid === undefined) return null;
    let candidate: ProfileChrome | null;
    try {
      candidate = findProfileChrome(await processList(), dir, uid);
    } catch (err) {
      logger.warn("listing processes failed", { err: errText(err) });
      return null;
    }
    if (!candidate) return null;
    const pid = String(candidate.pid);
    const [exe, listen] = await Promise.all([
      lsof(["-a", "-p", pid, "-d", "txt", "-Fn"]),
      lsof(["-a", "-p", pid, "-iTCP", "-sTCP:LISTEN", "-P", "-n", "-Fn"]),
    ]);
    const chromePath = resolved(config.chromePath) ?? config.chromePath;
    const mapped = resolved(lsofExecutable(exe));
    const facts = {
      candidate,
      lockPid: ownLink(join(dir, SINGLETON_LOCK), uid),
      // Chrome runs a code-sign clone of itself from the temp dir: the same bytes count as the configured one.
      executable: isChromeExecutable(mapped, chromePath) ? chromePath : mapped,
      chromePath,
      // The very address fetchVersion/connectCdp use below.
      listening: lsofListenPorts(listen, LOOPBACK),
      activePort: ownActivePort(join(dir, DEVTOOLS_ACTIVE_PORT), uid),
    };
    const verified = verifyProfileChrome(facts);
    if (!verified) {
      logger.warn("a process names the project's browser profile but is not provably its Chrome; left alone", {
        pid: candidate.pid,
        lockPid: facts.lockPid,
        executableIsChrome: facts.executable === facts.chromePath,
        argvPort: candidate.port,
        activePort: facts.activePort,
        listening: facts.listening,
      });
    }
    return verified;
  }
  const profilesRoot = join(deps.dataDir, config.profilesDirName);
  const instances = new Map<string, Instance>();
  /** İş Z: zoom per project — the user's choice, kept in the engine state — applied to every tab the screencast shows. */
  const zoomStore = deps.zoomStore ?? memoryZoomStore();
  const zoomOf = (projectId: string): number => zoomStore.getBrowserZoom(projectId) ?? config.defaultZoom;
  /**
   * Per project: the owner's panel (absent = no app reported one yet: the page keeps Chrome's window size) and the
   * viewer (connection) whose panel the page's viewport follows — the one whose user last used its panel. Other
   * viewers' reports are ignored, so two apps with panels of different sizes never fight over the page.
   */
  const viewports = new ViewportOwners<string>();
  /** `key` no longer drives the project's viewport (it left); the page keeps its size until someone reports one. */
  function releaseOwner(projectId: string, key: object): void {
    if (viewports.release(projectId, key)) emitChange(projectId);
  }
  const starting = new Map<string, Promise<Instance>>();
  /** Pins under way, by project and key: a second pin of the same key joins the first. */
  const pinning = new Map<string, Promise<LiveTab<LiveFrame>>>();
  const changeListeners = new Set<(projectId: string) => void>();
  const popupListeners = new Set<(projectId: string, popup: { tabId: string; openerId: string; url: string }) => void>();
  const changeTimers = new Map<string, NodeJS.Timeout>();
  /** One port per project, remembered in the store (terminals' KOKPIT_CDP_URL, the project's Claude settings file). */
  const ports = createPortAllocator({
    base: config.cdpPortBase,
    span: config.cdpPortSpan,
    store: deps.portStore ?? memoryPortStore(),
    isPortFree,
    logger,
  });
  const extensionStore = deps.extensionStore ?? memoryExtensionStore();
  /** projectId → folder → why its last load failed. */
  const extensionErrors = new Map<string, Map<string, string>>();
  let stopped = false;

  function emitChange(projectId: string): void {
    if (changeTimers.has(projectId)) return;
    const t = setTimeout(() => {
      changeTimers.delete(projectId);
      for (const cb of [...changeListeners]) {
        try {
          cb(projectId);
        } catch (err) {
          logger.warn("browser change listener failed", { projectId, err: errText(err) });
        }
      }
    }, config.changeCoalesceMs);
    t.unref();
    changeTimers.set(projectId, t);
  }

  /** The running Chrome's port (an adopted one may lie outside the range), else the project's allocated port. */
  const portFor = (projectId: string): number => instances.get(projectId)?.port ?? ports.portFor(projectId);

  async function fetchVersion(port: number): Promise<VersionInfo | null> {
    try {
      const res = await fetch(`http://${LOOPBACK}:${port}/json/version`, { signal: AbortSignal.timeout(config.cdpTimeoutMs) });
      if (!res.ok) return null;
      return (await res.json()) as VersionInfo;
    } catch {
      return null;
    }
  }

  function wsUrlOf(info: VersionInfo, port: number): string {
    const raw = info.webSocketDebuggerUrl;
    if (typeof raw !== "string") throw engineError("INTERNAL", "engine.browser.devtoolsUnreadable");
    const url = new URL(raw);
    if (url.hostname !== LOOPBACK || Number(url.port) !== port) {
      throw engineError("INTERNAL", "engine.browser.devtoolsUnexpected");
    }
    return raw;
  }

  function ensureProfile(projectId: string): string {
    const dir = profileDir(profilesRoot, projectId);
    if (!existsSync(profilesRoot)) mkdirSync(profilesRoot);
    if (!existsSync(dir)) mkdirSync(dir);
    return dir;
  }

  /** A verified Chrome left running on this profile by an earlier engine process, still answering on loopback. */
  async function findOrphan(found: ProfileChrome | null): Promise<{ port: number; info: VersionInfo } | null> {
    if (found?.port == null) return null;
    const info = await fetchVersion(found.port);
    return info ? { port: found.port, info } : null;
  }

  async function launch(projectId: string): Promise<Instance> {
    const dir = ensureProfile(projectId);
    const window = windowOf(projectId);
    const found = await profileChrome(dir);
    let orphan = await findOrphan(found);
    let proc: ChildProcess | null = null;
    let pid = orphan ? found?.pid : undefined;
    let port: number;
    let info: VersionInfo;
    if (orphan) {
      // A Chrome left by an earlier engine (e.g. the version before the window setting: a visible window) keeps
      // running in its mode: restart it in the project's. Unknown mode = leave it as it is.
      if (found && found.headless !== (window === "hidden")) {
        logger.info("restarting the project's Chrome in its window mode", { projectId, window });
        await closeOrphan(orphan, found.pid, projectId);
        orphan = null;
        pid = undefined;
      }
    }
    if (orphan) {
      logger.info("reusing a running Chrome for the project's profile", { projectId, port: orphan.port });
      port = orphan.port;
      info = orphan.info;
      ports.adopt(projectId, port);
    } else {
      rmSync(join(dir, DEVTOOLS_ACTIVE_PORT), { force: true });
      port = await ports.freePortFor(projectId);
      const userAgent = (await identityFor(window))?.userAgent;
      const args = chromeArgs({
        profileDir: dir,
        port,
        headless: config.headless,
        window,
        ...(userAgent === undefined ? {} : { userAgent }),
        testMode: config.testMode,
        windowWidth: config.windowWidth,
        windowHeight: config.windowHeight,
        hasSavedSession: hasSavedSession(dir),
        ...(deps.quietWindows ? { quiet: true } : {}),
      });
      const child = spawn(config.chromePath, args, { stdio: "ignore" });
      proc = child;
      let exited: string | null = null;
      child.once("exit", (code, signal) => (exited = `${code ?? signal}`));
      child.once("error", (err) => (exited = err.message));
      const deadline = Date.now() + config.startTimeoutMs;
      let found: VersionInfo | null = null;
      while (!found) {
        if (exited !== null) throw engineError("INTERNAL", "engine.browser.chromeStartFailed", { reason: exited });
        if (Date.now() > deadline) {
          child.kill("SIGKILL");
          throw engineError("INTERNAL", "engine.browser.chromeTimeout");
        }
        found = await fetchVersion(port);
        if (!found) await sleep(config.pollIntervalMs);
      }
      info = found;
      pid = child.pid;
      logger.info("chrome started", { projectId, port, pid: child.pid, window });
    }

    let cdp: CdpConnection;
    try {
      cdp = await connectCdp(wsUrlOf(info, port), { timeoutMs: config.cdpTimeoutMs });
    } catch (err) {
      proc?.kill("SIGKILL");
      throw err instanceof EngineError ? err : engineError("INTERNAL", "engine.browser.chromeConnectFailed", { reason: errText(err) });
    }
    const inst: Instance = {
      projectId,
      port,
      proc,
      cdp,
      tabs: new Map(),
      main: undefined as unknown as LiveTab<BrowserFrameMessage>,
      pinned: new Map(),
      closing: false,
      closingTabs: new Set(),
      wantedTab: undefined,
      destroyedTabs: new Set(),
      closes: new Map(),
      closeQueue: Promise.resolve(),
      window,
      pid,
    };
    inst.main = new LiveTab<BrowserFrameMessage>({
      cdp,
      config,
      logger,
      label: { projectId },
      view: () => viewports.view(projectId),
      zoom: () => zoomOf(projectId),
      frame: (frameId, data, metadata) => ({ type: "browser.frame", projectId, frameId, data, metadata }),
      changed: () => emitChange(projectId),
      hasTab: (tabId) => inst.tabs.has(tabId) && !hiddenTab(inst, tabId),
      current: () => !inst.closing && instances.get(projectId) === inst,
      bringToFront: true,
    });
    cdp.on((method, params, sessionId) => onCdpEvent(inst, method, params, sessionId));
    cdp.onClose(() => forget(inst, "cdp closed"));
    proc?.once("exit", () => {
      forget(inst, "chrome exited");
    });
    try {
      await applyHiddenIdentity(inst);
      await cdp.send("Target.setDiscoverTargets", { discover: true });
      const { targetInfos } = await cdp.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
      for (const t of targetInfos) if (t.type === "page") inst.tabs.set(t.targetId, toTab(t));
      // A Chrome that only holds pinned tabs (the Masaüstü's) shows no active tab of its own (nor a blank one).
      if (deps.activateOnStart !== false) await activate(inst, [...inst.tabs.keys()][0] ?? (await createTab(inst, BLANK)));
      await loadRememberedExtensions(inst);
    } catch (err) {
      await stopInstance(inst);
      throw err instanceof EngineError ? err : engineError("INTERNAL", "engine.browser.chromePrepareFailed", { reason: errText(err) });
    }
    return inst;
  }

  /**
   * A hidden Chrome — started now or adopted from an earlier engine — gets the identity on every target over this
   * connection (the CDP overrides end with it). Only the build that was probed: a Chrome of another version (updated
   * on disk while an older one runs) keeps its `--user-agent` alone, and the next start probes again.
   */
  async function applyHiddenIdentity(inst: Instance): Promise<void> {
    const identity = await identityFor(inst.window);
    if (!identity) return;
    const { product } = await inst.cdp.send<{ product?: string }>("Browser.getVersion");
    if (product !== identity.product) {
      logger.warn("the running Chrome is not the probed one; its client hints are left as they are", { projectId: inst.projectId, product, probed: identity.product });
      probeStale = true;
      return;
    }
    // A target that fails is usually one that closed while being set up: logged, not warned.
    inst.identity = await applyIdentity(inst.cdp, identity, (msg, err) => logger.info(msg, { projectId: inst.projectId, err: errText(err) }), config.cdpTimeoutMs);
  }

  async function createTab(inst: Instance, url: string, newWindow = false): Promise<string> {
    // In the background: on a visible Chrome a foreground target activates the app (measured); the tab is brought
    // forward by switchTo when it is to be shown. A pinned tab gets a window of its own (headless: every window
    // paints, so all of them stream at once — measured, Chrome 157).
    // A hidden Chrome's tab opens blank and loads its address once its identity is in place: an address given to
    // Target.createTarget is requested before any override can be (IdentityHandle.navigate).
    const viaIdentity = inst.identity !== undefined && url !== BLANK;
    const { targetId } = await inst.cdp.send<{ targetId: string }>("Target.createTarget", {
      url: viaIdentity ? BLANK : url,
      background: true,
      ...(newWindow ? { newWindow: true } : {}),
      // Never on the engine Mac's screen: a quiet Chrome's windows open minimized (and keep painting).
      ...(newWindow && deps.quietWindows ? { windowState: "minimized" } : {}),
    });
    // Usually Target.targetCreated came first and listed (and logged) it already.
    if (!inst.tabs.has(targetId)) {
      inst.tabs.set(targetId, { id: targetId, title: "", url });
      logger.info(TAB_LOG.created, { projectId: inst.projectId, tabId: targetId, tabs: inst.tabs.size });
    }
    if (viaIdentity) {
      await inst.identity!.navigate(targetId, url).catch((err: unknown) =>
        logger.warn("loading a new tab's address failed", { projectId: inst.projectId, tabId: targetId, err: errText(err) }),
      );
    }
    return targetId;
  }

  /** The live tab holding CDP session `sessionId` (the active one or a pinned one), if any. */
  function liveOf(inst: Instance, sessionId: string | undefined): LiveTab<LiveFrame> | undefined {
    if (sessionId === undefined) return undefined;
    if (inst.main.sessionId === sessionId) return inst.main;
    for (const p of inst.pinned.values()) if (p.live.sessionId === sessionId) return p.live;
    return undefined;
  }

  function pinnedByTab(inst: Instance, tabId: string): [string, Pinned] | undefined {
    for (const entry of inst.pinned) if (entry[1].live.tabId === tabId) return entry;
    return undefined;
  }

  function onCdpEvent(inst: Instance, method: string, params: Record<string, unknown>, sessionId: string | undefined): void {
    switch (method) {
      case "Target.targetCreated":
      case "Target.targetInfoChanged": {
        const t = params.targetInfo as TargetInfo | undefined;
        if (!t || t.type !== "page" || hiddenTab(inst, t.targetId)) return;
        const isNew = !inst.tabs.has(t.targetId);
        inst.tabs.set(t.targetId, toTab(t));
        if (isNew) logger.info(TAB_LOG.created, { projectId: inst.projectId, tabId: t.targetId, tabs: inst.tabs.size });
        emitChange(inst.projectId);
        // A pinned tab's title or address changed: its viewers re-read it.
        pinnedByTab(inst, t.targetId)?.[1].live.changed();
        // A pinned tab's page opened it: its owner shows it (Masaüstü: a child window) or closes it.
        if (isNew && t.openerId !== undefined && pinnedByTab(inst, t.openerId)) {
          for (const cb of [...popupListeners]) {
            try {
              cb(inst.projectId, { tabId: t.targetId, openerId: t.openerId, url: t.url });
            } catch (err) {
              logger.warn("popup listener failed", { projectId: inst.projectId, err: errText(err) });
            }
          }
          return;
        }
        // A tab the page itself opened (link with target=_blank, window.open) takes over the view, as in Chrome.
        if (isNew && t.openerId !== undefined && t.openerId === inst.main.tabId) {
          void switchTo(inst, t.targetId).catch((err: unknown) => logger.warn("switch to new tab failed", { err: errText(err) }));
        }
        return;
      }
      case "Target.targetDestroyed": {
        const id = params.targetId as string | undefined;
        if (id === undefined) return;
        const asked = inst.closingTabs.delete(id);
        const listed = inst.tabs.delete(id);
        inst.destroyedTabs.add(id);
        if (asked || listed) logger.info(TAB_LOG.destroyed, { projectId: inst.projectId, tabId: id, asked, tabs: inst.tabs.size });
        const pinned = pinnedByTab(inst, id);
        if (pinned && !inst.closing) {
          const [key, p] = pinned;
          inst.pinned.delete(key);
          p.live.dispose();
          logger.warn("a pinned browser tab went away", { projectId: inst.projectId, key, tabId: id });
          try {
            p.gone();
          } catch (err) {
            logger.warn("pinned tab listener failed", { projectId: inst.projectId, err: errText(err) });
          }
        }
        if (!listed) return;
        emitChange(inst.projectId);
        if (id === inst.main.tabId && !inst.closing) {
          inst.main.forgetTab();
          const next = [...inst.tabs.keys()].find((t) => !pinnedByTab(inst, t));
          void (next !== undefined ? switchTo(inst, next) : createTab(inst, BLANK).then((t) => switchTo(inst, t))).catch(
            (err: unknown) => logger.warn("replacing the closed tab failed", { err: errText(err) }),
          );
        }
        return;
      }
      // Chrome let go of a live tab's session without the engine asking: it attaches again (LiveTab.onDetached).
      case "Target.detachedFromTarget": {
        const sid = params.sessionId as string | undefined;
        if (inst.closing || sid === undefined) return;
        liveOf(inst, sid)?.onDetached(sid);
        return;
      }
      // A live tab's title watcher saw document.title change.
      case "Runtime.bindingCalled":
        if (params.name === TITLE_BINDING) liveOf(inst, sessionId)?.changed();
        return;
      // A load finished in a live tab: titles changed, tell the viewers to refetch.
      case "Page.loadEventFired":
      case "Page.frameNavigated":
        liveOf(inst, sessionId)?.changed();
        return;
      case "Page.screencastFrame": {
        const live = liveOf(inst, sessionId);
        if (live) live.onFrame(params, sessionId);
        // A frame of a session no live tab holds any more (switched away): acknowledged, never shown.
        else if (typeof params.sessionId === "number" && sessionId !== undefined) {
          inst.cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }, sessionId).catch(() => {});
        }
        return;
      }
    }
  }

  /** The active tab of `inst` becomes `tabId` (see LiveTab.attach). */
  function activate(inst: Instance, tabId: string): Promise<void> {
    return inst.main.attach(tabId);
  }

  /** Runs `fn` after everything queued on the project's active tab (tab switches, zoom and viewport changes). */
  function serial(inst: Instance, fn: () => Promise<void>): Promise<void> {
    return inst.main.serial(fn);
  }

  function switchTo(inst: Instance, tabId: string): Promise<void> {
    return serial(inst, () => activate(inst, tabId));
  }

  function forget(inst: Instance, reason: string): void {
    if (instances.get(inst.projectId) !== inst) return;
    instances.delete(inst.projectId);
    logger.info("browser gone", { projectId: inst.projectId, reason });
    if (!inst.cdp.closed) inst.cdp.close();
    emitChange(inst.projectId);
  }

  async function stopInstance(inst: Instance): Promise<void> {
    inst.closing = true;
    inst.main.dispose();
    for (const p of inst.pinned.values()) p.live.dispose();
    const proc = inst.proc;
    const exited =
      proc && proc.exitCode === null && proc.signalCode === null
        ? new Promise<void>((r) => proc.once("exit", () => r()))
        : Promise.resolve();
    // Graceful: Chrome writes cookies and the rest of the profile before it exits.
    await inst.cdp.send("Browser.close").catch(() => {});
    if (proc) {
      const killed = await Promise.race([exited.then(() => true), sleep(config.stopGraceMs).then(() => false)]);
      if (!killed) {
        logger.warn("chrome did not exit after Browser.close; killing it", { projectId: inst.projectId });
        proc.kill("SIGKILL");
        await exited;
      }
    } else if (inst.pid !== undefined) {
      // Adopted: not our child, so no exit event. A restart must not start a second Chrome on the same profile.
      await waitExit(inst.pid, inst.projectId);
    }
    forget(inst, "closed");
  }

  /** Waits (at most stopGraceMs) for a process that is not our child to exit, then kills it. */
  async function waitExit(pid: number, projectId: string): Promise<void> {
    const deadline = Date.now() + config.stopGraceMs;
    while (alive(pid)) {
      if (Date.now() > deadline) {
        logger.warn("chrome did not exit after Browser.close; killing it", { projectId, pid });
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          return;
        }
        const killDeadline = Date.now() + config.stopGraceMs;
        while (alive(pid) && Date.now() < killDeadline) await sleep(config.pollIntervalMs);
        return;
      }
      await sleep(config.pollIntervalMs);
    }
  }

  /** Closes a Chrome left by an earlier engine (gracefully: it writes its session and cookies first). */
  async function closeOrphan(orphan: { port: number; info: VersionInfo }, pid: number, projectId: string): Promise<void> {
    try {
      const cdp = await connectCdp(wsUrlOf(orphan.info, orphan.port), { timeoutMs: config.cdpTimeoutMs });
      await cdp.send("Browser.close").catch(() => {});
      if (!cdp.closed) cdp.close();
    } catch (err) {
      logger.warn("closing the earlier Chrome over DevTools failed", { projectId, err: errText(err) });
    }
    await waitExit(pid, projectId);
  }

  function errorsOf(projectId: string): Map<string, string> {
    let m = extensionErrors.get(projectId);
    if (!m) extensionErrors.set(projectId, (m = new Map()));
    return m;
  }

  /** Extensions.loadUnpacked; a Chrome refusal becomes INVALID with Chrome's reason. */
  async function loadInto(inst: Instance, dir: string): Promise<string> {
    try {
      const { id } = await inst.cdp.send<{ id: string }>("Extensions.loadUnpacked", { path: dir });
      errorsOf(inst.projectId).delete(dir);
      return id;
    } catch (err) {
      const reason = errText(err);
      errorsOf(inst.projectId).set(dir, reason);
      if (/not found|unknown method|wasn't found/i.test(reason)) {
        throw engineError("INVALID", "engine.browser.extensionsNotAllowed");
      }
      throw engineError("INVALID", "engine.browser.extensionLoadFailed", { reason });
    }
  }

  /** Chrome forgets CDP-loaded extensions when it exits: every start loads the remembered folders again. */
  async function loadRememberedExtensions(inst: Instance): Promise<void> {
    for (const dir of extensionStore.getBrowserExtensions(inst.projectId)) {
      try {
        loadable(inst.projectId, dir);
        await loadInto(inst, dir);
      } catch (err) {
        logger.warn("remembered extension not loaded", { projectId: inst.projectId, dir, err: errText(err) });
      }
    }
  }

  /** checkExtensionDir, remembering the failure for the list. */
  function loadable(projectId: string, dir: string): string {
    try {
      return checkExtensionDir(dir);
    } catch (err) {
      errorsOf(projectId).set(dir, errText(err));
      throw err;
    }
  }

  async function loadedExtensions(projectId: string): Promise<CdpExtensionInfo[] | null> {
    const inst = instances.get(projectId);
    if (!inst) return null;
    try {
      return (await inst.cdp.send<{ extensions: CdpExtensionInfo[] }>("Extensions.getExtensions")).extensions;
    } catch (err) {
      logger.warn("listing extensions failed", { projectId, err: errText(err) });
      return [];
    }
  }

  async function extensionsOf(projectId: string): Promise<BrowserExtension[]> {
    const loaded = await loadedExtensions(projectId);
    return mergeExtensions(extensionStore.getBrowserExtensions(projectId), loaded, errorsOf(projectId));
  }

  async function get(projectId: string): Promise<Instance> {
    const running = instances.get(projectId);
    if (running) return running;
    const pending = starting.get(projectId);
    if (pending) return pending;
    if (stopped) throw engineError("INVALID", "engine.browser.engineStopping");
    const p = launch(projectId)
      .then((inst) => {
        instances.set(projectId, inst);
        emitChange(projectId);
        try {
          deps.onStarted?.(projectId);
        } catch (err) {
          logger.warn("browser start listener failed", { projectId, err: errText(err) });
        }
        return inst;
      })
      .finally(() => starting.delete(projectId));
    starting.set(projectId, p);
    return p;
  }

  function requireRunning(projectId: string): Instance {
    const inst = instances.get(projectId);
    if (!inst) throw engineError("NOT_FOUND", "engine.browser.notRunning");
    return inst;
  }

  /**
   * Chrome does not report title-only changes (e.g. `document.title = …` or a finished load) as
   * targetInfoChanged, so the tab list is re-read from Target.getTargets whenever someone asks.
   */
  async function refreshTabs(inst: Instance): Promise<void> {
    let infos: TargetInfo[];
    try {
      infos = (await inst.cdp.send<{ targetInfos: TargetInfo[] }>("Target.getTargets")).targetInfos;
    } catch {
      return;
    }
    inst.tabs = mergeTabs(inst.tabs.keys(), infos, (id) => hiddenTab(inst, id));
    // Once Chrome stops naming a destroyed tab it never names it again: nothing left to hide.
    const named = new Set(infos.map((t) => t.targetId));
    for (const id of inst.destroyedTabs) if (!named.has(id)) inst.destroyedTabs.delete(id);
  }

  /** A tab that must not be listed whatever Chrome says: its close is under way, or Chrome reported it destroyed. */
  function hiddenTab(inst: Instance, tabId: string): boolean {
    return inst.closingTabs.has(tabId) || inst.destroyedTabs.has(tabId);
  }

  async function stateOf(projectId: string): Promise<BrowserState> {
    const inst = instances.get(projectId);
    if (!inst) return { running: false, tabs: [], zoom: zoomOf(projectId) };
    await refreshTabs(inst);
    return {
      running: true,
      tabs: [...inst.tabs.values()],
      ...(inst.main.tabId !== undefined ? { activeTabId: inst.main.tabId } : {}),
      // Read last: an answer that follows a zoom change never carries the older zoom.
      zoom: zoomOf(projectId),
    };
  }

  async function onActive<T>(projectId: string, fn: (inst: Instance, sessionId: string) => Promise<T>): Promise<BrowserState> {
    const inst = requireRunning(projectId);
    await fn(inst, await inst.main.readySession());
    return stateOf(projectId);
  }

  /** Kopyalama: one of browser-clipboard.ts's expressions in the active tab (see LiveTab.evaluate). */
  function evaluateInPage(projectId: string, expression: string): Promise<unknown> {
    return requireRunning(projectId).main.evaluate(expression);
  }

  async function historyStep(projectId: string, delta: -1 | 1): Promise<BrowserState> {
    return onActive(projectId, async (inst, sid) => {
      const h = await inst.cdp.send<{ currentIndex: number; entries: { id: number }[] }>("Page.getNavigationHistory", {}, sid);
      const entry = h.entries[h.currentIndex + delta];
      if (entry) await inst.cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id }, sid);
    });
  }

  /** Closes one tab of a running Chrome (see `closeTab`, which runs these one at a time). */
  async function closeOne(inst: Instance, tabId: string): Promise<BrowserState> {
    const projectId = inst.projectId;
    await inst.main.queue;
    await refreshTabs(inst);
    if (!inst.tabs.has(tabId)) throw engineError("NOT_FOUND", "engine.browser.tabNotFound");
    const order = [...inst.tabs.keys()];
    logger.info(TAB_LOG.closeAsked, { projectId, tabId, active: tabId === inst.main.tabId, tabs: order.length });
    // Chrome must never be left without a page (nor the strip without a tab): the last tab is replaced by a blank one first.
    if (order.length === 1) await createTab(inst, BLANK);
    // From now on it is not listed and cannot be selected (a click on it answers NOT_FOUND): the strip drops it now.
    inst.closingTabs.add(tabId);
    emitChange(projectId);
    try {
      // Decided when the switch's turn comes: a tab the user clicked meanwhile may already be in front.
      await serial(inst, async () => {
        if (tabId !== inst.main.tabId || inst.closing) return;
        const at = order.indexOf(tabId);
        // A tab the user clicked and is waiting for; else, as in Chrome, the tab to the right, else the one to the left.
        const candidates = new Set([inst.wantedTab, ...order.slice(at + 1), ...order.slice(0, at).reverse(), ...inst.tabs.keys()]);
        for (const id of candidates) {
          if (id === undefined || id === tabId || !inst.tabs.has(id) || hiddenTab(inst, id) || pinnedByTab(inst, id)) continue;
          try {
            await activate(inst, id);
            return;
          } catch (err) {
            // Gone meanwhile: the next one takes over.
            if (!(err instanceof EngineError && err.code === "NOT_FOUND")) throw err;
          }
        }
      });
      inst.tabs.delete(tabId);
      await inst.cdp.send("Target.closeTarget", { targetId: tabId });
    } catch (err) {
      inst.closingTabs.delete(tabId);
      await refreshTabs(inst);
      emitChange(projectId);
      throw err instanceof EngineError ? err : engineError("INTERNAL", "engine.browser.tabCloseFailed", { reason: errText(err) });
    }
    emitChange(projectId);
    return stateOf(projectId);
  }

  /** Restarts the project's running Chrome when its window mode is not the project's (see applyWindow). */
  async function applyWindowMode(projectId: string): Promise<void> {
    const pending = starting.get(projectId);
    if (pending) await pending.catch(() => {});
    const inst = instances.get(projectId);
    if (!inst || inst.window === windowOf(projectId)) return;
    const viewers = [...inst.main.subscribers.entries()];
    logger.info("restarting the project's Chrome in its window mode", { projectId, window: windowOf(projectId) });
    await stopInstance(inst);
    const next = await get(projectId);
    // The viewers keep watching: the new Chrome's frames go to them as before (a viewer that left meanwhile asked
    // the new instance to stop and is not there to carry over).
    for (const [key, sub] of viewers) {
      if (!next.main.subscribers.has(key)) await next.main.subscribe(key, sub.opts, sub.send).catch(() => {});
    }
  }

  /** Closes one tab, after the closes asked before it. */
  function queueClose(inst: Instance, tabId: string): Promise<BrowserState> {
    // The same tab asked again while its close is under way (a double click on "×") is the same request and
    // gets the same answer. Treated as a second close, the last tab was given two blank replacements.
    const same = inst.closes.get(tabId);
    if (same) return same;
    // One close at a time: "is this the last tab?" is asked when the closes before it are done.
    const turn = inst.closeQueue.then(() => closeOne(inst, tabId));
    inst.closeQueue = turn.then(
      () => {},
      () => {},
    );
    const closing = turn.finally(() => {
      if (inst.closes.get(tabId) === closing) inst.closes.delete(tabId);
    });
    inst.closes.set(tabId, closing);
    return closing;
  }

  return {
    async open(projectId) {
      await get(projectId);
      return stateOf(projectId);
    },
    async close(projectId) {
      const pending = starting.get(projectId);
      if (pending) await pending.catch(() => {});
      const inst = instances.get(projectId);
      if (inst) await stopInstance(inst);
    },
    state: stateOf,
    navigate: (projectId, url) =>
      onActive(projectId, async (inst, sid) => {
        const r = await inst.cdp.send<{ errorText?: string }>("Page.navigate", { url }, sid);
        if (r.errorText) throw engineError("INVALID", "engine.browser.pageOpenFailed", { reason: r.errorText });
      }),
    back: (projectId) => historyStep(projectId, -1),
    forward: (projectId) => historyStep(projectId, 1),
    reload: (projectId, ignoreCache = false) => onActive(projectId, (inst, sid) => inst.cdp.send("Page.reload", ignoreCache ? { ignoreCache: true } : {}, sid)),
    async selectTab(projectId, tabId) {
      const inst = requireRunning(projectId);
      const gone = () => !inst.tabs.has(tabId) || hiddenTab(inst, tabId);
      if (gone()) throw engineError("NOT_FOUND", "engine.browser.tabNotFound");
      inst.wantedTab = tabId;
      await serial(inst, async () => {
        // Overtaken by a newer click while waiting for its turn: that one is shown, not this.
        if (inst.wantedTab !== tabId || inst.closing) return;
        inst.wantedTab = undefined;
        // Closed (or being closed) since it was asked for.
        if (gone()) {
          emitChange(projectId);
          throw engineError("NOT_FOUND", "engine.browser.tabNotFound");
        }
        if (inst.main.tabId === tabId && inst.main.sessionId) return;
        await activate(inst, tabId);
      });
      return stateOf(projectId);
    },
    async newTab(projectId, url) {
      const inst = requireRunning(projectId);
      await refreshTabs(inst);
      if (inst.tabs.size >= config.maxTabs) throw engineError("INVALID", "engine.browser.tooManyTabs", { max: config.maxTabs });
      const id = await createTab(inst, url ?? BLANK);
      await switchTo(inst, id);
      return stateOf(projectId);
    },
    async openUrl(projectId, url) {
      // Started here = nobody could have used its blank tab yet (a start already under way is somebody else's).
      const started = !instances.has(projectId) && !starting.has(projectId);
      const inst = await get(projectId);
      // Decided before anything else is awaited: a second link asked at the same moment has not opened its tab yet.
      const plan = openUrlPlan({ started, tabs: [...inst.tabs.values()], activeTabId: inst.main.tabId });
      await inst.main.queue;
      await refreshTabs(inst);
      if (inst.tabs.size >= config.maxTabs) throw engineError("INVALID", "engine.browser.tooManyTabs", { max: config.maxTabs });
      // Target.createTarget answers as soon as the tab exists; it does not wait for the page.
      const id = await createTab(inst, url);
      await switchTo(inst, id);
      if (plan.kind === "replace") {
        // Best effort: an empty tab left over is a blemish, not a failure of the request.
        await queueClose(inst, plan.tabId).catch((err: unknown) => logger.warn("closing the blank start tab failed", { projectId, err: errText(err) }));
      }
      return stateOf(projectId);
    },
    async closeTab(projectId, tabId) {
      return queueClose(requireRunning(projectId), tabId);
    },
    subscribe: (projectId, key, opts, send) => requireRunning(projectId).main.subscribe(key, opts, send),
    unsubscribe(projectId, key) {
      // A viewer that stops watching no longer drives the viewport.
      releaseOwner(projectId, key);
      instances.get(projectId)?.main.unsubscribe(key);
    },
    unsubscribeAll(key) {
      // Also projects whose browser is not running: a size reported before it started made `key` their owner.
      for (const projectId of new Set([...instances.keys(), ...viewports.keys()])) this.unsubscribe(projectId, key);
      // Pinned tabs (Masaüstü windows) have their own viewers; their owner drops them (unpin / its own release).
      for (const inst of instances.values()) for (const p of inst.pinned.values()) p.live.unsubscribe(key);
    },
    ack(projectId, key, frameId) {
      instances.get(projectId)?.main.ack(key, frameId);
    },
    input: (projectId, event) => requireRunning(projectId).main.input(event),
    async copySelection(projectId, opts) {
      const value = await evaluateInPage(projectId, selectionScript({ maxChars: config.clipboardMaxChars, cut: opts.cut }));
      return parseSelection(value, config.clipboardMaxChars);
    },
    async pasteText(projectId, text) {
      const inst = requireRunning(projectId);
      if (text.length > config.clipboardMaxChars) {
        throw engineError("INVALID", "engine.browser.pasteTooLarge", { max: config.clipboardMaxChars });
      }
      await inst.main.insertText(text);
    },
    async contextAt(projectId, at) {
      return parseContext(await evaluateInPage(projectId, contextScript({ ...at, maxUrlLength: BROWSER_LIMITS.maxUrlLength })));
    },
    async callIsolated(projectId, call) {
      const inst = requireRunning(projectId);
      const sid = await inst.main.readySession();
      return callInIsolatedWorld((method, params) => inst.cdp.send(method, params, sid), call);
    },
    cdpUrlFor: (projectId) => `http://${LOOPBACK}:${portFor(projectId)}`,
    isRunning: (projectId) => instances.has(projectId),
    extensions: extensionsOf,
    async loadExtension(projectId, dir) {
      const real = checkExtensionDir(dir);
      const remembered = extensionStore.getBrowserExtensions(projectId);
      if (!remembered.includes(real) && remembered.length >= BROWSER_LIMITS.maxExtensions) {
        throw engineError("INVALID", "engine.browser.tooManyExtensions", { max: BROWSER_LIMITS.maxExtensions });
      }
      const inst = await get(projectId);
      const loaded = await loadedExtensions(projectId);
      // Loading the same folder twice would only reload it; Chrome keeps one entry per folder.
      if (!loaded?.some((e) => e.path === real)) await loadInto(inst, real);
      if (!remembered.includes(real)) extensionStore.setBrowserExtensions(projectId, [...remembered, real]);
      logger.info("extension loaded", { projectId, dir: real });
      return extensionsOf(projectId);
    },
    async removeExtension(projectId, dir) {
      const loaded = await loadedExtensions(projectId);
      const hit = loaded?.find((e) => e.path === dir);
      const inst = instances.get(projectId);
      if (hit && inst) await inst.cdp.send("Extensions.uninstall", { id: hit.id });
      extensionStore.setBrowserExtensions(
        projectId,
        extensionStore.getBrowserExtensions(projectId).filter((d) => d !== dir),
      );
      errorsOf(projectId).delete(dir);
      logger.info("extension removed", { projectId, dir });
      return extensionsOf(projectId);
    },
    zoomOf,
    async setZoom(projectId, zoom, mode) {
      if (zoom !== null && (!Number.isFinite(zoom) || zoom < BROWSER_LIMITS.minZoom || zoom > BROWSER_LIMITS.maxZoom)) {
        throw engineError("INVALID", "engine.browser.badZoom");
      }
      const before = zoomOf(projectId);
      const decision = decideZoom(zoomStore.getBrowserZoom(projectId), config.defaultZoom, zoom, mode);
      if (decision.kind === "refuse") {
        throw engineError("INVALID", mode === undefined && zoom !== null ? "engine.browser.zoomAppTooOld" : "engine.browser.badZoomRequest");
      }
      if (decision.kind === "keep") return { zoom: before, applied: false };
      zoomStore.setBrowserZoom(projectId, decision.value);
      const now = zoomOf(projectId);
      if (now !== before) {
        // Every app showing the project reads the new zoom.
        emitChange(projectId);
        const inst = instances.get(projectId);
        if (inst) await inst.main.reapply(true);
      }
      return { zoom: now, applied: true };
    },
    async setViewport(projectId, view, by) {
      if (!panelOverride(view, 1)) throw engineError("INVALID", "engine.browser.badPanelSize");
      // Decided here, synchronously, in the order the reports arrive: no two viewers can both win.
      const r = viewports.report(projectId, { width: view.width, height: view.height }, by);
      if (!r.applied) return false;
      if (r.ownerChanged) emitChange(projectId);
      const inst = instances.get(projectId);
      if (inst) await inst.main.reapply(r.changed);
      return true;
    },
    isViewportOwner: (projectId, key) => viewports.isOwner(projectId, key),
    applyWindow: applyWindowMode,
    async showWindow(projectId) {
      const inst = requireRunning(projectId);
      if (inst.window === "hidden") {
        throw engineError("INVALID", "engine.browser.hiddenOnScreen");
      }
      await inst.main.queue;
      const targetId = inst.main.tabId;
      if (!targetId) throw engineError("NOT_FOUND", "engine.browser.noActiveTab");
      const { windowId } = await inst.cdp.send<{ windowId: number }>("Browser.getWindowForTarget", { targetId });
      // Un-minimize, then activate the tab: on macOS that also brings Chrome in front of other apps.
      await inst.cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
      await inst.cdp.send("Target.activateTarget", { targetId });
    },
    async pin<M extends LiveFrame>(projectId: string, key: string, opts: PinOptions<M>): Promise<LiveTab<M>> {
      const inst = await get(projectId);
      const had = inst.pinned.get(key);
      if (had) return had.live as unknown as LiveTab<M>;
      const pending = pinning.get(`${projectId}\u0000${key}`);
      if (pending) return pending as Promise<LiveTab<M>>;
      const p = (async () => {
        await refreshTabs(inst);
        const reuse = opts.tabId !== undefined && inst.tabs.has(opts.tabId) && !hiddenTab(inst, opts.tabId) && !pinnedByTab(inst, opts.tabId);
        const tabId = reuse ? opts.tabId! : await createTab(inst, opts.url, true);
        const live: LiveTab<M> = new LiveTab<M>({
          cdp: inst.cdp,
          config,
          logger,
          label: { projectId, key },
          view: opts.view,
          zoom: opts.zoom,
          frame: opts.frame,
          changed: opts.changed,
          hasTab: (id) => inst.tabs.has(id) && !hiddenTab(inst, id),
          current: (): boolean => !inst.closing && instances.get(projectId) === inst && inst.pinned.get(key)?.live === (live as unknown),
          // Its own window: nothing to bring to the front of (and never the engine Mac's screen).
          bringToFront: false,
          watchTitle: deps.pageScripts !== false,
        });
        inst.pinned.set(key, { live: live as unknown as LiveTab<LiveFrame>, gone: opts.gone });
        try {
          await live.serial(() => live.attach(tabId));
        } catch (err) {
          inst.pinned.delete(key);
          live.dispose();
          throw err;
        }
        logger.info("browser tab pinned", { projectId, key, tabId, reused: reuse });
        return live;
      })().finally(() => pinning.delete(`${projectId}\u0000${key}`));
      pinning.set(`${projectId}\u0000${key}`, p as Promise<LiveTab<LiveFrame>>);
      return p;
    },
    pinned: (projectId, key) => instances.get(projectId)?.pinned.get(key)?.live,
    async unpin(projectId, key) {
      await pinning.get(`${projectId}\u0000${key}`)?.catch(() => {});
      const inst = instances.get(projectId);
      const p = inst?.pinned.get(key);
      if (!inst || !p) return;
      inst.pinned.delete(key);
      p.live.dispose();
      const tabId = p.live.tabId;
      if (tabId === undefined) return;
      inst.closingTabs.add(tabId);
      inst.tabs.delete(tabId);
      emitChange(projectId);
      await inst.cdp.send("Target.closeTarget", { targetId: tabId }).catch((err: unknown) =>
        logger.warn("closing a pinned tab failed", { projectId, key, err: errText(err) }),
      );
      logger.info("browser tab unpinned", { projectId, key, tabId });
    },
    async closeOtherTabs(projectId, keep) {
      const inst = instances.get(projectId);
      if (!inst) return;
      await refreshTabs(inst);
      for (const tabId of [...inst.tabs.keys()]) {
        if (keep.has(tabId) || pinnedByTab(inst, tabId)) continue;
        await queueClose(inst, tabId).catch((err: unknown) => logger.warn("closing a leftover tab failed", { projectId, err: errText(err) }));
      }
    },
    onPopup(cb) {
      popupListeners.add(cb);
      return () => popupListeners.delete(cb);
    },
    async pages(projectId) {
      const inst = instances.get(projectId);
      if (!inst) return [];
      try {
        const { targetInfos } = await inst.cdp.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
        return targetInfos.filter((t) => t.type === "page" && !hiddenTab(inst, t.targetId));
      } catch {
        return [];
      }
    },
    onChange(cb) {
      changeListeners.add(cb);
      return () => changeListeners.delete(cb);
    },
    async shutdown() {
      stopped = true;
      await Promise.allSettled([...starting.values()]);
      await Promise.allSettled([...instances.values()].map(stopInstance));
      for (const t of changeTimers.values()) clearTimeout(t);
      changeTimers.clear();
    },
  };
}
