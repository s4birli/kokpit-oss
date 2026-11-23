// İş B (Tarayıcı): protocol additions.
import { describe, expect, it } from "vitest";
import {
  BROWSER_LIMITS,
  BROWSER_WINDOW_MODES,
  browserWindowOf,
  BrowserInputEventSchema,
  BrowserUrlSchema,
  parseClientMessage,
  parseServerMessage,
  ProjectSchema,
} from "./protocol.ts";

const ok = (m: unknown) => parseClientMessage(JSON.stringify(m)).ok;
const req = (method: string, params: unknown) => ({ type: "req", id: 1, method, params });

describe("İş B: tarayıcı protokolü", () => {
  it("project carries an optional browser.runOn (engine | client)", () => {
    const base = { id: "p", name: "P", location: { kind: "local", path: "/x" } };
    expect(ProjectSchema.safeParse(base).success).toBe(true);
    expect(ProjectSchema.safeParse({ ...base, browser: { runOn: "engine" } }).success).toBe(true);
    expect(ProjectSchema.safeParse({ ...base, browser: { runOn: "client" } }).success).toBe(true);
    expect(ProjectSchema.safeParse({ ...base, browser: { runOn: "lan" } }).success).toBe(false);
    expect(ProjectSchema.safeParse({ ...base, browser: { runOn: "engine", port: 9222 } }).success).toBe(false);
  });

  it("browser.window: hidden | visible, optional (absent = hidden)", () => {
    const base = { id: "p", name: "P", location: { kind: "local", path: "/x" } };
    expect(ProjectSchema.safeParse({ ...base, browser: { runOn: "engine", window: "hidden" } }).success).toBe(true);
    expect(ProjectSchema.safeParse({ ...base, browser: { runOn: "engine", window: "visible" } }).success).toBe(true);
    expect(ProjectSchema.safeParse({ ...base, browser: { runOn: "engine", window: "minimized" } }).success).toBe(false);
    expect(ok(req("projects.update", { projectId: "p", browser: { runOn: "engine", window: "visible" } }))).toBe(true);
    expect(browserWindowOf({})).toBe("hidden");
    expect(browserWindowOf({ browser: { runOn: "engine" } })).toBe("hidden");
    expect(browserWindowOf({ browser: { runOn: "engine", window: "visible" } })).toBe("visible");
    expect(BROWSER_WINDOW_MODES).toEqual(["hidden", "visible"]);
  });

  it("projects.create / update accept browser.runOn", () => {
    const loc = { kind: "local", path: "/x" };
    expect(ok(req("projects.create", { name: "x", location: loc, browser: { runOn: "client" } }))).toBe(true);
    expect(ok(req("projects.update", { projectId: "p", browser: { runOn: "engine" } }))).toBe(true);
    expect(ok(req("projects.update", { projectId: "p", browser: { runOn: "remote" } }))).toBe(false);
  });

  it("accepts every browser request", () => {
    const p = { projectId: "p" };
    for (const m of ["browser.open", "browser.close", "browser.tabs", "browser.back", "browser.forward", "browser.reload", "browser.screencast.stop"]) {
      expect(ok(req(m, p)), m).toBe(true);
    }
    expect(ok(req("browser.navigate", { ...p, url: "https://example.com/a?b=1" }))).toBe(true);
    expect(ok(req("browser.selectTab", { ...p, tabId: "ABCDEF0123" }))).toBe(true);
    expect(ok(req("browser.newTab", p))).toBe(true);
    expect(ok(req("browser.newTab", { ...p, url: "about:blank" }))).toBe(true);
    expect(ok(req("browser.screencast.start", { ...p, maxWidth: 1280, maxHeight: 800, quality: 70 }))).toBe(true);
    for (const zoom of [BROWSER_LIMITS.minZoom, 0.67, 0.8, 1, 1.25, BROWSER_LIMITS.maxZoom]) {
      expect(ok(req("browser.zoom.set", { ...p, zoom })), String(zoom)).toBe(true);
    }
    for (const [width, height] of [
      [BROWSER_LIMITS.minViewportDim, BROWSER_LIMITS.minViewportDim],
      [667, 380],
      [BROWSER_LIMITS.maxViewportDim, BROWSER_LIMITS.maxViewportDim],
    ]) {
      expect(ok(req("browser.viewport.set", { ...p, width, height })), `${width}x${height}`).toBe(true);
    }
  });

  it("zoom is the engine's: a user step or reset, a one-time hand-over, or an old app's copy", () => {
    const p = { projectId: "p" };
    expect(ok(req("browser.zoom.set", { ...p, zoom: 1.25, mode: "user" }))).toBe(true);
    // null = back to the engine's default: only the user may ask for that.
    expect(ok(req("browser.zoom.set", { ...p, zoom: null, mode: "user" }))).toBe(true);
    expect(ok(req("browser.zoom.set", { ...p, zoom: 1.25, mode: "adopt" }))).toBe(true);
    expect(ok(req("browser.zoom.set", { ...p, zoom: null, mode: "adopt" }))).toBe(false);
    expect(ok(req("browser.zoom.set", { ...p, zoom: null }))).toBe(false);
    expect(ok(req("browser.zoom.set", { ...p, zoom: 1, mode: "engine" }))).toBe(false);
  });

  it("a viewport size may carry the claim that the user just used that panel", () => {
    const p = { projectId: "p", width: 667, height: 380 };
    expect(ok(req("browser.viewport.set", { ...p, interaction: true }))).toBe(true);
    expect(ok(req("browser.viewport.set", { ...p, interaction: false }))).toBe(true);
    expect(ok(req("browser.viewport.set", { ...p, interaction: "yes" }))).toBe(false);
  });

  it.each([
    ["no projectId", "browser.open", {}],
    ["extra key", "browser.open", { projectId: "p", port: 1 }],
    ["javascript url", "browser.navigate", { projectId: "p", url: "javascript:alert(1)" }],
    ["file url", "browser.navigate", { projectId: "p", url: "file:///etc/passwd" }],
    ["data url", "browser.navigate", { projectId: "p", url: "data:text/html,<b>x</b>" }],
    ["not a url", "browser.navigate", { projectId: "p", url: "example com" }],
    ["huge url", "browser.navigate", { projectId: "p", url: "https://e.com/" + "a".repeat(BROWSER_LIMITS.maxUrlLength) }],
    ["zero width", "browser.screencast.start", { projectId: "p", maxWidth: 0, maxHeight: 10, quality: 50 }],
    ["huge width", "browser.screencast.start", { projectId: "p", maxWidth: BROWSER_LIMITS.maxScreencastDim + 1, maxHeight: 10, quality: 50 }],
    ["zoom 0", "browser.zoom.set", { projectId: "p", zoom: 0 }],
    ["negative zoom", "browser.zoom.set", { projectId: "p", zoom: -1 }],
    ["zoom too small", "browser.zoom.set", { projectId: "p", zoom: BROWSER_LIMITS.minZoom / 2 }],
    ["zoom too big", "browser.zoom.set", { projectId: "p", zoom: BROWSER_LIMITS.maxZoom + 1 }],
    ["zoom string", "browser.zoom.set", { projectId: "p", zoom: "1" }],
    ["no zoom", "browser.zoom.set", { projectId: "p" }],
    ["viewport 0 wide (hidden panel)", "browser.viewport.set", { projectId: "p", width: 0, height: 300 }],
    ["viewport 0 high (hidden panel)", "browser.viewport.set", { projectId: "p", width: 300, height: 0 }],
    ["viewport too small", "browser.viewport.set", { projectId: "p", width: BROWSER_LIMITS.minViewportDim - 1, height: 300 }],
    ["viewport too big", "browser.viewport.set", { projectId: "p", width: BROWSER_LIMITS.maxViewportDim + 1, height: 300 }],
    ["viewport fractional", "browser.viewport.set", { projectId: "p", width: 300.5, height: 300 }],
    ["viewport without height", "browser.viewport.set", { projectId: "p", width: 300 }],
    ["viewport extra key", "browser.viewport.set", { projectId: "p", width: 300, height: 300, zoom: 1 }],
    ["quality > 100", "browser.screencast.start", { projectId: "p", maxWidth: 10, maxHeight: 10, quality: 101 }],
    ["fractional quality", "browser.screencast.start", { projectId: "p", maxWidth: 10, maxHeight: 10, quality: 5.5 }],
  ])("rejects %s", (_n, method, params) => {
    const r = parseClientMessage(JSON.stringify(req(method, params)));
    expect(r.ok).toBe(false);
    // Well-formed envelopes get an INVALID res instead of a closed connection.
    expect(!r.ok && r.badRequest?.method).toBe(method);
  });

  it("browser urls: http(s), about and chrome only", () => {
    for (const u of ["http://127.0.0.1:8080/", "https://a.b/c", "about:blank", "chrome://extensions"]) {
      expect(BrowserUrlSchema.safeParse(u).success, u).toBe(true);
    }
    for (const u of ["ftp://x/", "javascript:1", "file:///", "view-source:https://a", "", " "]) {
      expect(BrowserUrlSchema.safeParse(u).success, u).toBe(false);
    }
  });

  it("input events: mouse, wheel, key, text", () => {
    const valid = [
      { type: "mouse", action: "move", x: 10, y: 20 },
      { type: "mouse", action: "down", x: 10, y: 20, button: "left", clickCount: 1, modifiers: { shift: true } },
      { type: "mouse", action: "up", x: 0, y: 0, button: "right", clickCount: 1 },
      { type: "wheel", x: 1, y: 2, deltaX: 0, deltaY: -120 },
      { type: "key", action: "down", key: "a", code: "KeyA", keyCode: 65 },
      { type: "key", action: "up", key: "Enter", code: "Enter", keyCode: 13, modifiers: { meta: true, ctrl: false, alt: false } },
      { type: "key", action: "char", key: "ş", code: "" },
      { type: "text", text: "merhaba dünya" },
    ];
    for (const e of valid) expect(BrowserInputEventSchema.safeParse(e).success, JSON.stringify(e)).toBe(true);
    const invalid = [
      { type: "mouse", action: "move", x: -1, y: 0 },
      { type: "mouse", action: "move", x: Number.NaN, y: 0 },
      { type: "mouse", action: "drag", x: 1, y: 1 },
      { type: "mouse", action: "down", x: 1, y: 1, button: "fourth" },
      { type: "mouse", action: "down", x: 1, y: 1, clickCount: 99 },
      { type: "wheel", x: 1, y: 2, deltaX: 0, deltaY: BROWSER_LIMITS.maxWheelDelta + 1 },
      { type: "key", action: "down", key: "", code: "KeyA" },
      { type: "key", action: "down", key: "a".repeat(100), code: "KeyA" },
      { type: "key", action: "down", key: "a", code: "KeyA", modifiers: { hyper: true } },
      { type: "text", text: "" },
      { type: "text", text: "x".repeat(BROWSER_LIMITS.maxTextLength + 1) },
      { type: "exec", code: "rm -rf /" },
    ];
    for (const e of invalid) expect(BrowserInputEventSchema.safeParse(e).success, JSON.stringify(e)).toBe(false);
  });

  it("browser.input and browser.ack are fire-and-forget client frames", () => {
    expect(ok({ type: "browser.input", projectId: "p", event: { type: "text", text: "hi" } })).toBe(true);
    expect(ok({ type: "browser.ack", projectId: "p", frameId: 3 })).toBe(true);
    expect(ok({ type: "browser.ack", projectId: "p", frameId: -1 })).toBe(false);
    expect(ok({ type: "browser.input", projectId: "p", event: { type: "text", text: "" } })).toBe(false);
    expect(ok({ type: "browser.input", projectId: "p", event: { type: "text", text: "a" }, extra: 1 })).toBe(false);
  });

  it("server sends browser.frame and the browser.changed event", () => {
    const frame = {
      type: "browser.frame",
      projectId: "p",
      frameId: 1,
      data: "/9j/4AAQ",
      metadata: { deviceWidth: 800, deviceHeight: 600, pageScaleFactor: 1, offsetTop: 0, scrollOffsetX: 0, scrollOffsetY: 0 },
    };
    expect(parseServerMessage(JSON.stringify(frame)).ok).toBe(true);
    expect(parseServerMessage(JSON.stringify({ ...frame, data: "x".repeat(BROWSER_LIMITS.maxFrameChars + 1) })).ok).toBe(false);
    expect(parseServerMessage(JSON.stringify({ type: "event", name: "browser.changed", projectId: "p" })).ok).toBe(true);
  });

  it("frame limit leaves room for the JSON envelope", () => {
    expect(BROWSER_LIMITS.maxFrameChars).toBeLessThan(1024 * 1024 - 1024);
  });
});

describe("Bağlantılar: browser.openUrl (terminaldeki bağlantı projenin tarayıcısında açılır)", () => {
  const p = { projectId: "p" };

  it("accepts http and https addresses, local ones included", () => {
    for (const url of ["https://example.com/a?b=1#c", "http://localhost:3000", "http://127.0.0.1:5173/x", "http://192.168.1.20:8000/", "http://[::1]:8080/"]) {
      expect(ok(req("browser.openUrl", { ...p, url })), url).toBe(true);
    }
  });

  it("refuses everything that is not a plain http(s) address", () => {
    const refused = [
      "about:blank",
      "chrome://settings",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,x",
      "vscode://file/x",
      "example.com",
      "",
      "https://user:pw@example.com/",
      "https://exa mple.com/",
      "https://example.com/\n",
      `https://example.com/${"a".repeat(BROWSER_LIMITS.maxUrlLength)}`,
    ];
    for (const url of refused) expect(ok(req("browser.openUrl", { ...p, url })), url).toBe(false);
    expect(ok(req("browser.openUrl", p))).toBe(false);
    expect(ok(req("browser.openUrl", { url: "https://example.com/" }))).toBe(false);
    expect(ok(req("browser.openUrl", { ...p, url: "https://example.com/", extra: true }))).toBe(false);
    expect(ok(req("browser.openUrl", { ...p, url: 42 }))).toBe(false);
  });
});
