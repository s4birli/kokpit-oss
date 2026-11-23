import { isMapTokenPath } from "@kokpit/shared";

const HTTP_FOR_WS: Record<string, string> = { "ws:": "http:", "wss:": "https:" };

/**
 * The engine serves maps on the same listener as its WebSocket: ws://h:p → http://h:p, wss → https.
 * Only a well-formed `/map/<token>` path is accepted; anything else (absolute URLs, traversal) → null.
 */
export function mapFrameUrl(engineUrl: string | undefined, path: string): string | null {
  return isMapTokenPath(path) ? engineHttpUrl(engineUrl, path) : null;
}

/** `path` on the engine's HTTP listener. The caller has checked `path` (it is appended as is). */
export function engineHttpUrl(engineUrl: string | undefined, path: string): string | null {
  if (!engineUrl || !path.startsWith("/") || path.startsWith("//")) return null;
  let url: URL;
  try {
    url = new URL(engineUrl);
  } catch {
    return null;
  }
  const protocol = HTTP_FOR_WS[url.protocol];
  if (!protocol || !url.host) return null;
  return `${protocol}//${url.host}${path}`;
}
