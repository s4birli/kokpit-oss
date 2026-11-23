// İş M: web pages inside the app window. One WebContentsView per key (e.g. a web
// site), laid over the rectangle the renderer reports, on a persistent partition of its own so logins
// survive restarts. A view has no preload and no Node, may only navigate to https (or where the caller's `navigation`
// policy says: a web site on a private http address stays on its own origin), opens popups as child windows on
// the same partition only when the caller's policy says so (login pages), sends every other link to the user's
// browser and never downloads. Kokpit never reads the page, its cookies or credentials.
import { session as electronSession, WebContentsView, type BrowserWindow, type Session, type WebContents } from "electron";
import type { SurfaceBounds, SurfaceStatus } from "../renderer/engine/surface.ts";
import { cleanUserAgent, navigationAllowed } from "./web-view-policy.ts";
import windowDefaults from "./window.defaults.json" with { type: "json" };

/** Chromium's "aborted" (a navigation replaced by another); not a failure worth showing. */
const ERR_ABORTED = -3;
/** setCertificateVerifyProc: 0 = trust, -3 = use Chromium's own verdict. */
const CERT_TRUST = 0;
const CERT_DEFAULT = -3;

export type PopupDecision = "child" | "external" | "deny";
export type NavigationDecision = "allow" | "external" | "deny";

export interface WebViewHostOptions {
  /** The app window the views are laid into (null before it exists / after it closed). */
  window(): BrowserWindow | null;
  openExternal(url: string): void;
  /** The persistent partition of a key; throws for an unsafe key. */
  partition(key: string): string;
  /** What a popup of `key`'s view (or of its child windows) becomes. */
  popup(key: string, url: string): PopupDecision;
  /**
   * Where `key`'s view (and its child windows) may navigate; "external" = not in the view, the user's browser
   * instead (main frame only). Absent: https only (web-view-policy.ts `navigationAllowed`).
   */
  navigation?(key: string, url: string, frame: { mainFrame: boolean }): NavigationDecision;
  /**
   * Network-level backstop: called for every plain http/ws request (`insecureRequestPatterns`) of `key`'s
   * partition; false cancels it. Absent: no request filter.
   */
  requestAllowed?(key: string, url: string): boolean | Promise<boolean>;
  /** URL patterns handed to `requestAllowed`. */
  insecureRequestPatterns?: readonly string[];
  allowedPermissions: readonly string[];
  userAgentDropTokens: readonly string[];
  /** Test-only loopback host whose self-signed certificate is accepted (null: none). */
  trustHost: string | null;
  onStatus(key: string, status: SurfaceStatus): void;
}

interface Entry {
  view: WebContentsView;
  url: string;
  attached: boolean;
}

export function createWebViewHost(opts: WebViewHostOptions) {
  const views = new Map<string, Entry>();
  const prepared = new Set<string>();

  function prepareSession(key: string, partition: string): Session {
    const ses = electronSession.fromPartition(partition);
    if (prepared.has(partition)) return ses;
    prepared.add(partition);
    const requestAllowed = opts.requestAllowed;
    if (requestAllowed) {
      // One partition belongs to one key, so its requests are judged by that key's rule (looked up per request:
      // the site's address may change while the app runs).
      // Fail closed: a rule that throws or rejects cancels the request.
      ses.webRequest.onBeforeRequest({ urls: [...(opts.insecureRequestPatterns ?? [])] }, (details, cb) => {
        Promise.resolve()
          .then(() => requestAllowed(key, details.url))
          .then(
            (ok) => cb({ cancel: ok !== true }),
            () => cb({ cancel: true }),
          );
      });
    }
    const allowed = new Set(opts.allowedPermissions);
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
    ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
    ses.setUserAgent(cleanUserAgent(opts, ses.getUserAgent()));
    // Files never land on this Mac through an embedded page.
    ses.on("will-download", (e) => e.preventDefault());
    const trustHost = opts.trustHost;
    if (trustHost !== null) {
      ses.setCertificateVerifyProc((req, cb) => cb(req.hostname === trustHost ? CERT_TRUST : CERT_DEFAULT));
    }
    return ses;
  }

  /** Navigation and popup rules for the view and every popup it opens. */
  function guard(wc: WebContents, key: string, partition: string): void {
    const block = (e: { preventDefault(): void; url: string; isMainFrame: boolean }) => {
      const frame = { mainFrame: e.isMainFrame };
      const decision: NavigationDecision = opts.navigation ? opts.navigation(key, e.url, frame) : navigationAllowed(e.url, frame) ? "allow" : "deny";
      if (decision === "allow") return;
      e.preventDefault();
      // A prevented navigation emits no further will-* event, so the link is handed over once.
      if (decision === "external" && e.isMainFrame) opts.openExternal(e.url);
    };
    wc.on("will-navigate", block);
    wc.on("will-redirect", block);
    wc.on("will-frame-navigate", block);
    wc.on("will-attach-webview", (e) => e.preventDefault());
    wc.setWindowOpenHandler(({ url }) => {
      const decision = opts.popup(key, url);
      if (decision === "child") {
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            parent: opts.window() ?? undefined,
            autoHideMenuBar: true,
            webPreferences: {
              partition,
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
              webviewTag: false,
            },
          },
        };
      }
      if (decision === "external") opts.openExternal(url);
      return { action: "deny" };
    });
    wc.on("did-create-window", (child) => guard(child.webContents, key, partition));
  }

  function create(key: string, url: string): Entry {
    const partition = opts.partition(key);
    const ses = prepareSession(key, partition);
    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        webSecurity: true,
        safeDialogs: true,
      },
    });
    // Before its page paints (loading, or the strip uncovered while the view grows with the window) the view shows
    // its own background: the app's, not white.
    view.setBackgroundColor(windowDefaults.backgroundColor);
    const wc = view.webContents;
    guard(wc, key, partition);
    wc.on("did-start-loading", () => opts.onStatus(key, "connecting"));
    wc.on("did-finish-load", () => {
      opts.onStatus(key, "ready");
      // Write the login cookies to disk now rather than at some later flush.
      void ses.cookies.flushStore().catch(() => {});
    });
    wc.on("did-fail-load", (_e, code, _desc, _url, isMainFrame) => {
      if (isMainFrame && code !== ERR_ABORTED) opts.onStatus(key, "failed");
    });
    wc.on("render-process-gone", () => opts.onStatus(key, "failed"));
    const entry: Entry = { view, url, attached: false };
    views.set(key, entry);
    opts.onStatus(key, "connecting");
    void wc.loadURL(url).catch(() => {});
    return entry;
  }

  function detach(entry: Entry): void {
    const win = opts.window();
    if (entry.attached && win && !win.isDestroyed()) win.contentView.removeChildView(entry.view);
    entry.attached = false;
  }

  return {
    /**
     * Creates `key`'s view if needed (loading `url`, or reloading when the URL changed), places it over `bounds` and
     * shows it; the host's other views are hidden (one on screen at a time). False when there is no window.
     */
    show(key: string, url: string, bounds: SurfaceBounds): boolean {
      const win = opts.window();
      if (!win || win.isDestroyed()) return false;
      let entry = views.get(key);
      if (entry && entry.url !== url) {
        entry.url = url;
        void entry.view.webContents.loadURL(url).catch(() => {});
      }
      entry ??= create(key, url);
      for (const [id, other] of views) if (id !== key) other.view.setVisible(false);
      if (!entry.attached) {
        win.contentView.addChildView(entry.view);
        entry.attached = true;
      }
      entry.view.setBounds(bounds);
      entry.view.setVisible(true);
      return true;
    },

    hide(key: string): void {
      views.get(key)?.view.setVisible(false);
    },

    reload(key: string): void {
      const wc = views.get(key)?.view.webContents;
      if (wc && !wc.isDestroyed()) wc.reload();
    },

    /** Destroys the view; the persistent partition (login) stays. False when there was none. */
    close(key: string): boolean {
      const entry = views.get(key);
      if (!entry) return false;
      views.delete(key);
      detach(entry);
      const wc = entry.view.webContents;
      void wc.session.cookies.flushStore().catch(() => {});
      if (!wc.isDestroyed()) wc.close();
      return true;
    },

    keys(): string[] {
      return [...views.keys()];
    },

    /** Window closing: drop every view (partitions stay on disk). */
    destroyAll(): void {
      for (const key of [...views.keys()]) this.close(key);
    },
  };
}

export type WebViewHost = ReturnType<typeof createWebViewHost>;
