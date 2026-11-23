import { describe, expect, it } from "vitest";
import { FILES_MEDIA_PDF_FRAGMENT } from "@kokpit/shared";
import { engineHttpOrigin, isAllowedSubframeUrl, isAllowedWindowRequest, isEngineMediaUrl } from "./frame-guard.ts";

const TOKEN = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const ENGINE = "http://127.0.0.1:7420";
const MEDIA = `${ENGINE}/files/media/${TOKEN}`;
const MAP = `${ENGINE}/map/abcdefghijklmnopqrstuvwxyz012345`;

describe("engineHttpOrigin", () => {
  it.each([
    ["ws://127.0.0.1:7420", "http://127.0.0.1:7420"],
    ["ws://127.0.0.1:7420/", "http://127.0.0.1:7420"],
    ["wss://mini.tail.ts.net", "https://mini.tail.ts.net"],
    ["ws://[fd7a::1]:7420", "http://[fd7a::1]:7420"],
    ["ws://100.64.1.2:7420/x?y", "http://100.64.1.2:7420"],
  ])("%s → %s", (ws, http) => {
    expect(engineHttpOrigin(ws)).toBe(http);
  });
  it.each([undefined, null, "", "http://127.0.0.1:7420", "ws://", "not a url", "file:///x"])("%s → null", (v) => {
    expect(engineHttpOrigin(v)).toBeNull();
  });
});

describe("isAllowedSubframeUrl", () => {
  it.each([
    "http://127.0.0.1:7420/map/abcdefghijklmnopqrstuvwxyz012345",
    "https://100.64.1.2:7420/map/abcdefghijklmnopqrstuvwxyz012345",
    "http://[::1]:7420/map/abcdefghijklmnopqrstuvwxyz012345",
  ])("allows the engine's map page %s", (url) => {
    expect(isAllowedSubframeUrl(url)).toBe(true);
  });

  it.each([
    "https://example.com/",
    "http://127.0.0.1:7420/health",
    "http://127.0.0.1:7420/map/",
    "http://127.0.0.1:7420/map/../secret",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,<p>x</p>",
    "about:blank#x",
    "not a url",
    "",
  ])("blocks %s", (url) => {
    expect(isAllowedSubframeUrl(url)).toBe(false);
    expect(isAllowedSubframeUrl(url, ENGINE)).toBe(false);
  });

  it("allows a media URL (the PDF frame) of the connected engine only", () => {
    expect(isAllowedSubframeUrl(MEDIA, ENGINE)).toBe(true);
    expect(isAllowedSubframeUrl(MEDIA)).toBe(false);
    expect(isAllowedSubframeUrl(MEDIA, "http://127.0.0.1:7421")).toBe(false);
    expect(isAllowedSubframeUrl(`http://evil.example/files/media/${TOKEN}`, ENGINE)).toBe(false);
  });

  it("the PDF frame may carry the fragment that hides the viewer's toolbar, and no other", () => {
    expect(isAllowedSubframeUrl(`${MEDIA}${FILES_MEDIA_PDF_FRAGMENT}`, ENGINE)).toBe(true);
    expect(isAllowedSubframeUrl(`${MEDIA}#toolbar=1`, ENGINE)).toBe(false);
    expect(isAllowedSubframeUrl(`${MEDIA}${FILES_MEDIA_PDF_FRAGMENT}&x=1`, ENGINE)).toBe(false);
    expect(isAllowedSubframeUrl(`http://evil.example/files/media/${TOKEN}${FILES_MEDIA_PDF_FRAGMENT}`, ENGINE)).toBe(false);
    // Media elements never need it.
    expect(isEngineMediaUrl(`${MEDIA}${FILES_MEDIA_PDF_FRAGMENT}`, ENGINE)).toBe(false);
    expect(isAllowedWindowRequest({ url: `${MEDIA}${FILES_MEDIA_PDF_FRAGMENT}`, resourceType: "media", fromAppPage: true }, { engineOrigin: ENGINE })).toBe(false);
    expect(isAllowedWindowRequest({ url: `${MEDIA}${FILES_MEDIA_PDF_FRAGMENT}`, resourceType: "subFrame", fromAppPage: true }, { engineOrigin: ENGINE })).toBe(true);
  });
});

describe("isEngineMediaUrl", () => {
  it("is the engine's origin plus a token path and nothing else", () => {
    expect(isEngineMediaUrl(MEDIA, ENGINE)).toBe(true);
    expect(isEngineMediaUrl(`https://mini.tail.ts.net/files/media/${TOKEN}`, "https://mini.tail.ts.net")).toBe(true);
  });
  it.each([
    ["no engine known", MEDIA, null],
    ["another host", `http://evil.example/files/media/${TOKEN}`, ENGINE],
    ["another port", `http://127.0.0.1:9999/files/media/${TOKEN}`, ENGINE],
    ["another scheme", `https://127.0.0.1:7420/files/media/${TOKEN}`, ENGINE],
    ["a host that only starts like the engine's", `http://127.0.0.1:7420.evil.example/files/media/${TOKEN}`, ENGINE],
    ["credentials in the URL", `http://a:b@127.0.0.1:7420/files/media/${TOKEN}`, ENGINE],
    ["a query", `${MEDIA}?x=1`, ENGINE],
    ["a fragment", `${MEDIA}#x`, ENGINE],
    ["a sub-path", `${MEDIA}/x`, ENGINE],
    ["a short token", `${ENGINE}/files/media/abc`, ENGINE],
    ["traversal", `${ENGINE}/files/media/../../health`, ENGINE],
    ["the map path", MAP, ENGINE],
    ["any other engine path", `${ENGINE}/health`, ENGINE],
    ["a file URL", "file:///files/media/" + TOKEN, ENGINE],
    ["garbage", "::", ENGINE],
  ])("refuses %s", (_n, url, origin) => {
    expect(isEngineMediaUrl(url, origin)).toBe(false);
  });
});

describe("isAllowedWindowRequest", () => {
  const policy = { engineOrigin: ENGINE };
  const app = (url: string, resourceType: string) => isAllowedWindowRequest({ url, resourceType, fromAppPage: true }, policy);

  it("lets <video>, <audio> and <img> load a media URL of the engine", () => {
    expect(app(MEDIA, "media")).toBe(true);
    expect(app(MEDIA, "image")).toBe(true);
  });

  it("lets a sub-frame show a media URL (PDF) or the map page", () => {
    expect(app(MEDIA, "subFrame")).toBe(true);
    expect(app(MAP, "subFrame")).toBe(true);
  });

  it.each(["script", "stylesheet", "xhr", "font", "object", "ping", "cspReport", "webSocket", "other", "", "worker"])(
    "a media URL is never loaded as %s",
    (resourceType) => {
      expect(app(MEDIA, resourceType)).toBe(false);
    },
  );

  it.each([
    ["an image from elsewhere", "https://example.com/a.png", "image"],
    ["media from elsewhere", "https://example.com/a.mp4", "media"],
    ["the map page as an image", MAP, "image"],
    ["another engine path as media", `${ENGINE}/health`, "media"],
    ["a frame from elsewhere", "https://example.com/", "subFrame"],
    ["a script from the engine", `${ENGINE}/x.js`, "script"],
    ["a media URL of another engine", `http://100.64.1.9:7420/files/media/${TOKEN}`, "media"],
    ["an unparseable URL", "http://", "image"],
  ])("refuses %s", (_n, url, resourceType) => {
    expect(app(url, resourceType)).toBe(false);
  });

  it("without a connected engine nothing is loaded from http(s)", () => {
    expect(isAllowedWindowRequest({ url: MEDIA, resourceType: "media", fromAppPage: true }, { engineOrigin: null })).toBe(false);
    expect(isAllowedWindowRequest({ url: MEDIA, resourceType: "subFrame", fromAppPage: true }, { engineOrigin: null })).toBe(false);
  });

  it("leaves non-network schemes, the top navigation and a sub-frame's own loads to their own guards", () => {
    for (const url of ["file:///app/index.html", "data:image/png;base64,AA", "blob:file:///x", "ws://127.0.0.1:7420/", "devtools://devtools/x", "chrome-extension://abc/index.html"]) {
      expect(app(url, "other"), url).toBe(true);
    }
    expect(app("https://example.com/", "mainFrame")).toBe(true);
    expect(isAllowedWindowRequest({ url: "https://unpkg.com/vis-network", resourceType: "script", fromAppPage: false }, policy)).toBe(true);
  });

  it("the dev server's origin is the page itself", () => {
    const dev = { engineOrigin: ENGINE, devOrigin: "http://localhost:5173" };
    expect(isAllowedWindowRequest({ url: "http://localhost:5173/src/main.tsx", resourceType: "script", fromAppPage: true }, dev)).toBe(true);
    expect(isAllowedWindowRequest({ url: "http://localhost:5174/src/main.tsx", resourceType: "script", fromAppPage: true }, dev)).toBe(false);
  });
});
