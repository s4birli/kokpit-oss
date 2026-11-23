// İş M: the security rules of the web-site views as pure functions (web-host.ts wires them into Electron).
//
// Plain http (e.g. a dashboard on a home server): a site whose address is a private IP literal (config `httpAllowedCidrs`: Tailscale,
// loopback — see @kokpit/shared web-url.ts) may be loaded over http, and then stays inside its own origin:
// - it navigates, opens child windows and makes http/ws requests only on its own scheme+address+port;
// - an https link in it opens in the user's browser (main frame) or loads as a frame/resource, as on any page;
// - an https site never goes to http (no downgrade), and no site ever reaches a public address over http.
import { isHttpsUrl, isPrivateHttpUrl } from "@kokpit/shared";
import { checkSites, isSiteId, type SiteRules, type WebBounds, type WebConfig, type WebSite } from "../renderer/engine/web-ipc.ts";
import { hostMatches, loopbackTrustHost, navigationAllowed, parseBounds, withoutTestSwitches } from "./web-view-policy.ts";
import { t } from "../i18n/index.ts";

/** Test-only: a JSON site list used instead of the app config's defaults (so tests never load the real sites). */
export const WEB_TEST_SITES_ENV = "KOKPIT_TEST_WEB_SITES";
/** Test-only: a loopback host whose self-signed https certificate the site partitions accept. */
export const WEB_TEST_TRUST_HOST_ENV = "KOKPIT_TEST_WEB_TRUST_HOST";

export class WebError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebError";
  }
}

export function sitePartition(cfg: Pick<WebConfig, "partitionPrefix" | "limits">, siteId: unknown): string {
  if (!isSiteId(siteId, cfg)) throw new WebError(t("main.web.invalidSiteId"));
  return `${cfg.partitionPrefix}${siteId}`;
}

/** The renderer names a site and where to show it; the URL is main's own. */
export function parseWebShowRequest(raw: unknown): { siteId: string; bounds: WebBounds } {
  if (typeof raw !== "object" || raw === null) throw new WebError(t("main.common.invalidRequest"));
  const r = raw as Record<string, unknown>;
  if (!isSiteId(r.siteId)) throw new WebError(t("main.web.invalidSiteId"));
  const bounds = parseBounds(r.bounds);
  if (!bounds) throw new WebError(t("main.common.invalidBounds"));
  return { siteId: r.siteId, bounds };
}

type HttpRules = Pick<WebConfig, "httpAllowedCidrs">;

/** The origin of an http site (`http://100.64.113.61:9119`), or null when `siteUrl` is not an allowed http address. */
function httpSiteOrigin(cfg: HttpRules, siteUrl: string): string | null {
  return isPrivateHttpUrl(siteUrl, cfg.httpAllowedCidrs) ? new URL(siteUrl).origin : null;
}

/** `raw` is an allowed http address on exactly the http site's origin (same address and port). */
function onHttpSite(cfg: HttpRules, origin: string | null, raw: string): boolean {
  return origin !== null && isPrivateHttpUrl(raw, cfg.httpAllowedCidrs) && new URL(raw).origin === origin;
}

/** child: a window on the site's partition (its own host, login hosts); external: the user's browser; deny: nothing. */
export function webPopupDecision(cfg: Pick<WebConfig, "authPopupHosts"> & HttpRules, siteUrl: string, raw: string): "child" | "external" | "deny" {
  if (!isHttpsUrl(raw)) return onHttpSite(cfg, httpSiteOrigin(cfg, siteUrl), raw) ? "child" : "deny";
  const host = new URL(raw).hostname;
  const siteHost = isHttpsUrl(siteUrl) ? new URL(siteUrl).hostname.toLowerCase() : null;
  if (host.toLowerCase() === siteHost || cfg.authPopupHosts.some((h) => hostMatches(host, h))) return "child";
  return "external";
}

/**
 * Where a site's view (and its child windows) may navigate. allow: in the view; external: not in the view, the
 * user's browser instead; deny: nowhere.
 * - An https site: https only, as before — never down to http, not even to a private address.
 * - An http site (private IP literal): its own origin only. https in the main frame leaves for the user's browser;
 *   in a frame it loads. Any other http — another port, another private address, a public one, a host name — is denied.
 */
export function webNavigationDecision(cfg: HttpRules, siteUrl: string, raw: string, frame: { mainFrame: boolean } = { mainFrame: true }): "allow" | "external" | "deny" {
  const origin = httpSiteOrigin(cfg, siteUrl);
  if (origin === null) return isHttpsUrl(siteUrl) && navigationAllowed(raw, frame) ? "allow" : "deny";
  if (onHttpSite(cfg, origin, raw)) return "allow";
  if (isHttpsUrl(raw)) return frame.mainFrame ? "external" : "allow";
  if (frame.mainFrame) return "deny";
  // The page's own helper frames: empty documents and blobs it created (on its own origin or an https one).
  if (raw === "about:blank" || raw === "about:srcdoc") return "allow";
  if (!raw.startsWith("blob:")) return "deny";
  const inner = raw.slice("blob:".length);
  return onHttpSite(cfg, origin, inner) || isHttpsUrl(inner) ? "allow" : "deny";
}

const INSECURE_REQUEST_PROTOCOLS = new Set(["http:", "ws:"]);
/** URL patterns of the requests `webRequestAllowed` judges (everything else is not plain http). */
export const WEB_INSECURE_REQUEST_PATTERNS = ["http://*/*", "ws://*/*"];

/**
 * The network-level backstop behind the navigation rules: may a request of this site's partition leave over plain
 * http/ws? Only an http site's requests to its own address and port. Every other scheme is not this rule's business.
 */
export function webRequestAllowed(cfg: HttpRules, siteUrl: string, raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (!INSECURE_REQUEST_PROTOCOLS.has(u.protocol)) return true;
  if (u.username !== "" || u.password !== "") return false;
  // ws://host:port is judged as http://host:port: same address rule, same origin.
  return onHttpSite(cfg, httpSiteOrigin(cfg, siteUrl), `http://${u.host}/`);
}

/** The site list before the user changed anything: the app config's, or the test-only override. */
export function defaultSites(cfg: Pick<WebConfig, "sites"> & SiteRules, env: NodeJS.ProcessEnv): WebSite[] {
  const raw = env[WEB_TEST_SITES_ENV];
  let list: unknown = cfg.sites;
  if (raw !== undefined && raw !== "") {
    try {
      list = JSON.parse(raw);
    } catch {
      throw new WebError(`${WEB_TEST_SITES_ENV} JSON değil.`);
    }
  }
  const check = checkSites(list, cfg);
  if (!check.ok) throw new WebError(`Varsayılan siteler geçersiz: ${check.errors.join(" ")}`);
  return check.sites;
}

export function webEnv(env: NodeJS.ProcessEnv, isPackaged: boolean): NodeJS.ProcessEnv {
  return withoutTestSwitches(env, isPackaged, [WEB_TEST_SITES_ENV, WEB_TEST_TRUST_HOST_ENV]);
}

export function webTrustHost(env: NodeJS.ProcessEnv): string | null {
  return loopbackTrustHost(env, WEB_TEST_TRUST_HOST_ENV, (m) => new WebError(m));
}
