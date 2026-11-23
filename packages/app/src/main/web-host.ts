// İş M — Web sekmeleri: the user's sites (Ana sayfa, Wiki, …) inside the app window, one WebContentsView per
// site on its own persistent partition (`persist:web-<siteId>`, the login survives restarts) through the shared
// web-view-host.ts: https (or plain http to a private IP literal, kept on its own origin — web-policy.ts), no preload,
// no Node, nothing of the page reaches Kokpit or the engine. The renderer names a site by id; the URL always comes
// from main's own list (web-sites-file.ts).
import type { BrowserWindow } from "electron";
import type { WebBounds, WebConfig, WebSite, WebStatusEvent } from "../renderer/engine/web-ipc.ts";
import { tailnetAddressOf, type TailnetVerifier } from "./tailnet.ts";
import { createWebViewHost } from "./web-view-host.ts";
import {
  parseWebShowRequest,
  sitePartition,
  WEB_INSECURE_REQUEST_PATTERNS,
  WebError,
  webNavigationDecision,
  webPopupDecision,
  webRequestAllowed,
  webTrustHost,
} from "./web-policy.ts";
import type { WebSitesFile } from "./web-sites-file.ts";
import { t } from "../i18n/index.ts";

export interface WebHostDeps {
  config: WebConfig;
  env: NodeJS.ProcessEnv;
  window(): BrowserWindow | null;
  openExternal(url: string): void;
  file: WebSitesFile;
  emitStatus(e: WebStatusEvent): void;
  /** The list changed (renderer event + Git menu). */
  sitesChanged(sites: WebSite[]): void;
  /** Says whether an address is, right now, a machine of the user's running tailnet (tailnet.ts). */
  tailnet: TailnetVerifier;
  /** Wipes a partition's cookies/storage (Electron: `session.fromPartition(p).clearStorageData()`). */
  clearSiteData(partition: string): Promise<void>;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export function createWebHost(deps: WebHostDeps) {
  const { config } = deps;
  let sites: WebSite[] = [];
  const urlOf = (siteId: string): string => sites.find((s) => s.id === siteId)?.url ?? "";
  /** Where each site was last asked to be shown (Yenile re-shows a site that was not loaded). */
  const lastBounds = new Map<string, WebBounds>();
  /** Bumped by every show/hide/close/reload of a site: an older, still waiting show gives way. */
  const turn = new Map<string, number>();
  const nextTurn = (siteId: string): number => {
    const n = (turn.get(siteId) ?? 0) + 1;
    turn.set(siteId, n);
    return n;
  };

  /**
   * A plain-http site on a Tailscale-range address may be loaded only while that exact address is verified to be in
   * the user's running tailnet. Everything else (https, loopback http) needs no such check. Never rejects; any
   * doubt is "no".
   */
  const tailnetOk = async (siteUrl: string): Promise<boolean> => {
    const ip = tailnetAddressOf(config.httpTailnet, siteUrl);
    return ip === null || (await deps.tailnet.verify(ip).catch(() => false));
  };

  const host = createWebViewHost({
    window: deps.window,
    openExternal: deps.openExternal,
    partition: (siteId) => sitePartition(config, siteId),
    popup: (siteId, url) => webPopupDecision(config, urlOf(siteId), url),
    navigation: (siteId, url, frame) => webNavigationDecision(config, urlOf(siteId), url, frame),
    // Every plain http/ws request of an http site re-checks the tailnet (cached for a few seconds): when Tailscale
    // goes down mid-session nothing more leaves in clear text.
    requestAllowed: async (siteId, url) => webRequestAllowed(config, urlOf(siteId), url) && (await tailnetOk(urlOf(siteId))),
    insecureRequestPatterns: WEB_INSECURE_REQUEST_PATTERNS,
    allowedPermissions: config.allowedPermissions,
    userAgentDropTokens: config.userAgentDropTokens,
    trustHost: webTrustHost(deps.env),
    onStatus: (siteId, status) => {
      if (status !== "failed" || tailnetAddressOf(config.httpTailnet, urlOf(siteId)) === null) return deps.emitStatus({ siteId, status });
      // A Tailscale http site failed to load: ask Tailscale again, and say so when that is the reason.
      deps.tailnet.invalidate();
      void tailnetOk(urlOf(siteId)).then((ok) => (ok ? deps.emitStatus({ siteId, status }) : blocked(siteId)));
    },
  });

  const close = (siteId: string): void => {
    nextTurn(siteId);
    if (host.close(siteId)) deps.emitStatus({ siteId, status: "closed" });
  };

  /** The site is not loaded (and its view, if any, is dropped): Tailscale is off or the address is not in the tailnet. */
  const blocked = (siteId: string): void => {
    host.close(siteId);
    deps.emitStatus({ siteId, status: "tailnet" });
  };

  /** Shows the site — after the tailnet check when it needs one. A newer call for the same site wins. */
  const show = async (site: WebSite, bounds: WebBounds): Promise<void> => {
    const mine = nextTurn(site.id);
    lastBounds.set(site.id, bounds);
    const ok = await tailnetOk(site.url);
    if (turn.get(site.id) !== mine) return;
    if (!ok) return blocked(site.id);
    if (!host.show(site.id, site.url, bounds)) throw new WebError(t("main.common.noWindow"));
  };

  return {
    async init(): Promise<WebSite[]> {
      sites = await deps.file.load();
      return sites;
    },

    sites: (): WebSite[] => sites,

    async show(raw: unknown): Promise<void> {
      const req = parseWebShowRequest(raw);
      const site = sites.find((s) => s.id === req.siteId);
      if (!site) throw new WebError(t("main.web.siteGone"));
      await show(site, req.bounds);
    },

    hide(siteId: unknown): void {
      if (typeof siteId !== "string") return;
      nextTurn(siteId);
      host.hide(siteId);
    },

    /** Yenile: reloads the page; a Tailscale http site is checked afresh first, and shown again if it was not loaded. */
    async reload(siteId: unknown): Promise<void> {
      if (typeof siteId !== "string") return;
      const site = sites.find((s) => s.id === siteId);
      if (!site) return;
      if (tailnetAddressOf(config.httpTailnet, site.url) === null) return host.reload(siteId);
      deps.tailnet.invalidate();
      if (host.keys().includes(siteId)) {
        const mine = nextTurn(siteId);
        const ok = await tailnetOk(site.url);
        if (turn.get(siteId) !== mine) return;
        return ok ? host.reload(siteId) : blocked(siteId);
      }
      const bounds = lastBounds.get(siteId);
      if (bounds) await show(site, bounds);
    },

    close(siteId: unknown): void {
      if (typeof siteId === "string") close(siteId);
    },

    async saveSites(raw: unknown): Promise<void> {
      const before = new Map(sites.map((s) => [s.id, originOf(s.url)]));
      sites = await deps.file.save(raw);
      // A site that left the list, or whose id now points at another origin, loses its view and its login: the
      // partition is named by the id, so a later site with that id must not inherit the old session.
      const stale = [...before].filter(([id, origin]) => {
        const now = sites.find((s) => s.id === id);
        return !now || originOf(now.url) !== origin;
      });
      for (const id of [...lastBounds.keys()]) if (!sites.some((s) => s.id === id)) lastBounds.delete(id);
      for (const [id] of stale) close(id);
      for (const id of host.keys()) if (!sites.some((s) => s.id === id)) close(id);
      for (const [id] of stale) await deps.clearSiteData(sitePartition(config, id));
      deps.sitesChanged(sites);
    },

    destroyAll(): void {
      for (const id of host.keys()) close(id);
    },
  };
}

export type WebHost = ReturnType<typeof createWebHost>;
