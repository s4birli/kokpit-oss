// İş M — Web sekmeleri: contract between the renderer's Web panel / Ayarlar › Siteler, the preload and Electron main.
// Each site is shown by main in a WebContentsView of its own (persistent partition `persist:web-<siteId>`, no preload,
// no Node), laid over the Web panel's rectangle. The renderer only names a site by id and reports where the surface
// is; the URL always comes from main's own site list, so the page cannot be pointed anywhere else through IPC.
import { ipInCidrs, ipLiteralBytes, isHttpsUrl, isPrivateHttpUrl, isWebSiteUrl, normalizedUrl } from "@kokpit/shared";
import defaults from "./web.defaults.json" with { type: "json" };
import type { SurfaceBounds, SurfaceStatus } from "./surface.ts";
import { t } from "../../i18n/index.ts";

export const WEB_IPC = {
  show: "web:show",
  hide: "web:hide",
  close: "web:close",
  reload: "web:reload",
  loadSites: "web:sites:load",
  saveSites: "web:sites:save",
  /** main → renderer events. */
  status: "web:status",
  sites: "web:sites",
} as const;

/** App config of the web sites (web.defaults.json): defaults, partition prefix, popup hosts, limits. */
export interface WebConfig {
  partitionPrefix: string;
  /** Default site list (before the user edits it), in Git menu order. */
  sites: WebSite[];
  /**
   * Ids of the defaults that existed before `web-sites.json` recorded which defaults it has seen: a saved list
   * without that record has seen exactly these, so only later defaults are added to it (web-sites-file.ts).
   */
  defaultsSeededBeforeMarker: string[];
  /**
   * Plain http is allowed only for an IP LITERAL inside these ranges (Tailscale, loopback); everything else is
   * https only. Host names are never allowed over http (a name can resolve anywhere). See @kokpit/shared web-url.ts.
   */
  httpAllowedCidrs: string[];
  /**
   * The part of `httpAllowedCidrs` that is only private while Tailscale is up (100.64.0.0/10 is carrier-grade NAT
   * space): an http site in `cidrs` loads only while main has verified, from the Tailscale CLI's local status
   * (`binaries` candidates in order, `statusArgs`, within `timeoutMs` / `maxOutputBytes`), that the tailnet is running
   * and the exact address belongs to it. The answer is reused for `cacheMs` at most. See main/tailnet.ts.
   */
  /**
   * `env` is added to the app's own environment when the CLI runs: the Tailscale binary inside Tailscale.app acts as a
   * CLI only when TERM is set, and an app started from Finder has none (it then tries to start the GUI instead).
   */
  httpTailnet: { cidrs: string[]; binaries: string[]; statusArgs: string[]; env: Record<string, string>; timeoutMs: number; cacheMs: number; maxOutputBytes: number };
  /** Opened and shown on the very first launch (no saved UI state). */
  firstLaunchSiteId: string;
  /** Login hosts whose popups open as child windows on the site's partition (besides the site's own host). */
  authPopupHosts: string[];
  allowedPermissions: string[];
  userAgentDropTokens: string[];
  /** Id of a new site whose URL gives no usable host name. */
  fallbackSiteId: string;
  limits: { maxSites: number; maxTitle: number; maxIdLength: number };
}
export const webConfig: WebConfig = defaults;

export interface WebSite {
  /** Stable; names the partition, so it never changes after the site is added. */
  id: string;
  title: string;
  /** https, or plain http to a private IP literal (`httpAllowedCidrs`). */
  url: string;
}

export type WebBounds = SurfaceBounds;
/**
 * The native view's life cycle, plus `tailnet`: a plain-http site on a Tailscale address was NOT loaded because
 * Tailscale is off or the address is not in the user's tailnet.
 */
export type WebStatus = SurfaceStatus | "tailnet";

/** Shown when a plain-http Tailscale site is not loaded (status `tailnet`); in the current language. */
export const tailnetBlockedText = (): string => t("common.sites.tailnetBlocked");

/** How a site's address travels: https, or plain http protected by Tailscale / kept on this machine. */
export type SiteTransport = "https" | "http-tailnet" | "http-local";

export function siteTransport(url: string, cfg: Pick<WebConfig, "httpAllowedCidrs" | "httpTailnet"> = webConfig): SiteTransport {
  if (isPrivateHttpUrl(url, cfg.httpTailnet.cidrs)) return "http-tailnet";
  return isPrivateHttpUrl(url, cfg.httpAllowedCidrs) ? "http-local" : "https";
}

/** The small mark next to a plain-http site (Ayarlar › Siteler, the site's tab); https sites have none. */
export const SITE_TRANSPORT_BADGES: Record<Exclude<SiteTransport, "https">, { label: string; title: string }> = {
  // i18n: getters, so the texts are in the language current when they are read.
  "http-tailnet": {
    get label() {
      return t("common.sites.badgeTailnetLabel");
    },
    get title() {
      return t("common.sites.badgeTailnetTitle");
    },
  },
  "http-local": {
    get label() {
      return t("common.sites.badgeLocalLabel");
    },
    get title() {
      return t("common.sites.badgeLocalTitle");
    },
  },
};
export interface WebStatusEvent {
  siteId: string;
  status: WebStatus;
}

/** Exposed as `window.kokpit.web`. */
export interface WebBridge {
  /** Creates the site's view if needed, places it over `bounds` and shows it (hiding the other sites). */
  show(req: { siteId: string; bounds: WebBounds }): Promise<void>;
  hide(siteId: string): Promise<void>;
  /** Destroys the view (tab closed); the partition (login) is kept. */
  close(siteId: string): Promise<void>;
  reload(siteId: string): Promise<void>;
  onStatus(listener: (e: WebStatusEvent) => void): () => void;
  sites: {
    load(): Promise<WebSite[]>;
    save(sites: WebSite[]): Promise<void>;
    /** The list changed (saved from Ayarlar); returns the unsubscribe. */
    onChange(listener: (sites: WebSite[]) => void): () => void;
  };
}

const SITE_ID = /^[a-z0-9][a-z0-9-]*$/;

export function isSiteId(v: unknown, cfg: Pick<WebConfig, "limits"> = webConfig): v is string {
  return typeof v === "string" && v.length <= cfg.limits.maxIdLength && SITE_ID.test(v);
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The parts of the config that decide whether a site list is valid. */
export type SiteRules = Pick<WebConfig, "limits" | "httpAllowedCidrs">;

/** Why `url` cannot be a site's address (Turkish), or undefined when it can. */
export function siteUrlError(url: string, cfg: Pick<WebConfig, "httpAllowedCidrs"> = webConfig): string | undefined {
  if (isWebSiteUrl(url, cfg.httpAllowedCidrs)) return undefined;
  let u: URL | null = null;
  try {
    u = /[\s\0-\x1f\x7f]/.test(url) ? null : new URL(url);
  } catch {
    u = null;
  }
  if (u && (u.protocol === "http:" || u.protocol === "https:") && (u.username !== "" || u.password !== "")) {
    return t("common.sites.urlCredentials");
  }
  if (u?.protocol === "http:" && u.hostname !== "") {
    const ip = ipLiteralBytes(u.hostname);
    if (!ip) return t("common.sites.urlHttpNeedsIp");
    if (!ipInCidrs(ip, cfg.httpAllowedCidrs)) {
      return t("common.sites.urlHttpNotPrivate", { cidrs: cfg.httpAllowedCidrs.join(", ") });
    }
  }
  return t("common.sites.urlScheme");
}

/** One site → its normalized form, or a Turkish error. */
function checkSite(raw: unknown, cfg: SiteRules): { site: WebSite } | { error: string } {
  if (!isRecord(raw)) return { error: t("common.sites.invalidSite") };
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  if (!isSiteId(raw.id, cfg)) return { error: t("common.sites.invalidId", { title: title || t("common.sites.site") }) };
  if (title === "") return { error: t("common.sites.nameRequired") };
  if (title.length > cfg.limits.maxTitle) return { error: t("common.sites.nameTooLong", { title: title.slice(0, 20), max: cfg.limits.maxTitle }) };
  const urlError = siteUrlError(url, cfg);
  if (urlError) return { error: t("common.sites.urlError", { title, error: urlError }) };
  // An http address is kept as the URL parser normalized it (`http://0144.0100.0161.075` → `http://100.64.113.61/`):
  // the list then shows the address that is really loaded.
  const stored = isHttpsUrl(url) ? url : (normalizedUrl(url) ?? url);
  return { site: { id: raw.id, title, url: stored } };
}

export type SitesCheck = { ok: true; sites: WebSite[] } | { ok: false; errors: string[] };

/** The whole list: every site valid, ids unique, not too many. Used by main (authority) and Ayarlar alike. */
export function checkSites(raw: unknown, cfg: SiteRules = webConfig): SitesCheck {
  if (!Array.isArray(raw)) return { ok: false, errors: [t("common.sites.invalidList")] };
  if (raw.length > cfg.limits.maxSites) return { ok: false, errors: [t("common.sites.tooMany", { max: cfg.limits.maxSites })] };
  const errors: string[] = [];
  const sites: WebSite[] = [];
  const ids = new Set<string>();
  for (const item of raw) {
    const r = checkSite(item, cfg);
    if ("error" in r) {
      errors.push(r.error);
      continue;
    }
    if (ids.has(r.site.id)) errors.push(t("common.sites.duplicateId", { title: r.site.title }));
    ids.add(r.site.id);
    sites.push(r.site);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, sites };
}

/** Whatever came from disk/IPC → the valid sites in it (invalid and duplicate entries dropped). */
export function parseSites(raw: unknown, cfg: SiteRules = webConfig): WebSite[] {
  if (!Array.isArray(raw)) return [];
  const out: WebSite[] = [];
  for (const item of raw.slice(0, cfg.limits.maxSites)) {
    const r = checkSite(item, cfg);
    if ("site" in r && !out.some((s) => s.id === r.site.id)) out.push(r.site);
  }
  return out;
}

/**
 * An id for a new site, made unique among `taken`: the first label of its host as a slug; for an IP address the
 * whole address and the port (`http://100.64.113.61:9119` → `100-64-113-61-9119`), so two services on one machine
 * get different ids — and with them different login partitions.
 */
export function newSiteId(url: string, taken: readonly string[], cfg: Pick<WebConfig, "limits" | "fallbackSiteId"> = webConfig): string {
  let base = cfg.fallbackSiteId;
  try {
    const u = new URL(url.trim());
    const labels = u.hostname.split(".").filter((l) => l !== "www");
    const name = ipLiteralBytes(u.hostname) ? `${u.hostname}-${u.port}`.replace(/[^0-9a-f]+/gi, "-") : (labels[0] ?? "");
    const slug = name
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "")
      .replace(/^-+|-+$/g, "");
    if (slug !== "") base = slug;
  } catch {
    /* not a URL: fallback id */
  }
  // Room for a "-NN" suffix.
  base = base.slice(0, cfg.limits.maxIdLength - 4).replace(/-+$/, "") || cfg.fallbackSiteId;
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!taken.includes(id)) return id;
  }
}
