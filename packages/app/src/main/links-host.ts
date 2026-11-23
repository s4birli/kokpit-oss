// Bağlantılar — main side: the only code that hands an address to the operating system (`shell.openExternal`), and
// the native right-click menu of a link in a terminal. Everything arriving here is untrusted IPC input: a program's
// output decides what a link says, so main checks the address itself — http(s) only, normalized, not too often.
// Addresses are never logged.
import type { MenuItemConstructorOptions } from "electron";
import { createRateLimiter, INVISIBLE_CHARS, parseLinkTarget, PATH_LIMITS, webLinkUrl } from "@kokpit/shared";
import { shortenUrl, type LinkMenuChoice, type LinkMenuRequest, type LinksConfig, type PathMenuRequest } from "../renderer/engine/links-ipc.ts";
import { withoutTestSwitches } from "./web-view-policy.ts";
import { t } from "../i18n/index.ts";

/** Test-only: "record" keeps every address that would go to the default browser in a list instead of opening it. */
export const EXTERNAL_OPEN_TEST_ENV = "KOKPIT_TEST_EXTERNAL_OPEN";
const RECORD = "record";
/** Test mode only: where main keeps the recorded addresses (`globalThis[...]`), for the end-to-end tests to read. */
export const EXTERNAL_OPEN_RECORD_GLOBAL = "__kokpitExternalOpens";

export class LinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkError";
  }
}

type Item = MenuItemConstructorOptions;

/** The environment the opener may read: the test-only switch is removed in a packaged app. */
export function linksEnv(env: NodeJS.ProcessEnv, isPackaged: boolean): NodeJS.ProcessEnv {
  return withoutTestSwitches(env, isPackaged, [EXTERNAL_OPEN_TEST_ENV]);
}

export interface ExternalOpener {
  open(url: string): Promise<void>;
  /** Test mode only: what would have been opened, oldest first. */
  readonly recorded: string[] | undefined;
}

/** Every "open in the default browser" of the app goes through this, so a test run never opens the real one. */
export function createExternalOpener(deps: { env: NodeJS.ProcessEnv; openExternal(url: string): Promise<void> }): ExternalOpener {
  const recorded: string[] | undefined = deps.env[EXTERNAL_OPEN_TEST_ENV] === RECORD ? [] : undefined;
  return {
    recorded,
    async open(url) {
      if (recorded) recorded.push(url);
      else await deps.openExternal(url);
    },
  };
}

/** What a link may be copied as: the normalized address when it has one, else the text as written; null = nothing. */
function copyText(raw: string): string | null {
  const target = parseLinkTarget(raw);
  if (target.kind !== "refused") return target.url;
  // Written without control characters and not oversized: safe to put on the clipboard as it is.
  return target.reason === "scheme" || target.reason === "malformed" || target.reason === "credentials" ? raw : null;
}

/**
 * The right-click menu of a link. First line: the real target (disabled, shortened) — an OSC 8 link's text may say
 * anything. Then, for http(s) only, where to open it; and "Bağlantıyı kopyala". Nothing usable → no menu.
 */
export function linkMenuTemplate(req: LinkMenuRequest, cfg: LinksConfig, choose: (choice: LinkMenuChoice, copy: string) => void): Item[] {
  const copy = copyText(req.url);
  if (copy === null) return [];
  const web = parseLinkTarget(req.url).kind === "web";
  return [
    { label: shortenUrl(copy, cfg.menuTargetMaxChars), enabled: false },
    { type: "separator" },
    ...(web && req.browser ? [{ label: t("links.labels.openBrowser"), click: () => choose("browser", copy) } satisfies Item] : []),
    ...(web ? [{ label: t("links.labels.openExternal"), click: () => choose("external", copy) } satisfies Item] : []),
    { label: t("links.labels.copyLink"), click: () => choose("copy", copy) },
  ];
}

/**
 * Yollar: the right-click menu of a file path. First line: the path (disabled, shortened). "Tarayıcıda aç" and
 * "Dosyalar'da göster" only when the renderer says the engine offers them — the engine checks again when asked;
 * "Yolu kopyala" always. A path with invisible or control characters, or an absurd length, gets no menu.
 */
export function pathMenuTemplate(req: PathMenuRequest, cfg: LinksConfig, choose: (choice: LinkMenuChoice, copy: string) => void): Item[] {
  if (req.path === "" || req.path.length > PATH_LIMITS.maxPathChars || INVISIBLE_CHARS.test(req.path)) return [];
  return [
    { label: shortenUrl(req.path, cfg.menuTargetMaxChars), enabled: false },
    { type: "separator" },
    ...(req.browser ? [{ label: t("links.labels.openBrowser"), click: () => choose("browser", req.path) } satisfies Item] : []),
    ...(req.files ? [{ label: t("links.labels.showInFiles"), click: () => choose("files", req.path) } satisfies Item] : []),
    { label: t("links.labels.copyPath"), click: () => choose("copy", req.path) },
  ];
}

export interface LinksHostDeps {
  config: LinksConfig;
  /** Hands an (already checked) http(s) address to the default browser. */
  openExternal(url: string): Promise<void>;
  /** Electron `clipboard.writeText`. */
  write(text: string): void;
  /** Shows a native context menu over the app window; `onClose` when it went away, chosen or not. */
  popup(template: Item[], onClose: () => void): void;
  now?: () => number;
  /** Runs `fn` after `ms` (the grace between a menu's close and its item's click). */
  defer?: (fn: () => void, ms: number) => void;
}

function parseMenuRequest(raw: unknown, cfg: LinksConfig): LinkMenuRequest | PathMenuRequest {
  const r = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  if (!r || typeof r.browser !== "boolean") throw new LinkError(t("links.text.invalidRequest"));
  // Never both: a request is about an address or about a path.
  if (typeof r.path === "string" && r.url === undefined && typeof r.files === "boolean") return { path: r.path, browser: r.browser, files: r.files };
  if (typeof r.url !== "string" || r.path !== undefined) throw new LinkError(t("links.text.invalidRequest"));
  return { url: r.url, browser: r.browser };
}

export function createLinksHost(deps: LinksHostDeps) {
  const { config } = deps;
  const limiter = createRateLimiter({ ...config.rate, ...(deps.now ? { now: deps.now } : {}) });
  const defer = deps.defer ?? ((fn, ms) => void setTimeout(fn, ms));

  /** The normalized http(s) address of `raw`, counted against the rate limit; throws when it may not be opened. */
  function checkWeb(raw: unknown): string {
    const url = webLinkUrl(raw);
    if (url === null) throw new LinkError(t("links.text.refusedInvalid"));
    if (!limiter.allow()) throw new LinkError(t("links.text.rateLimited"));
    return url;
  }

  return {
    checkWeb,
    /** The default browser of this machine. */
    async openExternal(raw: unknown): Promise<void> {
      await deps.openExternal(checkWeb(raw));
    },
    /** Right click on a link. "copy" is done here; "browser" / "external" go back to the renderer, which opens. */
    menu(raw: unknown): Promise<LinkMenuChoice | null> {
      let req: LinkMenuRequest | PathMenuRequest;
      try {
        req = parseMenuRequest(raw, config);
      } catch (err) {
        return Promise.reject(err);
      }
      return new Promise((resolve, reject) => {
        const choose = (choice: LinkMenuChoice, copy: string): void => {
          if (choice === "copy") deps.write(copy);
          resolve(choice);
        };
        const template = "path" in req ? pathMenuTemplate(req, config, choose) : linkMenuTemplate(req, config, choose);
        if (template.length === 0) {
          reject(new LinkError(t("links.text.refusedInvalid")));
          return;
        }
        // macOS may report the close before it delivers the click: "nothing chosen" waits a moment for it.
        deps.popup(template, () => defer(() => resolve(null), config.menuCloseGraceMs));
      });
    },
  };
}
