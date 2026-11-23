// Wire protocol between the Kokpit app and the engine.
//
// Transport: one WebSocket per app window, JSON text frames.
// 1. Mutual authentication (auth.ts): client `auth.hello {nonce}` → engine `auth.challenge {nonce}` → client
//    `auth.proof` → engine `hello.ok {…, proof}`, or a close with CLOSE_CODES.UNAUTHORIZED. The access key never
//    crosses the wire; the client sends NOTHING else until it has verified the engine's proof in `hello.ok`.
//    A client of the old protocol (`hello` with the key in clear) is closed with CLOSE_CODES.OUTDATED_CLIENT.
// 2. Client sends `req` frames (answered by a `res` with the same id) and
//    fire-and-forget `input` / `resize` frames.
// 3. Engine pushes `output`, `exit` and `event` frames.
//
// Terminal streaming: a client receives output for a terminal only after
// `terminal.attach` (or `terminal.open`, which attaches implicitly). On attach
// the engine first sends the buffered history as `output` frames with
// `replay: true` — as many as it takes to keep each one inside MAX_MESSAGE_BYTES,
// numbered by `part` (see OUTPUT_LIMITS, splitOutputData) — then live output.
// Attach is per connection; reconnecting clients re-attach.
import { z } from "zod";
import { INVISIBLE_CHARS, LINK_LIMITS, parseLinkTarget } from "./link-url.ts";
import { AppUpdateRequestParams, BuildInfoSchema, type AppUpdateResultMap } from "./app-update.ts"; // Kendini güncelleme
import { GrantIdSchema, NonceSchema, ProofSchema } from "./auth.ts";
import { PATH_LIMITS } from "./local-path.ts";
import { st } from "./i18n/catalog.ts";
import { zm } from "./zod-message.ts";

/** Largest frame either side accepts, in bytes of UTF-16 code units (string length). */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

export const CLOSE_CODES = {
  /** Wrong or missing proof, unknown grant, a reused nonce, or no handshake within the engine's auth timeout. */
  UNAUTHORIZED: 4401,
  /** A client of the old protocol: it sent its key in clear (`hello`). Nothing is checked; it must be updated. */
  OUTDATED_CLIENT: 4426,
  /** Malformed frame. */
  BAD_MESSAGE: 4400,
} as const;

export const ERROR_CODES = [
  "NOT_FOUND",
  "DIRTY_WORKTREE",
  "INVALID",
  "GIT_FAILED",
  "TERMINAL_EXITED",
  "INTERNAL",
  /** İş A (Adım 7): the `claude` CLI could not run or failed; message is Turkish, for the user. */
  "CLAUDE_FAILED",
  /** A scoped connection asked for something outside its scope (Adım 9 İş K), or a terminal's credential for another project. */
  "FORBIDDEN",
  // ---- Girişler ----
  /** The engine machine's Keychain could not be used (locked, access denied, waiting for approval, no answer). */
  "KEYCHAIN_FAILED",
  /** Too many requests of this kind in a short time (logins.fill). */
  "RATE_LIMITED",
  /**
   * logins.fill was asked without the user's acceptance of the agent risk for that project (`logins.risk.set`), or
   * — while a terminal that can reach the browser is running — without `confirmAgentRisk` in the request.
   */
  "LOGIN_RISK_UNACCEPTED",
  // ---- Kendini güncelleme ----
  /**
   * A well-formed request named a method this engine does not have (the app is newer than the engine). The
   * connection stays open; the message names the method.
   */
  "UNKNOWN_METHOD",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

// ---------- domain ----------

const ID_MAX_CHARS = 200;
const Id = z.string().min(1).max(ID_MAX_CHARS);
const Dim = z.number().int().min(1).max(1000);

// Strings that end up as argv for ssh/git must never look like options or contain shell syntax.
const SAFE_TOKEN = /^[A-Za-z0-9_][A-Za-z0-9._@:+-]*$/;
const AbsPath = z.string().min(1).max(4096).refine((p) => p.startsWith("/"), zm("validation.absPath"));
const Name = z.string().trim().min(1).max(100);
const Command = z.string().trim().min(1).max(1000);
/** https://… or git@host:owner/repo — never an option (`-…`) or a local/file URL. */
const GitUrl = z
  .string()
  .trim()
  .max(1000)
  .refine((u) => /^https:\/\/[^\s]+$/.test(u) || /^git@[A-Za-z0-9.-]+:[^\s]+$/.test(u), zm("validation.gitUrl"));
/** A file NAME inside ~/.ssh (no directories). */
const KeyFileName = z.string().min(1).max(255).regex(/^[A-Za-z0-9_][A-Za-z0-9._-]*$/, zm("validation.sshKeyFile"));
const HostToken = z.string().min(1).max(255).regex(SAFE_TOKEN, zm("validation.badChar"));
const Port = z.number().int().min(1).max(65535);

// ---- tarayıcı (İş B) ----
// A real Chrome per project with its own persistent profile. `runOn: "engine"` (default): the engine starts it
// with CDP on 127.0.0.1 only and streams it here as a JPEG screencast; input goes back over CDP.
// `runOn: "client"`: the app's machine opens it in its own window (the agent cannot drive that one).
// Frames: engine → `browser.frame`; the client answers each with `browser.ack` (the engine keeps a small
// in-flight window per client and only lets Chrome produce the next frame while some client has room).

/**
 * Kopyalama (akıtılan yüzeyler): clipboard text that crosses the wire — the remote page's selection, the remote
 * Mac's pasteboard, and what is pasted into either. Text only. `maxChars` (UTF-16 units) keeps one frame under
 * MAX_MESSAGE_BYTES even when JSON escapes every character (6 bytes each). The engine's own caps (config) may be
 * lower, never higher.
 */
export const CLIPBOARD_LIMITS = { maxChars: 100_000 } as const;
const ClipboardText = z.string().min(1).max(CLIPBOARD_LIMITS.maxChars);

/** Sanity bounds of the browser protocol (not settings). */
export const BROWSER_LIMITS = {
  maxUrlLength: LINK_LIMITS.maxUrlLength,
  maxScreencastDim: 4096,
  /** base64 JPEG characters per frame; leaves room for the JSON envelope under MAX_MESSAGE_BYTES. */
  maxFrameChars: MAX_MESSAGE_BYTES - 64 * 1024,
  maxCoord: 100_000,
  maxWheelDelta: 100_000,
  maxKeyLength: 64,
  maxTextLength: 10_000,
  maxTabs: 500,
  maxExtensionPathLength: 4096,
  maxExtensions: 100,
  /** İş Z: sanity range of a page zoom (the app's own steps live in its config). */
  minZoom: 0.25,
  maxZoom: 5,
  /** Size of the app panel that shows the page (CSS px), and of the page viewport the engine derives from it. */
  minViewportDim: 16,
  maxViewportDim: 8192,
} as const;

/** Who says so in `browser.zoom.set` (see there). */
export const BROWSER_ZOOM_MODES = ["user", "adopt"] as const;
export type BrowserZoomMode = (typeof BROWSER_ZOOM_MODES)[number];

export const BROWSER_RUN_ON = ["engine", "client"] as const;
export type BrowserRunOn = (typeof BROWSER_RUN_ON)[number];
/**
 * How a project's engine Chrome shows on the engine Mac's own screen. "hidden" (the default, also for projects that
 * predate the setting): no window, no Dock icon, never in front — the app's panel is its only view. "visible": a
 * real Chrome window there ("Mac mini ekranında göster"), for Chrome's own windows that never reach the panel (the
 * sync confirmation, extension pop-ups, permission prompts).
 */
export const BROWSER_WINDOW_MODES = ["hidden", "visible"] as const;
export type BrowserWindowMode = (typeof BROWSER_WINDOW_MODES)[number];
export const ProjectBrowserSchema = z.object({ runOn: z.enum(BROWSER_RUN_ON), window: z.enum(BROWSER_WINDOW_MODES).optional() }).strict();
export type ProjectBrowser = z.infer<typeof ProjectBrowserSchema>;
/** The project's browser window mode; absent = "hidden". */
export function browserWindowOf(project: { browser?: ProjectBrowser | undefined }): BrowserWindowMode {
  return project.browser?.window ?? "hidden";
}

const BROWSER_URL_PROTOCOLS = new Set(["http:", "https:", "about:", "chrome:"]);
/** Where the user may send a browser: http(s), about: and chrome: pages. Never file:, javascript:, data:… */
export const BrowserUrlSchema = z
  .string()
  .min(1)
  .max(BROWSER_LIMITS.maxUrlLength)
  .refine((u) => {
    if (/\s/.test(u)) return false;
    try {
      return BROWSER_URL_PROTOCOLS.has(new URL(u).protocol);
    } catch {
      return false;
    }
  }, zm("validation.httpUrl"));

/**
 * Bağlantılar: an address a program printed in a terminal and the user chose to open. Stricter than
 * BrowserUrlSchema: http(s) only, no credentials, no whitespace or control characters (link-url.ts).
 */
export const LinkUrlSchema = z
  .string()
  .min(1)
  .max(BROWSER_LIMITS.maxUrlLength)
  .refine((u) => parseLinkTarget(u).kind === "web", zm("validation.httpUrl"));

export const BrowserTabSchema = z.object({ id: Id, title: z.string(), url: z.string() });
export type BrowserTab = z.infer<typeof BrowserTabSchema>;
const BrowserZoom = z.number().min(BROWSER_LIMITS.minZoom).max(BROWSER_LIMITS.maxZoom);
export const BrowserStateSchema = z.object({
  running: z.boolean(),
  tabs: z.array(BrowserTabSchema).max(BROWSER_LIMITS.maxTabs),
  activeTabId: Id.optional(),
  /**
   * The project's page zoom (1 = 100 %): one value shared by every app that shows the project's browser, owned and
   * persisted by the engine (also reported while the browser is closed). Absent only from engines older than that.
   */
  zoom: BrowserZoom.optional(),
  /**
   * Whether the connection that asked drives the page's viewport (see `browser.viewport.set`): the other viewers
   * get the same frames and fit them into their own panels.
   */
  viewportOwner: z.boolean().optional(),
});
export type BrowserState = z.infer<typeof BrowserStateSchema>;

const Coord = z.number().min(0).max(BROWSER_LIMITS.maxCoord);
const WheelDelta = z.number().min(-BROWSER_LIMITS.maxWheelDelta).max(BROWSER_LIMITS.maxWheelDelta);
export const BrowserModifiersSchema = z
  .object({ alt: z.boolean(), ctrl: z.boolean(), meta: z.boolean(), shift: z.boolean() })
  .partial()
  .strict();
export type BrowserModifiers = z.infer<typeof BrowserModifiersSchema>;
export const BrowserInputEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("mouse"),
      action: z.enum(["move", "down", "up"]),
      x: Coord,
      y: Coord,
      button: z.enum(["none", "left", "middle", "right"]).optional(),
      clickCount: z.number().int().min(0).max(3).optional(),
      modifiers: BrowserModifiersSchema.optional(),
    })
    .strict(),
  z
    .object({ type: z.literal("wheel"), x: Coord, y: Coord, deltaX: WheelDelta, deltaY: WheelDelta, modifiers: BrowserModifiersSchema.optional() })
    .strict(),
  z
    .object({
      type: z.literal("key"),
      /** `char` = a lone character event (keydown with a printable key already produces one). */
      action: z.enum(["down", "up", "char"]),
      /** DOM KeyboardEvent.key, e.g. "a", "Enter", "ArrowLeft". */
      key: z.string().min(1).max(BROWSER_LIMITS.maxKeyLength),
      /** DOM KeyboardEvent.code, e.g. "KeyA" ("" when unknown). */
      code: z.string().max(BROWSER_LIMITS.maxKeyLength),
      /** Windows virtual key code (DOM keyCode). */
      keyCode: z.number().int().min(0).max(1000).optional(),
      location: z.number().int().min(0).max(3).optional(),
      repeat: z.boolean().optional(),
      modifiers: BrowserModifiersSchema.optional(),
    })
    .strict(),
  /** Inserts text as if typed by an IME / paste (no key events). */
  z.object({ type: z.literal("text"), text: z.string().min(1).max(BROWSER_LIMITS.maxTextLength) }).strict(),
]);
export type BrowserInputEvent = z.infer<typeof BrowserInputEventSchema>;

/** CDP Page.ScreencastFrameMetadata: what the frame shows, in CSS pixels of the page. */
export const BrowserFrameMetadataSchema = z.object({
  deviceWidth: z.number(),
  deviceHeight: z.number(),
  pageScaleFactor: z.number(),
  offsetTop: z.number(),
  scrollOffsetX: z.number(),
  scrollOffsetY: z.number(),
  timestamp: z.number().optional(),
});
export type BrowserFrameMetadata = z.infer<typeof BrowserFrameMetadataSchema>;

/**
 * Folder of an unpacked (developer) extension on the engine machine: absolute, no `.`/`..` segments, no NUL.
 * The engine additionally requires an existing directory with a manifest.json.
 */
export const ExtensionDirSchema = z
  .string()
  .min(2)
  .max(BROWSER_LIMITS.maxExtensionPathLength)
  .refine((p) => p.startsWith("/"), zm("validation.absPath"))
  .refine((p) => !p.includes("\0"), zm("validation.badChar"))
  .refine((p) => p.split("/").every((seg) => seg !== "." && seg !== ".."), zm("validation.pathDots"));

/** An unpacked extension of a project: remembered folder + what the running Chrome reports about it. */
export const BrowserExtensionSchema = z.object({
  path: z.string(),
  /** Chrome's extension id; absent while not loaded. */
  id: z.string().optional(),
  name: z.string().optional(),
  version: z.string().optional(),
  /** True while the running Chrome has it loaded. */
  loaded: z.boolean(),
  /** Why the last load failed (Turkish or Chrome's own text). */
  error: z.string().optional(),
});
export type BrowserExtension = z.infer<typeof BrowserExtensionSchema>;

const ProjectRef = { projectId: Id };
const FrameId = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

// ---- yollar: a local file path a program printed in a terminal (local-path.ts) ----
// The path is resolved by the ENGINE, on the machine the file is on: `~` and `$HOME` are the engine user's home, a
// relative path is relative to the terminal's current directory (else the card's / project's folder).

const LocalPathRefShape = {
  /** The terminal that printed the path: its project, its card and its current directory are used. */
  terminalId: Id.optional(),
  projectId: Id.optional(),
  cardId: Id.optional(),
  /** As written: absolute, `~/…`, `$HOME/…` or relative. */
  path: z.string().min(1).max(PATH_LIMITS.maxPathChars),
  /** What followed an unquoted path on its line (FoundPath.tail): the engine may find a longer path with spaces. */
  tail: z.string().max(PATH_LIMITS.maxTailChars).optional(),
};
const oneLocalPathOwner = (o: { terminalId?: string | undefined; projectId?: string | undefined; cardId?: string | undefined }): boolean =>
  [o.terminalId, o.projectId, o.cardId].filter((v) => v !== undefined).length === 1;
const ONE_LOCAL_PATH_OWNER = zm("validation.localPathOwner");
/** `{ terminalId | cardId | projectId, path, tail? }`. */
export const LocalPathRefSchema = z.object(LocalPathRefShape).strict().refine(oneLocalPathOwner, ONE_LOCAL_PATH_OWNER);
export type LocalPathRef = z.infer<typeof LocalPathRefSchema>;

// ---- /yollar ----

export const BrowserRequestParams = {
  /** Starts (or reuses) the project's Chrome on the engine machine. INVALID for `runOn: "client"` projects. */
  "browser.open": z.object(ProjectRef).strict(),
  "browser.close": z.object(ProjectRef).strict(),
  /** State of the project's browser; `running: false` (no error) when it is not open. */
  "browser.tabs": z.object(ProjectRef).strict(),
  "browser.navigate": z.object({ ...ProjectRef, url: BrowserUrlSchema }).strict(),
  "browser.back": z.object(ProjectRef).strict(),
  "browser.forward": z.object(ProjectRef).strict(),
  /** `ignoreCache`: ⇧⌘R — the page and its resources come from the network again. */
  "browser.reload": z.object({ ...ProjectRef, ignoreCache: z.boolean().optional() }).strict(),
  "browser.selectTab": z.object({ ...ProjectRef, tabId: Id }).strict(),
  "browser.newTab": z.object({ ...ProjectRef, url: BrowserUrlSchema.optional() }).strict(),
  /**
   * Bağlantılar: opens a link from a terminal in the project's Chrome — starts it when it is not running, shows the
   * address in a NEW tab (what the user or an agent has open stays) and makes that tab the active one. Only the
   * blank tab of a Chrome this very request started is reused. INVALID for `runOn: "client"` projects.
   */
  "browser.openUrl": z.object({ ...ProjectRef, url: LinkUrlSchema }).strict(),
  /**
   * Yollar: shows a local file (a web page with the files next to it, a picture, a video, a PDF) in the project's
   * Chrome, like `browser.openUrl` does for an address. The engine serves the file's folder under a token-bound
   * preview address of its own listener (never `file:`) and opens that; the address never passes through the app.
   * INVALID for `runOn: "client"` projects (use `files.previewUrl`), SSH projects (and any kind without a folder here), and refused folders.
   */
  "browser.openFile": LocalPathRefSchema,
  /** Adım 7: closes one tab; closing the last one leaves a fresh blank tab (Chrome never has zero pages). */
  "browser.closeTab": z.object({ ...ProjectRef, tabId: Id }).strict(),
  /** Subscribes this connection to frames of the active tab (the newest request's size/quality wins). */
  "browser.screencast.start": z
    .object({
      ...ProjectRef,
      maxWidth: z.number().int().min(1).max(BROWSER_LIMITS.maxScreencastDim),
      maxHeight: z.number().int().min(1).max(BROWSER_LIMITS.maxScreencastDim),
      quality: z.number().int().min(1).max(100),
    })
    .strict(),
  "browser.screencast.stop": z.object(ProjectRef).strict(),
  /** Unpacked extensions remembered for the project (re-loaded on every browser start). */
  "browser.extensions.list": z.object(ProjectRef).strict(),
  /** Starts the browser if needed, loads the folder's extension and remembers it. */
  "browser.extensions.loadUnpacked": z.object({ ...ProjectRef, path: ExtensionDirSchema }).strict(),
  /** Unloads it (when running) and forgets it. */
  "browser.extensions.remove": z.object({ ...ProjectRef, path: ExtensionDirSchema }).strict(),
  /** Brings the project's Chrome window to the front of the engine machine's screen (e.g. for Screen Sharing). */
  "browser.showWindow": z.object(ProjectRef).strict(),
  /**
   * İş Z: page zoom of the project's browser (1 = 100 %). The page itself renders at that zoom (CSS px = panel px
   * / zoom), and screencast frame metadata reports the zoomed CSS size, so input mapping stays exact.
   * The zoom is ONE value per project, owned by the engine: persisted in its state, reported in `BrowserState.zoom`
   * and announced with `browser.changed`. Apps show it and change it; they never push a copy of their own.
   * - `mode: "user"` — the user changed it in this app just now (menu, shortcut). `zoom: null` = back to the
   *   engine's configured default (`browser.defaultZoom`). Always applied: the last user action wins.
   * - `mode: "adopt"` — a zoom an older app kept in its own UI state, handed over once: applied only when nobody
   *   ever chose a zoom for the project (answer `applied: false` otherwise).
   * - no `mode` — an app from before the engine owned the zoom, which re-sent its own copy whenever its panel
   *   started or reconnected: treated like "adopt", and refused (INVALID) when it would change the project's zoom.
   */
  "browser.zoom.set": z
    .object({ ...ProjectRef, zoom: BrowserZoom.nullable(), mode: z.enum(BROWSER_ZOOM_MODES).optional() })
    .strict()
    .refine((p) => p.zoom !== null || p.mode === "user", zm("validation.zoomUserOnly")),
  /**
   * The picture area of the app's Tarayıcı panel, `width` × `height` CSS px. The engine makes the page's layout
   * viewport panel ÷ zoom — the picture then has the panel's aspect and always fits it — whatever size Chrome's
   * own window has. Applied to every tab the screencast shows; agents driving the same page see this viewport.
   * Several apps may show one project's browser in panels of different sizes; only ONE of them — the viewport
   * owner — drives the size:
   * - `interaction: true` (the user just used this panel: pointer or keyboard in it, a zoom step, a resize of the
   *   window they are working in) makes the sender the owner and applies its size;
   * - without it the size is applied only when the sender already is the owner or nobody is (the owner's
   *   connection closed or it stopped watching); otherwise it is ignored (`applied: false`) and the sender keeps
   *   fitting the owner's frames into its panel.
   * The app sends it only while its panel is visible (never 0×0). Without any, the page keeps Chrome's window size
   * (÷ zoom).
   */
  "browser.viewport.set": z
    .object({
      ...ProjectRef,
      width: z.number().int().min(BROWSER_LIMITS.minViewportDim).max(BROWSER_LIMITS.maxViewportDim),
      height: z.number().int().min(BROWSER_LIMITS.minViewportDim).max(BROWSER_LIMITS.maxViewportDim),
      interaction: z.boolean().optional(),
    })
    .strict(),
  /**
   * Kopyalama: the text the user selected in the active tab's page (also inside an input / textarea and in
   * same-origin frames; never a password field), for the app to put on ITS clipboard. `text: ""` = nothing is
   * selected. `cut`: the page then also cuts it (editable selections only). The only page content this API hands
   * out is what the user selected; a selection over the engine's cap is refused, not truncated.
   */
  "browser.copy": z.object({ ...ProjectRef, cut: z.boolean().optional() }).strict(),
  /** Kopyalama: inserts `text` at the caret of the active tab's page (input, textarea, contenteditable). */
  "browser.paste": z.object({ ...ProjectRef, text: ClipboardText }).strict(),
  /**
   * Kopyalama: what the app's right-click menu needs to know about the page point `x`,`y` (page CSS px, like mouse
   * input): is anything selected, is the focus in an editable field, and the link under the point, if any.
   */
  "browser.context": z.object({ ...ProjectRef, x: Coord, y: Coord }).strict(),
} as const;

export interface BrowserContextInfo {
  hasSelection: boolean;
  /** The page's focus is in an input, textarea or contenteditable: paste has somewhere to go. */
  editable: boolean;
  /** http(s) address of the link under the point. */
  linkUrl?: string;
}

export interface BrowserResultMap {
  "browser.open": { browser: BrowserState };
  "browser.close": Record<string, never>;
  "browser.tabs": { browser: BrowserState };
  "browser.navigate": { browser: BrowserState };
  "browser.back": { browser: BrowserState };
  "browser.forward": { browser: BrowserState };
  "browser.reload": { browser: BrowserState };
  "browser.selectTab": { browser: BrowserState };
  "browser.newTab": { browser: BrowserState };
  "browser.openUrl": { browser: BrowserState };
  "browser.openFile": { browser: BrowserState };
  "browser.closeTab": { browser: BrowserState };
  "browser.screencast.start": Record<string, never>;
  "browser.screencast.stop": Record<string, never>;
  "browser.extensions.list": { extensions: BrowserExtension[] };
  "browser.extensions.loadUnpacked": { extensions: BrowserExtension[] };
  "browser.extensions.remove": { extensions: BrowserExtension[] };
  "browser.showWindow": Record<string, never>;
  /** The project's zoom after the request, and whether the request changed (or confirmed) it. */
  "browser.zoom.set": { zoom: number; applied: boolean };
  /** `applied: false` = another app owns the page's viewport; the size was not used. */
  "browser.viewport.set": { applied: boolean };
  "browser.copy": { text: string };
  "browser.paste": Record<string, never>;
  "browser.context": BrowserContextInfo;
}

const BrowserInputMessageSchema = z
  .object({ type: z.literal("browser.input"), projectId: Id, event: BrowserInputEventSchema })
  .strict();
const BrowserAckMessageSchema = z.object({ type: z.literal("browser.ack"), projectId: Id, frameId: FrameId }).strict();
export type BrowserClientMessage = z.infer<typeof BrowserInputMessageSchema> | z.infer<typeof BrowserAckMessageSchema>;

const BrowserFrameMessageSchema = z.object({
  type: z.literal("browser.frame"),
  projectId: Id,
  frameId: FrameId,
  /** base64 JPEG. */
  data: z.string().max(BROWSER_LIMITS.maxFrameChars),
  metadata: BrowserFrameMetadataSchema,
});
export type BrowserFrameMessage = z.infer<typeof BrowserFrameMessageSchema>;
const BrowserChangedEventSchema = z.object({ type: z.literal("event"), name: z.literal("browser.changed"), projectId: Id });
/**
 * Yollar: a program in one of the project's terminals ran `open <address or page>` and the engine showed it in the
 * project's Chrome (a new, active tab): the app shows the Tarayıcı panel, as it does after a link click.
 */
const BrowserRevealEventSchema = z.object({ type: z.literal("event"), name: z.literal("browser.reveal"), projectId: Id });
// ---- /tarayıcı ----


// ---- girişler (kayıtlı kullanıcı adı + parola) ----
// A project's saved logins for ITS browser. The password lives in the macOS Keychain of the engine machine and is
// WRITE-ONLY on this protocol: `logins.save` carries it in, nothing ever carries it out — `logins.fill` makes the
// engine read it and put it into the page itself (over CDP). Only the app's connection (access key) may use these
// requests; a scoped connection (`hello.screen`) is answered FORBIDDEN like for everything outside its scope.

/** Sanity bounds of the logins protocol (the engine's own caps — config — may be lower, never higher). */
export const LOGIN_LIMITS = {
  /** `scheme://host:port`. */
  maxOriginChars: 300,
  maxUsernameChars: 320,
  /** UTF-16 units. The engine also caps the UTF-8 size (what fits one Keychain command). */
  maxPasswordChars: 1024,
  maxLabelChars: 100,
} as const;

const LOGIN_ORIGIN_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * The origin (scheme + host + port, as the URL standard serializes it) of a page address, or undefined when the
 * page is not an http(s) one. This is the ONLY form a login's site is stored and compared in: exact string
 * equality, so a subdomain, another port or http instead of https is a different site.
 */
export function loginOriginOf(pageUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return undefined;
  }
  if (!LOGIN_ORIGIN_PROTOCOLS.has(url.protocol) || url.hostname === "") return undefined;
  return url.origin.length <= LOGIN_LIMITS.maxOriginChars ? url.origin : undefined;
}

/** A canonical http(s) origin: exactly what `loginOriginOf` returns for it (no path, no default port, lowercase). */
export const LoginOriginSchema = z
  .string()
  .min(1)
  .max(LOGIN_LIMITS.maxOriginChars)
  .refine((o) => loginOriginOf(o) === o, zm("validation.loginOrigin"));

const NO_CONTROL_CHARS = /^[^\u0000-\u001f\u007f]*$/;
/** A lone surrogate does not survive UTF-8 (it becomes U+FFFD): such text is refused rather than silently changed. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const wellFormed = (s: string): boolean => !LONE_SURROGATE.test(s);
const LoginUsername = z
  .string()
  .max(LOGIN_LIMITS.maxUsernameChars)
  .regex(NO_CONTROL_CHARS, zm("validation.noControlChars"))
  .refine(wellFormed, zm("validation.badChar"))
  .refine((s) => s.trim() !== "", zm("validation.notEmpty"));
const LoginLabel = z
  .string()
  .min(1)
  .max(LOGIN_LIMITS.maxLabelChars)
  .regex(NO_CONTROL_CHARS, zm("validation.noControlChars"))
  .refine(wellFormed, zm("validation.badChar"));
/** Any text (a password may hold anything), as long as it survives UTF-8 unchanged. Never echoed in an error. */
const LoginPassword = z.string().min(1).max(LOGIN_LIMITS.maxPasswordChars).refine(wellFormed, zm("validation.badChar"));

/** What the engine tells about a saved login. There is no password field, on purpose. */
export const SavedLoginSchema = z
  .object({
    id: Id,
    projectId: Id,
    origin: LoginOriginSchema,
    username: LoginUsername,
    label: LoginLabel.optional(),
    createdAt: z.string().min(1).max(64),
    updatedAt: z.string().min(1).max(64),
  })
  .strict();
export type SavedLogin = z.infer<typeof SavedLoginSchema>;

/** The fields a fill can report as filled. Values are never reported. */
export const LOGIN_FILL_FIELDS = ["username", "password"] as const;
export type LoginFillField = (typeof LOGIN_FILL_FIELDS)[number];

/** Who may read a stored password without the user's click on the engine Mac (engine config `logins.keychainAccess`). */
export const LOGIN_KEYCHAIN_ACCESS = ["confirm", "silent"] as const;
export type LoginKeychainAccess = (typeof LOGIN_KEYCHAIN_ACCESS)[number];

/** What the app must know before it offers a fill in a project. */
export interface LoginPolicy {
  /**
   * "confirm": every fill shows macOS's Keychain dialog on the engine Mac and waits for the user's click — other
   * programs of that user (agents too) cannot read a password silently. "silent": no dialog; protected at rest only.
   */
  keychainAccess: LoginKeychainAccess;
  /**
   * The user accepted, for this project, that an agent driving the same browser can read a filled password.
   * Without it the engine refuses `logins.fill` (LOGIN_RISK_UNACCEPTED).
   */
  agentRiskAccepted: boolean;
  /**
   * A terminal of the project that was handed the browser's DevTools address is running right now: every fill
   * then needs `confirmAgentRisk: true` — asked each time, never remembered.
   */
  agentsPresent: boolean;
}

const LoginRequestParams = {
  /** The project's logins, metadata only, and the project's fill policy. */
  "logins.list": z.object({ projectId: Id }).strict(),
  /**
   * Saves a login of the project: a new one, or — when the project already has one for the same `origin` and
   * `username` — a new password (and label) for that one. The password goes into the engine machine's Keychain.
   */
  "logins.save": z
    .object({ projectId: Id, origin: LoginOriginSchema, username: LoginUsername, password: LoginPassword, label: LoginLabel.optional() })
    .strict(),
  "logins.delete": z.object({ id: Id }).strict(),
  /**
   * The engine fills the login into the active tab of the project's browser — only when that page's top-level
   * origin equals the login's. Nothing is submitted. `projectId` must be the login's own project.
   */
  "logins.fill": z.object({ projectId: Id, id: Id, confirmAgentRisk: z.boolean().optional() }).strict(),
  /** The user accepts (or takes back) the agent risk of filling in this project. Remembered in the engine's state. */
  "logins.risk.set": z.object({ projectId: Id, accepted: z.boolean() }).strict(),
} as const;

interface LoginResultMap {
  "logins.list": { logins: SavedLogin[]; policy: LoginPolicy };
  "logins.risk.set": { policy: LoginPolicy };
  "logins.save": { login: SavedLogin };
  "logins.delete": Record<string, never>;
  /** Which fields were filled (never their values). */
  "logins.fill": { filled: LoginFillField[] };
}
// ---- /girişler ----


/** Longest URL accepted in a project location or a web site address. */
export const URL_LIMITS = { maxUrl: 2000 } as const;

/** An absolute https URL without embedded credentials. */
export function isHttpsUrl(raw: string): boolean {
  if (raw.length > URL_LIMITS.maxUrl || /[\s\0-\x1f\x7f]/.test(raw)) return false;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname !== "" && u.username === "" && u.password === "";
  } catch {
    return false;
  }
}


/** Location a client may ask for (create / update): never a github clone path. */
const ClientLocationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), path: AbsPath }).strict(),
  z.object({ kind: z.literal("github"), url: GitUrl }).strict(),
  z.object({ kind: z.literal("ssh"), hostId: Id, path: AbsPath.optional() }).strict(),
]);
export type ClientProjectLocation = z.infer<typeof ClientLocationSchema>;

// ---- /İş P ----

export const ProjectLocationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), path: AbsPath }).strict(),
  /** `path` is assigned by the engine (its clone dir); clients never choose it. */
  z.object({ kind: z.literal("github"), url: GitUrl, path: AbsPath.optional() }).strict(),
  z.object({ kind: z.literal("ssh"), hostId: Id, path: AbsPath.optional() }).strict(),
]);
export type ProjectLocation = z.infer<typeof ProjectLocationSchema>;

export const ProjectSchema = z.object({
  id: Id,
  name: z.string(),
  location: ProjectLocationSchema,
  defaultToolId: Id.optional(),
  /** The built-in "Mac mini" project (home dir); cannot be deleted. */
  builtin: z.boolean().optional(),
  /** Where the project's Chrome runs; absent = "engine". */
  browser: ProjectBrowserSchema.optional(),
  /** İş H: Claude account (subscription) the project's terminals use; absent = the default account. */
  claudeAccountId: Id.optional(),
  /**
   * Adım 9 İş A: the engine writes the browser env (CDP endpoint, output dir) into the project folder's Claude
   * settings file, so Claude sessions that do not inherit the terminal's environment (background agents under
   * the shared `claude daemon`) still drive the project's Chrome. Absent = on; false = the engine removes its keys.
   */
  claudeBrowserEnv: z.boolean().optional(),
  /**
   * Yollar: `open <http(s) address | page.html>` run in this project's terminals shows the page in the project's
   * Kokpit browser instead of the engine Mac's desktop browser. Absent = on; false = `open` is left alone.
   */
  openInBrowser: z.boolean().optional(),
});
export type Project = z.infer<typeof ProjectSchema>;

/** Git repo path on the engine machine for local/github projects; null for the other kinds (no cards there). */
export function projectGitPath(p: Project): string | null {
  if (p.location.kind === "local") return p.location.path;
  if (p.location.kind === "github") return p.location.path ?? null;
  return null;
}


export const SshHostSchema = z.object({
  id: Id,
  name: z.string(),
  /** Hostname, IP, or (source "ssh-config") the ~/.ssh/config alias. */
  hostname: z.string(),
  user: z.string().optional(),
  port: Port.optional(),
  /** File name inside ~/.ssh. Never the key's content. */
  identityFile: z.string().optional(),
  source: z.enum(["ssh-config", "kokpit"]),
});
export type SshHost = z.infer<typeof SshHostSchema>;

// ---- İş A: ajan özeti (domain) ----

/** Regexes (JavaScript syntax, no flags) that mark a terminal as waiting for the user when on screen. */
const isRegex = (s: string): boolean => {
  try {
    new RegExp(s);
    return true;
  } catch {
    return false;
  }
};
export const WaitingPatternsSchema = z
  .array(z.string().min(1).max(500).refine(isRegex, zm("validation.badRegex")))
  .max(50);

/**
 * running = output within the engine's activity window; waiting = a waiting pattern is on screen, or a
 * bell / notification arrived after the last user input; idle = silent; exited = process ended.
 */
export const AgentStateSchema = z.enum(["running", "waiting", "idle", "exited"]);
export type AgentState = z.infer<typeof AgentStateSchema>;

export const TerminalActivitySchema = z.object({
  state: AgentStateSchema,
  /** ISO time the terminal entered `state`. */
  since: z.string(),
  /** Last meaningful screen line, ANSI-stripped and bounded. */
  summary: z.string().optional(),
});
export type TerminalActivity = z.infer<typeof TerminalActivitySchema>;

// ---- /İş A ----

export const ToolSchema = z.object({
  id: Id,
  name: z.string(),
  /** Typed into the shell when a terminal starts with this tool. */
  command: z.string(),
  installCommand: z.string().optional(),
  /** Shell snippet that exits 0 when the tool is installed (e.g. `command -v claude`). */
  checkCommand: z.string().optional(),
  builtin: z.boolean().optional(),
  /** İş A: screen patterns meaning "waiting for you". Absent = the engine's generic list. */
  waitingPatterns: WaitingPatternsSchema.optional(),
  /**
   * İş B: a terminal opened with this tool also starts the project's browser on the engine (when it runs there),
   * so an agent using KOKPIT_CDP_URL finds it up.
   */
  opensBrowser: z.boolean().optional(),
});
export type Tool = z.infer<typeof ToolSchema>;

/** Adım 9 İş K: may a terminal of `project` start with `tool`? The engine enforces it; the UI hides the rest. */
export function toolAllowedForProject(tool: Tool, project: unknown): boolean {
  return true; // every tool is offered in this edition
}

export const ToolStatusSchema = z.object({ toolId: Id, installed: z.boolean().nullable() });
export type ToolStatus = z.infer<typeof ToolStatusSchema>;

/** Engine-wide settings. `defaultToolId` absent = new terminals open a plain shell when the project has no default. */
export const SettingsSchema = z.object({ defaultToolId: Id.optional() }).strict();
export type Settings = z.infer<typeof SettingsSchema>;

export const CardSchema = z.object({
  id: Id,
  projectId: Id,
  name: z.string(),
  branch: z.string(),
  worktreePath: z.string(),
  createdAt: z.string(),
});
export type Card = z.infer<typeof CardSchema>;

export const TerminalStatusSchema = z.enum(["running", "exited"]);
export type TerminalStatus = z.infer<typeof TerminalStatusSchema>;

export const TerminalInfoSchema = z.object({
  id: Id,
  projectId: Id,
  /** Absent for project-level terminals (opened without a card). */
  cardId: Id.optional(),
  toolId: Id.optional(),
  title: z.string(),
  command: z.string().optional(),
  status: TerminalStatusSchema,
  exitCode: z.number().int().nullable().optional(),
  createdAt: z.string(),
  /** İş A: live state, added by the engine (never stored). */
  activity: TerminalActivitySchema.optional(),
});
export type TerminalInfo = z.infer<typeof TerminalInfoSchema>;

// ---- harita (İş C) ----

/** HTTP path prefix under which the engine serves a project's graphify map for a one-time token. */
export const MAP_HTTP_PREFIX = "/map/";
/** Token alphabet (base64url) and length bounds; anything else is not a token path. */
const MAP_TOKEN_RE = /^[A-Za-z0-9_-]{16,200}$/;

/** True for `/map/<token>` with a well-formed token (no slashes, dots or escapes). */
export function isMapTokenPath(pathname: string): boolean {
  return pathname.startsWith(MAP_HTTP_PREFIX) && MAP_TOKEN_RE.test(pathname.slice(MAP_HTTP_PREFIX.length));
}

export const MapInfoSchema = z.object({
  available: z.boolean(),
  /** Path of the newest map file, relative to the project folder. */
  file: z.string().optional(),
  /** Modification time of that file (ISO). */
  generatedAt: z.string().optional(),
  /** Command a project terminal runs to create/refresh the map (engine config). Absent for ssh projects. */
  updateCommand: z.string().optional(),
});
export type MapInfo = z.infer<typeof MapInfoSchema>;
// ---- todos ----
// Yapılacaklar (Adım 6): a per-day list and a per-day note, kept by the engine.
// "Today" is the engine machine's local date; unfinished todos of earlier days roll over to it.

/** Longest todo text, in characters. */
export const TODO_TEXT_MAX = 500;
/** Longest note of one day, in characters. */
export const NOTE_TEXT_MAX = 20_000;
/** Most todos one day may hold. */
export const TODOS_PER_DAY_MAX = 500;

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date written as YYYY-MM-DD. */
export function isDateKey(s: string): boolean {
  const m = DATE_KEY_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

const DateKey = z.string().max(10).refine(isDateKey, zm("validation.dateKey"));
const TodoText = z.string().trim().min(1).max(TODO_TEXT_MAX);

export const TodoSchema = z.object({
  id: Id,
  text: z.string(),
  done: z.boolean(),
  /** The day the todo belongs to (engine local date). */
  date: DateKey,
  projectId: Id.optional(),
  /** Position within its day, 0-based. */
  order: z.number().int().min(0),
  createdAt: z.string(),
  doneAt: z.string().optional(),
  /** The day it was first planned for, when it rolled over from an earlier day. */
  rolledFrom: DateKey.optional(),
});
export type Todo = z.infer<typeof TodoSchema>;

const TodoRequestParams = {
  /** date absent = today. Rolls unfinished todos of earlier days over to today first. */
  "todos.list": z.object({ date: DateKey.optional() }).strict(),
  /** Appends to the given day (default today); days before today are refused. */
  "todos.create": z.object({ text: TodoText, projectId: Id.optional(), date: DateKey.optional() }).strict(),
  /** `order` = new 0-based position within the todo's day (clamped). `projectId: null` clears the tag. */
  "todos.update": z
    .object({
      id: Id,
      text: TodoText.optional(),
      done: z.boolean().optional(),
      projectId: Id.nullable().optional(),
      order: z.number().int().min(0).max(TODOS_PER_DAY_MAX).optional(),
    })
    .strict(),
  "todos.delete": z.object({ id: Id }).strict(),
  "notes.get": z.object({ date: DateKey.optional() }).strict(),
  /** Empty text removes the day's note. */
  "notes.set": z.object({ date: DateKey.optional(), text: z.string().max(NOTE_TEXT_MAX) }).strict(),
} as const;

interface TodoResultMap {
  "todos.list": { date: string; todos: Todo[] };
  "todos.create": { todo: Todo };
  "todos.update": { todo: Todo };
  "todos.delete": Record<string, never>;
  "notes.get": { date: string; text: string };
  "notes.set": { date: string; text: string };
}

const TodoEventSchemas = [
  /** Any todo of any day changed (including a rollover); clients reload the day they show. */
  z.object({ type: z.literal("event"), name: z.literal("todos.changed") }),
  z.object({ type: z.literal("event"), name: z.literal("notes.changed"), date: DateKey }),
] as const;


// ---------- requests ----------

const exactlyOne = (o: { cardId?: string; projectId?: string }) => (o.cardId === undefined) !== (o.projectId === undefined);
const EXACTLY_ONE = zm("validation.cardOrProject");

const SshHostFields = {
  name: Name,
  hostname: HostToken,
  user: HostToken.optional(),
  port: Port.optional(),
  identityFile: KeyFileName.optional(),
};

const ToolFields = {
  name: Name,
  command: Command,
  installCommand: Command.optional(),
  checkCommand: Command.optional(),
  waitingPatterns: WaitingPatternsSchema.optional(),
};

// ---- İş A: ajan özeti (requests, events) ----

const AgentRequestParams = {
  /** Every terminal with its activity, grouped by project. */
  "agents.summary": z.object({}).strict(),
} as const;

export interface AgentProjectSummary {
  projectId: string;
  terminals: TerminalInfo[];
}

interface AgentResultMap {
  "agents.summary": { projects: AgentProjectSummary[] };
}

const AgentEventSchemas = [
  z.object({
    type: z.literal("event"),
    name: z.literal("terminal.activity"),
    terminalId: Id,
    projectId: Id,
    cardId: Id.optional(),
    activity: TerminalActivitySchema,
  }),
] as const;

// ---- /İş A ----

// ---- dosyalar (İş F) ----
// Read-only browsing of a project's (or card's) folder on the engine machine. `path` is relative to that root
// ("" = the root itself, "/"-separated). The engine refuses anything that leaves the root (absolute, `..`,
// symlinks pointing outside) and hides `.git`; the shape check here is only the frame's.

export const FILES_LIMITS = {
  /** Longest relative path a request may carry. */
  maxPathChars: 4096,
} as const;

/** How the app shows a streamed file: <video>, <audio>, <img>, or the built-in PDF viewer in a frame. */
export const FILE_MEDIA_KINDS = ["video", "audio", "image", "pdf"] as const;
export type FileMediaKind = (typeof FILE_MEDIA_KINDS)[number];

export const FileEntrySchema = z.object({
  name: z.string(),
  kind: z.enum(["dir", "file", "symlink"]),
  /** Bytes; regular files only. */
  size: z.number().int().min(0).optional(),
  /** Symlinks only: what it points to, when that is inside the root. Absent = broken or outside (not browsable). */
  target: z.enum(["dir", "file"]).optional(),
});
export type FileEntry = z.infer<typeof FileEntrySchema>;

export const FileReadResultSchema = z.object({
  /** UTF-8 text (possibly cut at the engine's byte cap). Absent for binary files. */
  text: z.string().optional(),
  binary: z.literal(true).optional(),
  /** Size of the whole file in bytes. */
  size: z.number().int().min(0),
  /** True when `text` holds only the first part of the file. */
  truncated: z.boolean(),
  /**
   * Set when the file's extension is one the engine can stream for in-app viewing (`files.mediaUrl`). By name only:
   * the content is checked when a URL is asked for.
   */
  media: z.enum(FILE_MEDIA_KINDS).optional(),
});
export type FileReadResult = z.infer<typeof FileReadResultSchema>;

/** HTTP path prefix under which the engine streams one file for a `files.mediaUrl` token. */
export const FILES_MEDIA_HTTP_PREFIX = "/files/media/";
/** Token alphabet (base64url) and length bounds; anything else is not a token path. */
const FILES_MEDIA_TOKEN_RE = /^[A-Za-z0-9_-]{32,200}$/;

/** True for `/files/media/<token>` with a well-formed token (no slashes, dots, escapes or query). */
export function isFilesMediaTokenPath(pathname: string): boolean {
  return pathname.startsWith(FILES_MEDIA_HTTP_PREFIX) && FILES_MEDIA_TOKEN_RE.test(pathname.slice(FILES_MEDIA_HTTP_PREFIX.length));
}

/**
 * Appended by the app to a PDF's media URL: Chromium's PDF viewer then shows the pages without its own toolbar and
 * side panel. That toolbar would print the last segment of the URL — the token — as the document's name.
 */
export const FILES_MEDIA_PDF_FRAGMENT = "#toolbar=0&navpanes=0";

export const FileMediaUrlSchema = z.object({
  /** `${FILES_MEDIA_HTTP_PREFIX}<token>` on the engine's own listener (same host and port as the WebSocket). */
  path: z.string().refine(isFilesMediaTokenPath),
  kind: z.enum(FILE_MEDIA_KINDS),
  /** The Content-Type the engine will send (from its allowlist). */
  mime: z.string(),
  /** Size of the file in bytes when the URL was issued. */
  size: z.number().int().min(0),
  /** The URL stops working this long after its last use (ISO time of the current deadline). */
  expiresAt: z.string(),
});
export type FileMediaUrl = z.infer<typeof FileMediaUrlSchema>;

/** HTTP path prefix under which the engine serves the folder of a previewed page: `<prefix><token>/<file>`. */
export const FILES_PREVIEW_HTTP_PREFIX = "/files/preview/";
const FILES_PREVIEW_PATH_RE = /^([A-Za-z0-9_-]{32,200})(\/.*)?$/;

/**
 * The token and the path below it of a preview address (`/files/preview/<token>/a/b.css` → `/a/b.css`, still
 * percent-encoded and without the query); null when `pathname` is not one.
 */
export function parseFilesPreviewPath(pathname: string): { token: string; rest: string } | null {
  if (!pathname.startsWith(FILES_PREVIEW_HTTP_PREFIX)) return null;
  const m = FILES_PREVIEW_PATH_RE.exec(pathname.slice(FILES_PREVIEW_HTTP_PREFIX.length));
  return m ? { token: m[1]!, rest: m[2] ?? "" } : null;
}

/** What a local path points at, as far as opening it goes. */
export const FILE_LOCATION_KINDS = ["page", "media", "file", "dir"] as const;
export type FileLocationKind = (typeof FILE_LOCATION_KINDS)[number];

export const FileLocationSchema = z.object({
  /** The absolute path on the engine machine (symlinks followed). */
  path: z.string(),
  /** "page": .html/.htm; "media": a type Dosyalar plays or shows; "file": any other file; "dir": a folder. */
  kind: z.enum(FILE_LOCATION_KINDS),
  media: z.enum(FILE_MEDIA_KINDS).optional(),
  /** Set when Dosyalar can show it: the path relative to the card's (else the project's) folder. */
  rootPath: z.string().optional(),
  /** Which folder `rootPath` is relative to: the card's worktree when set, else the project's folder. */
  cardId: Id.optional(),
  /** The project's browser can show it through a preview address (the folder and the type are allowed). */
  browser: z.boolean(),
  /** Why not, when `browser` is false and the type itself would be shown (a refused folder). For the user. */
  browserRefusal: z.string().optional(),
});
export type FileLocation = z.infer<typeof FileLocationSchema>;

export const FilePreviewUrlSchema = z.object({
  /** `${FILES_PREVIEW_HTTP_PREFIX}<token>/<file name>` on the engine's own listener. */
  path: z.string().refine((p) => parseFilesPreviewPath(p) !== null),
  /** True when only this one file is served (it sits directly in a wide folder such as Belgeler). */
  single: z.boolean(),
  /** The address stops working this long after its last use (ISO time of the current deadline). */
  expiresAt: z.string(),
});
export type FilePreviewUrl = z.infer<typeof FilePreviewUrlSchema>;

const FilesRef = {
  projectId: Id.optional(),
  cardId: Id.optional(),
  path: z.string().max(FILES_LIMITS.maxPathChars),
};

const FilesRequestParams = {
  /** Entries of one folder: folders first, then by name; `.git` (and configured names) never listed. */
  "files.list": z.object(FilesRef).strict().refine(exactlyOne, EXACTLY_ONE),
  /** Read-only preview of one file, size-capped. */
  "files.read": z.object(FilesRef).strict().refine(exactlyOne, EXACTLY_ONE),
  /**
   * A short-lived URL that streams exactly this file (HTTP Range) from the engine's listener. Only for the types in
   * the engine's allowlist; the URL belongs to the asking connection and dies with it.
   */
  "files.mediaUrl": z.object(FilesRef).strict().refine(exactlyOne, EXACTLY_ONE),
  /** Ends a URL from `files.mediaUrl` (the preview closed or shows another file). Unknown paths are ignored. */
  "files.mediaRevoke": z.object({ path: z.string().max(FILES_LIMITS.maxPathChars).refine(isFilesMediaTokenPath, zm("validation.badAddress")) }).strict(),
  /**
   * Yollar: what a path a terminal printed points at — resolved on the engine machine, only when the user acts on
   * the link. NOT_FOUND when nothing is there; INVALID for SSH projects (the file is on the remote host).
   */
  "files.locate": LocalPathRefSchema,
  /**
   * Yollar: a preview address for a local file, for a browser that does NOT run on the engine machine
   * (`runOn: "client"`): the app joins it to the engine address it is connected to. Projects whose browser runs on
   * the engine use `browser.openFile`, where the address never leaves the engine.
   */
  "files.previewUrl": LocalPathRefSchema,
  /** Ends an address from `files.previewUrl`. Unknown paths are ignored. */
  "files.previewRevoke": z
    .object({ path: z.string().max(FILES_LIMITS.maxPathChars).refine((p) => parseFilesPreviewPath(p) !== null, zm("validation.badAddress")) })
    .strict(),
} as const;

interface FilesResultMap {
  /** `truncated`: the folder has more entries than the engine lists. */
  "files.list": { entries: FileEntry[]; truncated: boolean };
  "files.read": FileReadResult;
  "files.mediaUrl": FileMediaUrl;
  "files.mediaRevoke": Record<string, never>;
  "files.locate": FileLocation;
  "files.previewUrl": FilePreviewUrl;
  "files.previewRevoke": Record<string, never>;
}

// ---- /dosyalar ----

// ---- İş W (Adım 8): akış şemaları ----
// Mermaid flow diagrams kept in the project (`<root>/<flowDir>/*.mmd`, flowDir from engine config). The engine lists
// and reads them (one folder level, .mmd only, size-capped, never through a symlink); the app renders them.

export const FLOW_LIMITS = {
  /** Longest flow id (file name) a request may carry. */
  maxIdChars: 255,
} as const;

/** A flow id: one plain file name ending in `.mmd` (no separators, no leading dot, no NUL). */
const FLOW_ID_RE = /^[^/\\\0.][^/\\\0]*\.mmd$/u;

export function isFlowId(id: string): boolean {
  return id.length <= FLOW_LIMITS.maxIdChars && FLOW_ID_RE.test(id);
}

export const FlowEntrySchema = z.object({
  /** File name inside the flow folder; what `flow.read` takes. */
  id: z.string(),
  /** Relative to the project (or card worktree) folder. */
  file: z.string(),
  /** From an optional first-line `%% title: …` comment. */
  title: z.string().optional(),
  /** Modification time (ISO). */
  modifiedAt: z.string(),
});
export type FlowEntry = z.infer<typeof FlowEntrySchema>;

export const FlowInfoSchema = z.object({
  /** False for projects whose folder is not on the engine machine (ssh). */
  available: z.boolean(),
  /** Flow folder, relative to the project folder. */
  dir: z.string().optional(),
  /** Command a project terminal runs to draw / refresh the flows (engine config). */
  updateCommand: z.string().optional(),
});
export type FlowInfo = z.infer<typeof FlowInfoSchema>;

const FlowRef = { projectId: Id.optional(), cardId: Id.optional() };
const FlowId = z.string().refine(isFlowId, zm("validation.flowId"));

const FlowRequestParams = {
  "flow.info": z.object(FlowRef).strict().refine(exactlyOne, EXACTLY_ONE),
  /** Flows in the flow folder, newest first; non-.mmd files, folders and symlinks are ignored. */
  "flow.list": z.object(FlowRef).strict().refine(exactlyOne, EXACTLY_ONE),
  "flow.read": z
    .object({ ...FlowRef, id: FlowId })
    .strict()
    .refine(exactlyOne, EXACTLY_ONE),
} as const;

// ---- İş C (Adım 8): Claude envanteri ----
// Skills, agents and slash commands Claude Code would see for a project: the project's `.claude/` plus the user
// level of the project's Claude config dir (and plugin skills under it). Only markdown is ever read; ids are
// re-validated by the engine (source + path below that source's root), never trusted as paths.

export const CLAUDE_INVENTORY_LIMITS = {
  /** Longest item id a request may carry. */
  maxIdChars: 2048,
} as const;

export const ClaudeItemKindSchema = z.enum(["skill", "agent", "command"]);
export type ClaudeItemKind = z.infer<typeof ClaudeItemKindSchema>;
export const ClaudeItemSourceSchema = z.enum(["project", "user", "plugin"]);
export type ClaudeItemSource = z.infer<typeof ClaudeItemSourceSchema>;

export const ClaudeInventoryItemSchema = z.object({
  kind: ClaudeItemKindSchema,
  /** Frontmatter `name`, else the folder/file name; plugin skills are `<plugin>:<skill>`, nested commands `a:b`. */
  name: z.string(),
  description: z.string().optional(),
  source: ClaudeItemSourceSchema,
  /** For display only (`.claude/skills/x/SKILL.md`, `~/.claude/agents/y.md`). */
  path: z.string(),
  /** Opaque handle for `claude.inventory.read`. */
  id: z.string(),
});
export type ClaudeInventoryItem = z.infer<typeof ClaudeInventoryItemSchema>;

export interface ClaudeInventoryResult {
  items: ClaudeInventoryItem[];
  /** More items exist than the engine lists. */
  truncated: boolean;
  /** Whether a CLAUDE.md exists in the project root (absent when the project part was not read) and the config dir. */
  claudeMd: { project?: boolean; user: boolean };
  /** Why part of the inventory is missing (Turkish), e.g. SSH projects have no project part. */
  note?: string;
}

const ClaudeRef = { projectId: Id.optional(), cardId: Id.optional() };

const ClaudeRequestParams = {
  "claude.inventory": z.object(ClaudeRef).strict().refine(exactlyOne, EXACTLY_ONE),
  /** Read-only, size-capped preview of one inventory item's markdown. */
  "claude.inventory.read": z
    .object({ ...ClaudeRef, id: z.string().min(1).max(CLAUDE_INVENTORY_LIMITS.maxIdChars) })
    .strict()
    .refine(exactlyOne, EXACTLY_ONE),
} as const;

interface FlowResultMap {
  "flow.info": FlowInfo;
  /** `truncated`: the folder holds more flows than the engine lists. */
  "flow.list": { flows: FlowEntry[]; truncated: boolean };
  "flow.read": { text: string };
}

// ---- /İş W ----
interface ClaudeResultMap {
  "claude.inventory": ClaudeInventoryResult;
  "claude.inventory.read": FileReadResult;
}

// ---- /İş C (Adım 8) ----
// ---- İş A (Adım 7): arka plan ajanları ----
// Claude Code background sessions (`claude agents --json --all` on the engine machine), mapped by `cwd` to the
// project / card they run in. Actions run `claude attach|logs|stop <id>`; ids are never option-like.

/** A background session id: letters, digits, dashes; starts with a letter or digit. */
export const BG_AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const BgAgentId = z.string().min(1).max(200).regex(BG_AGENT_ID_RE, zm("validation.sessionId"));

/** running = working; waiting = needs the user (`approval`: a permission prompt, `input`: its turn ended); done. */
export const BgAgentStateSchema = z.enum(["running", "waiting", "done"]);
export type BgAgentState = z.infer<typeof BgAgentStateSchema>;
export const BgAgentWaitingReasonSchema = z.enum(["approval", "input"]);
export type BgAgentWaitingReason = z.infer<typeof BgAgentWaitingReasonSchema>;

export const BgAgentSessionSchema = z.object({
  id: BgAgentId,
  name: z.string(),
  state: BgAgentStateSchema,
  waitingReason: BgAgentWaitingReasonSchema.optional(),
  /** ISO start time, when the CLI reported one. */
  startedAt: z.string().optional(),
  cwd: z.string(),
  /** Absent = no project matched ("Diğer"). */
  projectId: Id.optional(),
  cardId: Id.optional(),
  /** İş H: Claude account whose config dir listed the session (absent when accounts are not in use). */
  accountId: Id.optional(),
});
export type BgAgentSession = z.infer<typeof BgAgentSessionSchema>;

const BgAgentRequestParams = {
  "bgAgents.list": z.object({}).strict(),
  /** Opens a terminal (in the session's project/card, else the built-in project) running `claude attach <id>`. */
  "bgAgents.attach": z.object({ id: BgAgentId, cols: Dim, rows: Dim }).strict(),
  /** Recent output of the session (`claude logs <id>`), escape sequences stripped, size-bounded. */
  "bgAgents.logs": z.object({ id: BgAgentId }).strict(),
  "bgAgents.stop": z.object({ id: BgAgentId }).strict(),
} as const;

interface BgAgentResultMap {
  /** `error`: why the list could not be read (Turkish, for the user); the last good list is kept. */
  "bgAgents.list": { sessions: BgAgentSession[]; error?: string };
  "bgAgents.attach": { terminal: TerminalInfo };
  /** `truncated`: older output was cut off. */
  "bgAgents.logs": { text: string; truncated: boolean };
  "bgAgents.stop": Record<string, never>;
}

/** The session list (or its error) changed; clients re-read it with `bgAgents.list`. */
const BgAgentEventSchemas = [z.object({ type: z.literal("event"), name: z.literal("bgAgents.changed") })] as const;

// ---- /İş A (Adım 7) ----

// ---- İş H (Adım 8): Claude hesapları ----

/** A config dir as the user types it: absolute, or `~/…` (the engine expands it to its own home). */
const ConfigDirInput = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((p) => p.startsWith("/") || p.startsWith("~/"), zm("validation.absOrHomePath"))
  .refine((p) => !p.includes("\0"), zm("validation.badChar"));

/**
 * One Claude Code subscription = one `CLAUDE_CONFIG_DIR`. `isDefault`: the user's own (`~/.claude`); its terminals
 * get no variable, and it cannot be deleted. Credentials inside the dir are never read by Kokpit.
 */
export const ClaudeAccountSchema = z.object({
  id: Id,
  name: Name,
  configDir: AbsPath,
  isDefault: z.boolean().optional(),
});
export type ClaudeAccount = z.infer<typeof ClaudeAccountSchema>;

const ClaudeAccountRequestParams = {
  "claudeAccounts.list": z.object({}).strict(),
  "claudeAccounts.create": z.object({ name: Name, configDir: ConfigDirInput }).strict(),
  /** The default account's folder cannot change (only its name). */
  "claudeAccounts.update": z.object({ id: Id, name: Name.optional(), configDir: ConfigDirInput.optional() }).strict(),
  /** Refused for the default account and for accounts still used by a project. Never deletes the folder. */
  "claudeAccounts.delete": z.object({ id: Id }).strict(),
  /** Opens a terminal in the built-in project running `claude /login` with this account's config dir. */
  "claudeAccounts.login": z.object({ id: Id, cols: Dim, rows: Dim }).strict(),
  /** Links skills/agents/commands to the default account's folders where nothing exists yet. Needs explicit confirm. */
  "claudeAccounts.shareSkills": z.object({ id: Id, confirm: z.literal(true) }).strict(),
} as const;

interface ClaudeAccountResultMap {
  "claudeAccounts.list": { accounts: ClaudeAccount[] };
  "claudeAccounts.create": { account: ClaudeAccount };
  "claudeAccounts.update": { account: ClaudeAccount };
  "claudeAccounts.delete": Record<string, never>;
  "claudeAccounts.login": { terminal: TerminalInfo };
  /** `linked`: names now linked; `skipped`: names left alone, with the reason (Turkish). */
  "claudeAccounts.shareSkills": { linked: string[]; skipped: { name: string; reason: string }[] };
}

/** The account list changed; clients re-read it with `claudeAccounts.list`. */
const ClaudeAccountEventSchemas = [z.object({ type: z.literal("event"), name: z.literal("claudeAccounts.changed") })] as const;

// ---- /İş H ----

// ---- Claude kullanımı ----
// What each Claude subscription (account = config dir) used, counted by the engine from that dir's session
// transcripts: only the numeric usage fields, the model id, the time and the folder a session ran in are read —
// never message text. `plan` is Claude Code's OWN quota figure, present only when a credential-free source gave one
// (its status line input, or a one-request probe the user asked for); Kokpit never reads credentials for it.

const UsageCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const UsageTotalsFields = {
  /** Distinct API responses (assistant messages), deduplicated by message id + request id. */
  messages: UsageCount,
  input: UsageCount,
  output: UsageCount,
  cacheWrite: UsageCount,
  cacheRead: UsageCount,
};
export const ClaudeUsageTotalsSchema = z.object(UsageTotalsFields).strict();
export type ClaudeUsageTotals = z.infer<typeof ClaudeUsageTotalsSchema>;

/** `family`: the model id without vendor prefix, version and date ("opus", "sonnet", …). */
export const ClaudeUsageModelSchema = z.object({ family: z.string().min(1).max(100), ...UsageTotalsFields }).strict();
export type ClaudeUsageModel = z.infer<typeof ClaudeUsageModelSchema>;

/** `projectId`: the Kokpit project whose folder (or card worktree) held the session; else `name` is the folder's own name. */
export const ClaudeUsageProjectSchema = z
  .object({
    projectId: Id.optional(),
    name: z
      .string()
      .min(1)
      .max(255)
      .refine((s) => !s.includes("/") && !s.includes("\\"), zm("validation.folderName")),
    ...UsageTotalsFields,
  })
  .strict();
export type ClaudeUsageProject = z.infer<typeof ClaudeUsageProjectSchema>;

export const ClaudeUsageWindowSchema = z
  .object({
    totals: ClaudeUsageTotalsSchema,
    /** Largest first. */
    byModel: z.array(ClaudeUsageModelSchema).max(100),
    /** Largest first, cut to the engine's `topProjects`. */
    topProjects: z.array(ClaudeUsageProjectSchema).max(100),
    /** API-list-price equivalent — an ESTIMATE; present only when the engine's price table covers every model used. */
    estimatedCostUsd: z.number().min(0).optional(),
  })
  .strict();
export type ClaudeUsageWindow = z.infer<typeof ClaudeUsageWindowSchema>;

export const CLAUDE_PLAN_SOURCES = ["statusline", "probe"] as const;
export type ClaudePlanSource = (typeof CLAUDE_PLAN_SOURCES)[number];
/** One quota window as Claude Code itself reported it. */
export const ClaudePlanWindowSchema = z
  .object({
    usedPercent: z.number().min(0).max(1000),
    resetsAt: z.iso.datetime(),
    capturedAt: z.iso.datetime(),
    source: z.enum(CLAUDE_PLAN_SOURCES),
  })
  .strict();
export type ClaudePlanWindow = z.infer<typeof ClaudePlanWindowSchema>;

export const ClaudeUsageAccountSchema = z
  .object({
    accountId: Id,
    name: Name,
    isDefault: z.boolean().optional(),
    /** `session`: the last `sessionWindowHours`; `today`: since local midnight on the engine; `week`: the last `longWindowDays`. */
    windows: z.object({ session: ClaudeUsageWindowSchema, today: ClaudeUsageWindowSchema, week: ClaudeUsageWindowSchema }).strict(),
    plan: z.object({ fiveHour: ClaudePlanWindowSchema.optional(), sevenDay: ClaudePlanWindowSchema.optional() }).strict().optional(),
    /** When the transcripts were last read to the end; absent before the first pass finishes. */
    updatedAt: z.iso.datetime().optional(),
    /** A pass over the transcripts is running; `claudeUsage.changed` follows. */
    indexing: z.boolean(),
    /** A limit was hit (files, line length, messages kept): the numbers are a lower bound. */
    partial: z.boolean().optional(),
    /** Why the numbers could not be read (Turkish, for the user). */
    error: z.string().max(500).optional(),
  })
  .strict();
export type ClaudeUsageAccount = z.infer<typeof ClaudeUsageAccountSchema>;

export const ClaudeUsageResultSchema = z
  .object({
    accounts: z.array(ClaudeUsageAccountSchema).max(100),
    sessionWindowHours: z.number().int().min(1).max(168),
    longWindowDays: z.number().int().min(1).max(90),
    /** How often a visible view should ask again. */
    refreshIntervalMs: z.number().int().min(1000),
    /** Date of the engine's price table; absent = no cost estimate. */
    pricesAsOf: z.string().min(1).max(40).optional(),
    /** `claudeUsage.probe` is enabled on this engine. */
    probeAvailable: z.boolean(),
  })
  .strict();
export type ClaudeUsageResult = z.infer<typeof ClaudeUsageResultSchema>;

const ClaudeUsageRequestParams = {
  /** Answers at once with what is known; `refresh` (or stale data) starts a pass and `claudeUsage.changed` follows. */
  "claudeUsage.get": z.object({ accountId: Id.optional(), refresh: z.boolean().optional() }).strict(),
  /**
   * Asks Claude Code itself for the account's quota: runs ONE tiny non-interactive `claude` request (it spends a
   * little of the subscription — hence the explicit confirm) and reads the rate-limit figures it prints.
   */
  "claudeUsage.probe": z.object({ accountId: Id, confirm: z.literal(true) }).strict(),
} as const;

interface ClaudeUsageResultMap {
  "claudeUsage.get": ClaudeUsageResult;
  "claudeUsage.probe": ClaudeUsageResult;
}

/** New numbers are ready; clients re-read them with `claudeUsage.get`. */
const ClaudeUsageEventSchemas = [z.object({ type: z.literal("event"), name: z.literal("claudeUsage.changed") })] as const;

// ---- /Claude kullanımı ----

export const RequestParams = {
  ...AgentRequestParams,
  "projects.list": z.object({}).strict(),
  "projects.create": z
    .object({
      name: Name,
      // github path is assigned by the engine
      location: ClientLocationSchema,
      defaultToolId: Id.optional(),
      browser: ProjectBrowserSchema.optional(),
      claudeAccountId: Id.optional(), // İş H
      claudeBrowserEnv: z.boolean().optional(), // Adım 9 İş A
    })
    .strict(),
  /**
   * null clears defaultToolId. İş P: `location` may change only while the project has no cards; built-in projects
   * and github projects keep theirs (the engine decides and answers INVALID).
   */
  "projects.update": z
    .object({
      projectId: Id,
      name: Name.optional(),
      defaultToolId: Id.nullable().optional(),
      browser: ProjectBrowserSchema.optional(),
      location: ClientLocationSchema.optional(),
      /** İş H: null = back to the default account. */
      claudeAccountId: Id.nullable().optional(),
      claudeBrowserEnv: z.boolean().optional(), // Adım 9 İş A
      openInBrowser: z.boolean().optional(), // Yollar
    })
    .strict(),
  "projects.delete": z.object({ projectId: Id }).strict(),
  "sshHosts.list": z.object({}).strict(),
  "sshHosts.create": z.object(SshHostFields).strict(),
  "sshHosts.update": z
    .object({
      hostId: Id,
      name: Name.optional(),
      hostname: HostToken.optional(),
      user: HostToken.nullable().optional(),
      port: Port.nullable().optional(),
      identityFile: KeyFileName.nullable().optional(),
    })
    .strict(),
  "sshHosts.delete": z.object({ hostId: Id }).strict(),
  /** File names of private keys in ~/.ssh (files that have a matching .pub). */
  "sshKeys.list": z.object({}).strict(),
  "tools.list": z.object({}).strict(),
  "tools.create": z.object(ToolFields).strict(),
  "tools.update": z
    .object({
      toolId: Id,
      name: Name.optional(),
      command: Command.optional(),
      installCommand: Command.nullable().optional(),
      checkCommand: Command.nullable().optional(),
      waitingPatterns: WaitingPatternsSchema.nullable().optional(),
    })
    .strict(),
  "tools.delete": z.object({ toolId: Id }).strict(),
  "tools.check": z.object({}).strict(),
  /** Opens a terminal in the built-in project running the tool's installCommand. */
  "tools.install": z.object({ toolId: Id, cols: Dim, rows: Dim }).strict(),
  "settings.get": z.object({}).strict(),
  /** `defaultToolId`: null = no global default tool ("Yalnız kabuk"); the tool must exist. */
  "settings.update": z.object({ defaultToolId: Id.nullable() }).strict(),
  "cards.list": z.object({ projectId: Id }).strict(),
  "cards.create": z.object({ projectId: Id, name: z.string().trim().min(1).max(100) }).strict(),
  "cards.delete": z.object({ cardId: Id }).strict(),
  "terminals.list": z
    .object({ cardId: Id.optional(), projectId: Id.optional() })
    .strict()
    .refine(exactlyOne, EXACTLY_ONE),
  /**
   * Start precedence: `command` > `toolId` > project's default tool > settings' default tool > plain shell.
   * `toolId: null` asks for a plain shell explicitly (no default applies). Project terminals open at the project location.
   */
  "terminal.open": z
    .object({
      cardId: Id.optional(),
      projectId: Id.optional(),
      cols: Dim,
      rows: Dim,
      toolId: Id.nullable().optional(),
      command: Command.optional(),
    })
    .strict()
    .refine(exactlyOne, EXACTLY_ONE),
  "terminal.attach": z.object({ terminalId: Id, cols: Dim, rows: Dim }).strict(),
  "terminal.detach": z.object({ terminalId: Id }).strict(),
  "terminal.close": z.object({ terminalId: Id }).strict(),
  // ---- harita (İş C) ----
  "map.info": z.object({ projectId: Id }).strict(),
  /** One-time, short-lived token for GET `${MAP_HTTP_PREFIX}<token>` on the engine's own listener. */
  "map.token": z.object({ projectId: Id }).strict(),
  ...TodoRequestParams,
  ...BrowserRequestParams,
  ...FilesRequestParams,
  ...ClaudeRequestParams,
  ...BgAgentRequestParams,
  ...ClaudeAccountRequestParams, // İş H
  ...ClaudeUsageRequestParams, // Claude kullanımı
  ...FlowRequestParams, // İş W
  ...LoginRequestParams, // Girişler
  ...AppUpdateRequestParams, // Kendini güncelleme
} as const;
export type Method = keyof typeof RequestParams;
export type ParamsOf<M extends Method> = z.infer<(typeof RequestParams)[M]>;

/** Result payload of a successful `res` for each method. */
export interface ResultMap extends TodoResultMap, AgentResultMap, BrowserResultMap, FilesResultMap, BgAgentResultMap, ClaudeAccountResultMap, ClaudeUsageResultMap, FlowResultMap, ClaudeResultMap, LoginResultMap, AppUpdateResultMap {
  "projects.list": { projects: Project[] };
  "projects.create": { project: Project };
  "projects.update": { project: Project };
  "projects.delete": Record<string, never>;
  "sshHosts.list": { hosts: SshHost[] };
  "sshHosts.create": { host: SshHost };
  "sshHosts.update": { host: SshHost };
  "sshHosts.delete": Record<string, never>;
  "sshKeys.list": { keys: string[] };
  "tools.list": { tools: Tool[] };
  "tools.create": { tool: Tool };
  "tools.update": { tool: Tool };
  "tools.delete": Record<string, never>;
  "tools.check": { statuses: ToolStatus[] };
  "tools.install": { terminal: TerminalInfo };
  "settings.get": { settings: Settings };
  "settings.update": { settings: Settings };
  "cards.list": { cards: Card[] };
  "cards.create": { card: Card };
  "cards.delete": Record<string, never>;
  "terminals.list": { terminals: TerminalInfo[] };
  "terminal.open": { terminal: TerminalInfo };
  "terminal.attach": { terminal: TerminalInfo };
  "terminal.detach": Record<string, never>;
  "terminal.close": Record<string, never>;
  // ---- harita (İş C) ----
  "map.info": MapInfo;
  /** `path` is absolute on the engine's HTTP origin (same host/port as the WebSocket). */
  "map.token": { path: string; expiresAt: string };
}
export type ResultOf<M extends Method> = ResultMap[M];

const ReqId = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const requestVariants = (Object.keys(RequestParams) as Method[]).map((method) =>
  z.object({ type: z.literal("req"), id: ReqId, method: z.literal(method), params: RequestParams[method] }).strict(),
);

/** First frame of every connection (auth.ts). `grant`: the public id of a screen grant (a SCOPED connection). */
const AuthHelloSchema = z.object({ type: z.literal("auth.hello"), nonce: NonceSchema, grant: GrantIdSchema.optional() }).strict();
/** Second client frame: HMAC(secret, "kokpit-client" ‖ engine nonce ‖ client nonce). */
const AuthProofSchema = z.object({ type: z.literal("auth.proof"), proof: ProofSchema }).strict();
export type AuthClientMessage = z.infer<typeof AuthHelloSchema> | z.infer<typeof AuthProofSchema>;
const InputSchema = z
  .object({ type: z.literal("input"), terminalId: Id, data: z.string().max(MAX_MESSAGE_BYTES) })
  .strict();
const ResizeSchema = z.object({ type: z.literal("resize"), terminalId: Id, cols: Dim, rows: Dim }).strict();

export const ClientMessageSchema = z.union([
  AuthHelloSchema,
  AuthProofSchema,
  InputSchema,
  ResizeSchema,
  BrowserInputMessageSchema,
  BrowserAckMessageSchema,
  ...(requestVariants as unknown as [z.ZodTypeAny, ...z.ZodTypeAny[]]),
]);

export type RequestMessage = {
  [M in Method]: { type: "req"; id: number; method: M; params: ParamsOf<M> };
}[Method];
export type ClientMessage =
  | AuthClientMessage
  | z.infer<typeof InputSchema>
  | z.infer<typeof ResizeSchema>
  | BrowserClientMessage
  | RequestMessage;

// ---------- terminal output frames ----------
// Terminal data is full of control characters, and JSON writes each of those as six (`\u001b`): a frame can be
// several times larger than the data it carries. So the engine never puts terminal data into a frame whole; it
// splits it by ENCODED size. A history replay becomes `part.total` frames, `part.index` 0…total-1, sent in order
// and before any live output; the receiver clears the terminal at index 0 and appends the rest.

/** Characters JSON.stringify writes for a control character or a lone surrogate (`\uXXXX`). */
const JSON_UNICODE_ESCAPE_CHARS = 6;
/** …and for the characters that have a short escape (`\"`, `\\`, `\n`, …). */
const JSON_SHORT_ESCAPE_CHARS = 2;
/** The two quotes around a JSON string. */
const JSON_QUOTE_CHARS = 2;

const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/**
 * Characters JSON.stringify writes for the code unit(s) starting at `i`, and how many code units that is
 * (2 for a surrogate pair, which is written as it is and must stay together).
 */
function jsonCost(s: string, i: number): { chars: number; units: 1 | 2 } {
  const c = s.charCodeAt(i);
  if (c === 0x22 || c === 0x5c) return { chars: JSON_SHORT_ESCAPE_CHARS, units: 1 };
  if (c < 0x20) {
    const short = c === 0x08 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d;
    return { chars: short ? JSON_SHORT_ESCAPE_CHARS : JSON_UNICODE_ESCAPE_CHARS, units: 1 };
  }
  if (isHighSurrogate(c)) {
    return isLowSurrogate(s.charCodeAt(i + 1)) ? { chars: 2, units: 2 } : { chars: JSON_UNICODE_ESCAPE_CHARS, units: 1 };
  }
  if (isLowSurrogate(c)) return { chars: JSON_UNICODE_ESCAPE_CHARS, units: 1 };
  return { chars: 1, units: 1 };
}

/** `JSON.stringify(s).length`, without building the string. */
export function jsonStringLength(s: string): number {
  let n = JSON_QUOTE_CHARS;
  for (let i = 0; i < s.length; ) {
    const cost = jsonCost(s, i);
    n += cost.chars;
    i += cost.units;
  }
  return n;
}

const OutputPartSchema = z
  .object({ index: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), total: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) })
  .strict()
  .refine((p) => p.index < p.total, zm("validation.indexBelowTotal"));
/** Which piece of a history replay an `output` frame carries. Absent = the whole replay in one frame. */
export type OutputPart = z.infer<typeof OutputPartSchema>;

/** The largest JSON an `output` frame can have around its `data` string: every field at its widest. */
const OUTPUT_ENVELOPE_CHARS =
  JSON.stringify({
    type: "output",
    terminalId: "\u0000".repeat(ID_MAX_CHARS),
    data: "",
    replay: true,
    part: { index: Number.MAX_SAFE_INTEGER, total: Number.MAX_SAFE_INTEGER } satisfies OutputPart,
  }).length - JSON_QUOTE_CHARS;

export const OUTPUT_LIMITS = {
  /** Longest terminal id a frame may name. */
  maxIdChars: ID_MAX_CHARS,
  /** Frame characters that are not the data string. */
  envelopeChars: OUTPUT_ENVELOPE_CHARS,
  /** Budget of one frame's `data`, as JSON (quotes and escapes included): what is left of MAX_MESSAGE_BYTES. */
  maxDataJsonChars: MAX_MESSAGE_BYTES - OUTPUT_ENVELOPE_CHARS,
  /** Smallest budget splitOutputData accepts: the quotes and one `\uXXXX`. */
  minDataJsonChars: JSON_QUOTE_CHARS + JSON_UNICODE_ESCAPE_CHARS,
} as const;

/**
 * Cuts terminal data into pieces whose JSON form is at most `maxJsonChars` each, in order, losing nothing
 * (`pieces.join("") === data`). A surrogate pair is never cut in two: each piece is well-formed text on its own, as
 * the transport (JSON in a text frame, UTF-8 on the wire) needs. Escape sequences may be cut — terminals parse them
 * across writes. Empty data gives no piece.
 */
export function splitOutputData(data: string, maxJsonChars: number = OUTPUT_LIMITS.maxDataJsonChars): string[] {
  if (!Number.isInteger(maxJsonChars) || maxJsonChars < OUTPUT_LIMITS.minDataJsonChars) {
    throw new RangeError(`invalid output chunk budget: ${maxJsonChars}`);
  }
  if (data.length === 0) return [];
  // Nothing can be wider than a `\uXXXX` per code unit: most data needs no scan.
  if (JSON_QUOTE_CHARS + data.length * JSON_UNICODE_ESCAPE_CHARS <= maxJsonChars) return [data];
  const pieces: string[] = [];
  let start = 0;
  let size = JSON_QUOTE_CHARS;
  for (let i = 0; i < data.length; ) {
    const cost = jsonCost(data, i);
    if (size + cost.chars > maxJsonChars) {
      pieces.push(data.slice(start, i));
      start = i;
      size = JSON_QUOTE_CHARS;
    }
    size += cost.chars;
    i += cost.units;
  }
  pieces.push(data.slice(start));
  return pieces;
}

/** How an `output` frame starts as the engine writes it; group 1 is the terminal id, still a JSON string. */
const OUTPUT_FRAME_HEAD = /^\{"type":"output","terminalId":("(?:[^"\\]|\\.)*")/;

/**
 * The terminal a raw frame carries output for, read from its first characters only — for frames that could not be
 * decoded (too large, malformed), so the receiver can still say WHICH terminal lost output. undefined = not an
 * `output` frame, or not written the way the engine writes them.
 */
export function peekOutputTerminalId(raw: string): string | undefined {
  if (typeof raw !== "string") return undefined;
  const head = OUTPUT_FRAME_HEAD.exec(raw.slice(0, OUTPUT_LIMITS.envelopeChars));
  if (!head) return undefined;
  try {
    const id: unknown = JSON.parse(head[1] as string);
    return typeof id === "string" && Id.safeParse(id).success ? id : undefined;
  } catch {
    return undefined;
  }
}

// ---------- server → client ----------

/**
 * i18n: an error may name its text by catalog key (`engine.*`, `validation.*` of @kokpit/shared/i18n) and params, so
 * the app shows it in its own language; `message` is the same text in the engine's language, for apps that predate
 * keys (their schema is not strict and drops the extra fields). A malformed key or params is dropped, never fatal.
 */
export const ERROR_I18N_LIMITS = { maxKeyChars: 200, maxParams: 20, maxParamChars: 2000 } as const;
const ErrorKeySchema = z.string().max(ERROR_I18N_LIMITS.maxKeyChars).regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/);
const ErrorParamsSchema = z
  .record(z.string().max(ERROR_I18N_LIMITS.maxKeyChars), z.union([z.string().max(ERROR_I18N_LIMITS.maxParamChars), z.number()]))
  .refine((p) => Object.keys(p).length <= ERROR_I18N_LIMITS.maxParams);
const ErrorSchema = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string(),
  key: ErrorKeySchema.optional().catch(undefined),
  params: ErrorParamsSchema.optional().catch(undefined),
});
export type ProtocolError = z.infer<typeof ErrorSchema>;

export const ServerMessageSchema = z.union([
  z.object({ type: z.literal("auth.challenge"), nonce: NonceSchema }),
  // `proof`: HMAC(secret, "kokpit-engine" ‖ client nonce ‖ engine nonce) — the engine proves it holds the secret.
  z.object({ type: z.literal("hello.ok"), engineVersion: z.string(), engineBuild: BuildInfoSchema, protocol: z.number().int().min(0).max(1_000_000), proof: ProofSchema }),
  z.object({ type: z.literal("output"), terminalId: Id, data: z.string(), replay: z.boolean().optional(), part: OutputPartSchema.optional() }),
  z.object({ type: z.literal("exit"), terminalId: Id, exitCode: z.number().int().nullable() }),
  z.object({ type: z.literal("res"), id: ReqId, ok: z.literal(true), result: z.unknown() }),
  z.object({ type: z.literal("res"), id: ReqId, ok: z.literal(false), error: ErrorSchema }),
  z.object({ type: z.literal("event"), name: z.literal("cards.changed"), projectId: Id }),
  z.object({ type: z.literal("event"), name: z.literal("terminals.changed"), projectId: Id, cardId: Id.optional() }),
  z.object({ type: z.literal("event"), name: z.literal("projects.changed") }),
  z.object({ type: z.literal("event"), name: z.literal("sshHosts.changed") }),
  z.object({ type: z.literal("event"), name: z.literal("tools.changed") }),
  z.object({ type: z.literal("event"), name: z.literal("settings.changed") }),
  ...TodoEventSchemas,
  ...AgentEventSchemas,
  ...BgAgentEventSchemas,
  ...ClaudeAccountEventSchemas, // İş H
  ...ClaudeUsageEventSchemas, // Claude kullanımı
  BrowserFrameMessageSchema,
  BrowserChangedEventSchema,
  BrowserRevealEventSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

// ---------- parsing ----------

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const hasProtoKey = (v: object): boolean => Object.prototype.hasOwnProperty.call(v, "__proto__");

/** JSON text → a plain object, or why not. Shared by both directions. */
function decodeFrame(raw: string): ParseResult<Record<string, unknown>> {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, error: "empty frame" };
  if (raw.length > MAX_MESSAGE_BYTES) return { ok: false, error: "frame too large" };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
  if (!isPlainObject(data)) return { ok: false, error: "not an object" };
  if (hasProtoKey(data)) return { ok: false, error: "forbidden key" };
  return { ok: true, value: data };
}

function parseWith<T>(schema: z.ZodTypeAny, raw: string): ParseResult<T> {
  const decoded = decodeFrame(raw);
  if (!decoded.ok) return decoded;
  const r = schema.safeParse(decoded.value);
  if (!r.success) return { ok: false, error: r.error.issues[0]?.message ?? "invalid message" };
  return { ok: true, value: r.data as T };
}

/**
 * A `req` frame whose envelope is valid (type, non-negative integer id, known method, params is a plain object,
 * no extra keys). Its params are NOT validated here.
 */
const RequestEnvelopeSchema = z
  .object({
    type: z.literal("req"),
    id: ReqId,
    method: z.enum(Object.keys(RequestParams) as [Method, ...Method[]]),
    params: z.custom<Record<string, unknown>>((v) => isPlainObject(v) && !hasProtoKey(v)),
  })
  .strict();

/** The same envelope for a method name this side may not know: printable, bounded, nothing else relaxed. */
const UnknownRequestEnvelopeSchema = z
  .object({
    type: z.literal("req"),
    id: ReqId,
    method: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,199}$/),
    params: z.custom<Record<string, unknown>>((v) => isPlainObject(v) && !hasProtoKey(v)),
  })
  .strict();

/** One zod issue as a short Turkish sentence, prefixed with the field path when there is one. */
export function describeIssue(issue: z.core.$ZodIssue): string {
  const field = issue.path.map(String).join(".");
  const text = issueText(issue);
  return field ? `${field}: ${text}` : text;
}

function issueText(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case "too_small":
      return issue.origin === "string"
        ? Number(issue.minimum) <= 1
          ? st("validation.notEmpty")
          : st("validation.issue.minChars", { min: String(issue.minimum) })
        : st("validation.issue.min", { min: String(issue.minimum) });
    case "too_big":
      return issue.origin === "string" ? st("validation.issue.maxChars", { max: String(issue.maximum) }) : st("validation.issue.max", { max: String(issue.maximum) });
    case "invalid_type":
      return issue.input === undefined ? st("validation.issue.required") : st("validation.issue.badType");
    case "unrecognized_keys":
      return st("validation.issue.unknownKeys", { keys: issue.keys.join(", ") });
    case "invalid_value":
    case "invalid_union":
      return st("validation.issue.badValue");
    default:
      // custom refinements and regexes carry our own Turkish messages
      return issue.message;
  }
}

export type ClientParseResult =
  | { ok: true; value: ClientMessage }
  | {
      ok: false;
      error: string;
      /**
       * Set when the frame is a well-formed request envelope whose params are invalid: the engine answers it with
       * an INVALID `res` (message = `badRequest.message`) instead of closing the connection.
       */
      badRequest?: { id: number; method: Method; message: string };
      /**
       * Kendini güncelleme: set when the frame is a well-formed request envelope for a method this side does not
       * know (a newer peer). The engine answers it with an UNKNOWN_METHOD `res` instead of closing the connection.
       */
      unknownMethod?: { id: number; method: string };
    };

export function parseClientMessage(raw: string): ClientParseResult {
  const decoded = decodeFrame(raw);
  if (!decoded.ok) return decoded;
  const r = ClientMessageSchema.safeParse(decoded.value);
  if (r.success) return { ok: true, value: r.data as ClientMessage };
  const error = r.error.issues[0]?.message ?? "invalid message";
  const env = RequestEnvelopeSchema.safeParse(decoded.value);
  if (!env.success) {
    const unknown = UnknownRequestEnvelopeSchema.safeParse(decoded.value);
    if (unknown.success && !Object.hasOwn(RequestParams, unknown.data.method)) {
      return { ok: false, error, unknownMethod: { id: unknown.data.id, method: unknown.data.method } };
    }
    return { ok: false, error };
  }
  const params = RequestParams[env.data.method].safeParse(env.data.params, { reportInput: true });
  const issue = params.success ? undefined : params.error.issues[0];
  const message = issue ? describeIssue(issue) : st("validation.badRequest");
  return { ok: false, error, badRequest: { id: env.data.id, method: env.data.method, message } };
}

export function parseServerMessage(raw: string): ParseResult<ServerMessage> {
  return parseWith<ServerMessage>(ServerMessageSchema, raw);
}
