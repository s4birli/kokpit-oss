// What the app window may load from the network besides its own page.
//
// İş C — Harita: a sub-frame may show the engine's one-time map page (`/map/<token>`).
// Dosyalar — medya: <video>, <audio>, <img> and one PDF frame may load a media URL (`/files/media/<token>`) — and
// only from the engine the app is connected to. Nothing else: no other sub-frame navigation (a link inside the map
// or a PDF, a script setting location), no script, style, font or fetch from an http(s) address. The renderer's CSP
// has to name whole schemes (`media-src http: https:`), because the engine's address is not known when the page is
// built; this guard narrows them to exactly these URLs for exactly these kinds of request.
import { FILES_MEDIA_PDF_FRAGMENT, isFilesMediaTokenPath, isMapTokenPath } from "@kokpit/shared";

const FRAME_PROTOCOLS = new Set(["http:", "https:"]);
const HTTP_FOR_WS: Record<string, string> = { "ws:": "http:", "wss:": "https:" };

/** Origin of the engine's HTTP listener for its WebSocket address (ws://h:p → http://h:p), or null. */
export function engineHttpOrigin(engineUrl: string | null | undefined): string | null {
  if (!engineUrl) return null;
  try {
    const url = new URL(engineUrl);
    const protocol = HTTP_FOR_WS[url.protocol];
    return protocol && url.host ? `${protocol}//${url.host}` : null;
  } catch {
    return null;
  }
}

function parse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * A media URL of the connected engine: its origin, a token path, and nothing after it — except, for the PDF frame
 * (`pdfFrame`), the one fragment that hides the viewer's toolbar.
 */
export function isEngineMediaUrl(raw: string, engineOrigin: string | null, pdfFrame = false): boolean {
  const url = parse(raw);
  if (!url || engineOrigin === null || !FRAME_PROTOCOLS.has(url.protocol)) return false;
  const hashOk = url.hash === "" || (pdfFrame && url.hash === FILES_MEDIA_PDF_FRAGMENT);
  return url.origin === engineOrigin && url.username === "" && url.password === "" && url.search === "" && hashOk && isFilesMediaTokenPath(url.pathname);
}

/** A sub-frame may show the engine's map page, or (for a PDF) a media URL of the connected engine. */
export function isAllowedSubframeUrl(raw: string, engineOrigin: string | null = null): boolean {
  const url = parse(raw);
  if (!url || !FRAME_PROTOCOLS.has(url.protocol)) return false;
  return isMapTokenPath(url.pathname) || isEngineMediaUrl(raw, engineOrigin, true);
}

export interface WindowRequest {
  url: string;
  /** Electron's `resourceType` of the request ("image", "media", "subFrame", "script", …). */
  resourceType: string;
  /**
   * The app's own page asked: the request comes from the window's top document, or is the navigation of one of
   * its direct sub-frames. False for what a sub-frame loads for itself (the map page, the PDF viewer).
   */
  fromAppPage: boolean;
}

export interface WindowRequestPolicy {
  engineOrigin: string | null;
  /** Development only: the renderer's dev server, which serves the page itself. */
  devOrigin?: string | undefined;
}

const MEDIA_ELEMENT_TYPES = new Set(["image", "media"]);

/**
 * Whether a network request of the app window goes out. Only http(s) is judged here (file:, data:, blob:, ws: and
 * the browser's own schemes are the CSP's business), and only what the app's page itself asks for: a sub-frame's own
 * loads are bounded by the policy the engine sends with that document.
 */
export function isAllowedWindowRequest(req: WindowRequest, policy: WindowRequestPolicy): boolean {
  const url = parse(req.url);
  if (!url) return false;
  if (!FRAME_PROTOCOLS.has(url.protocol)) return true;
  if (policy.devOrigin !== undefined && url.origin === policy.devOrigin) return true;
  if (!req.fromAppPage) return true;
  // The top document's own navigation is will-navigate's to refuse.
  if (req.resourceType === "mainFrame") return true;
  if (req.resourceType === "subFrame") return isAllowedSubframeUrl(req.url, policy.engineOrigin);
  if (MEDIA_ELEMENT_TYPES.has(req.resourceType)) return isEngineMediaUrl(req.url, policy.engineOrigin);
  return false;
}
