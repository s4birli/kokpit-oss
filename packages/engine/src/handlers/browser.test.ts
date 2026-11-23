// İş B: browser requests and frames through the real server, with a fake BrowserManager.
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { authenticate } from "../ws-auth-client.ts";
import type { BrowserExtension, BrowserFrameMessage, BrowserInputEvent, BrowserState, ServerMessage } from "@kokpit/shared";
import type { BrowserManager, ScreencastOptions } from "../browser.ts";
import { EngineError } from "../contracts.ts";
import { createEngineServer } from "../server.ts";
import {
  BUILTIN_PROJECT_ID,
  FakeCards,
  FakeLaunch,
  FakeLogger,
  FakeProjects,
  FakePtys,
  FakeSettings,
  FakeSshHosts,
  FakeStore,
  FakeTools,
  TEST_KEY,
  makeConfig,
} from "../../test/fakes/server-fakes.ts";

const WAIT_MS = 2000;

class FakeBrowsers implements BrowserManager {
  calls: unknown[][] = [];
  running = new Set<string>();
  subs = new Map<object, { projectId: string; send: (m: BrowserFrameMessage) => void; opts: ScreencastOptions }>();
  acks: [string, number][] = [];
  inputs: [string, BrowserInputEvent][] = [];
  private listeners = new Set<(projectId: string) => void>();

  st(projectId: string): BrowserState {
    return this.running.has(projectId)
      ? { running: true, tabs: [{ id: "T1", title: "Boş", url: "about:blank" }], activeTabId: "T1" }
      : { running: false, tabs: [] };
  }
  need(projectId: string): void {
    if (!this.running.has(projectId)) throw new EngineError("NOT_FOUND", "Tarayıcı açık değil");
  }
  async open(projectId: string) {
    this.calls.push(["open", projectId]);
    this.running.add(projectId);
    this.changed(projectId);
    return this.st(projectId);
  }
  async close(projectId: string) {
    this.calls.push(["close", projectId]);
    this.running.delete(projectId);
  }
  async state(projectId: string) {
    return this.st(projectId);
  }
  async navigate(projectId: string, url: string) {
    this.need(projectId);
    this.calls.push(["navigate", projectId, url]);
    return this.st(projectId);
  }
  async back(projectId: string) {
    this.need(projectId);
    this.calls.push(["back", projectId]);
    return this.st(projectId);
  }
  async forward(projectId: string) {
    this.calls.push(["forward", projectId]);
    return this.st(projectId);
  }
  async reload(projectId: string, ignoreCache = false) {
    this.calls.push(["reload", projectId, ignoreCache]);
    return this.st(projectId);
  }
  async selectTab(projectId: string, tabId: string) {
    this.calls.push(["selectTab", projectId, tabId]);
    return this.st(projectId);
  }
  async newTab(projectId: string, url?: string) {
    this.calls.push(["newTab", projectId, url]);
    return this.st(projectId);
  }
  async openUrl(projectId: string, url: string) {
    this.calls.push(["openUrl", projectId, url]);
    this.running.add(projectId);
    return this.st(projectId);
  }
  async closeTab(projectId: string, tabId: string) {
    this.need(projectId);
    this.calls.push(["closeTab", projectId, tabId]);
    return this.st(projectId);
  }
  async subscribe(projectId: string, key: object, opts: ScreencastOptions, send: (m: BrowserFrameMessage) => void) {
    this.need(projectId);
    this.subs.set(key, { projectId, send, opts });
  }
  unsubscribe(_projectId: string, key: object) {
    this.subs.delete(key);
  }
  unsubscribeAll(key: object) {
    this.calls.push(["unsubscribeAll"]);
    this.subs.delete(key);
  }
  ack(projectId: string, _key: object, frameId: number) {
    this.acks.push([projectId, frameId]);
  }
  async input(projectId: string, event: BrowserInputEvent) {
    this.need(projectId);
    this.inputs.push([projectId, event]);
  }
  selection = "";
  pasted: [string, string][] = [];
  async copySelection(projectId: string, opts: { cut: boolean }) {
    this.need(projectId);
    this.calls.push(["copySelection", projectId, opts.cut]);
    return this.selection;
  }
  async pasteText(projectId: string, text: string) {
    this.need(projectId);
    this.pasted.push([projectId, text]);
  }
  async contextAt(projectId: string, at: { x: number; y: number }) {
    this.need(projectId);
    this.calls.push(["contextAt", projectId, at.x, at.y]);
    return { hasSelection: this.selection !== "", editable: false, linkUrl: "https://example.com/" };
  }
  /** Girişler (logins.fill) — not exercised by the browser handlers. */
  async callIsolated(projectId: string) {
    this.need(projectId);
    return undefined;
  }
  isRunning() {
    return true;
  }
  cdpUrlFor(projectId: string) {
    return `http://127.0.0.1:1/${projectId}`;
  }
  onChange(cb: (projectId: string) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  changed(projectId: string) {
    for (const l of this.listeners) l(projectId);
  }
  exts = new Map<string, BrowserExtension[]>();
  async extensions(projectId: string) {
    this.calls.push(["extensions", projectId]);
    return this.exts.get(projectId) ?? [];
  }
  async loadExtension(projectId: string, dir: string) {
    this.calls.push(["loadExtension", projectId, dir]);
    this.running.add(projectId);
    const list = [...(this.exts.get(projectId) ?? []), { path: dir, id: "e1", name: "Uzantı", loaded: true }];
    this.exts.set(projectId, list);
    return list;
  }
  async removeExtension(projectId: string, dir: string) {
    this.calls.push(["removeExtension", projectId, dir]);
    const list = (this.exts.get(projectId) ?? []).filter((e) => e.path !== dir);
    this.exts.set(projectId, list);
    return list;
  }
  async showWindow(projectId: string) {
    this.need(projectId);
    this.calls.push(["showWindow", projectId]);
  }
  async applyWindow(projectId: string) {
    this.calls.push(["applyWindow", projectId]);
  }
  zoom = 0.67;
  zoomOf() {
    return this.zoom;
  }
  async setZoom(projectId: string, zoom: number | null, mode?: string) {
    this.calls.push(["setZoom", projectId, zoom, mode]);
    if (mode === "user") this.zoom = zoom ?? 0.67;
    return { zoom: this.zoom, applied: mode === "user" };
  }
  /** The connection whose size reports count (the real rule lives in the manager; here: whoever claimed last). */
  owner: object | undefined;
  async setViewport(projectId: string, view: { width: number; height: number }, by: { key: object; interaction: boolean }) {
    this.calls.push(["setViewport", projectId, view, by.interaction]);
    if (!by.interaction && this.owner !== undefined && this.owner !== by.key) return false;
    this.owner = by.key;
    return true;
  }
  isViewportOwner(_projectId: string, key: object) {
    return this.owner === key;
  }
  async pin(): Promise<never> {
    throw new Error("not used");
  }
  pinned() {
    return undefined;
  }
  async unpin() {}
  async closeOtherTabs() {}
  onPopup() {
    return () => {};
  }
  async pages() {
    return [];
  }
  async shutdown() {}
  pushFrame(frameId: number) {
    for (const s of this.subs.values()) {
      s.send({
        type: "browser.frame",
        projectId: s.projectId,
        frameId,
        data: "/9j/AAAA",
        metadata: { deviceWidth: 800, deviceHeight: 600, pageScaleFactor: 1, offsetTop: 0, scrollOffsetX: 0, scrollOffsetY: 0 },
      });
    }
  }
}

const servers: ReturnType<typeof createEngineServer>[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  for (const s of servers.splice(0)) await s.stop();
});

async function setup(withBrowsers = true) {
  const projects = new FakeProjects();
  projects.items.set("pc", { id: "pc", name: "İstemci", location: { kind: "local", path: "/x" }, browser: { runOn: "client" } });
  projects.items.set("pssh", { id: "pssh", name: "Uzak", location: { kind: "ssh", hostId: "oracle" } });
  const tools = new FakeTools();
  tools.items.set("tb", { id: "tb", name: "Claude + browser", command: "claude", opensBrowser: true });
  const store = new FakeStore();
  const browsers = new FakeBrowsers();
  const logger = new FakeLogger();
  const server = createEngineServer({
    config: makeConfig(),
    store,
    projects,
    sshHosts: new FakeSshHosts(),
    tools,
    settings: new FakeSettings(tools),
    cards: new FakeCards(store),
    ptys: new FakePtys(),
    logger,
    version: "t",
    resolveLaunch: new FakeLaunch().resolve,
    builtinProjectId: BUILTIN_PROJECT_ID,
    browserStartCommands: ["claude"],
    ...(withBrowsers ? { browsers } : {}),
  });
  servers.push(server);
  await server.start();
  return { browsers, logger, port: server.addresses()[0]!.port };
}

async function client(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(ws);
  const got: ServerMessage[] = [];
  ws.on("message", (d) => got.push(JSON.parse(d.toString()) as ServerMessage));
  await new Promise((r) => ws.once("open", r));
  const authed = authenticate(ws, TEST_KEY);
  let id = 0;
  const wait = async (pred: (m: ServerMessage) => boolean) => {
    const start = Date.now();
    for (;;) {
      const hit = got.find(pred);
      if (hit) return hit;
      if (Date.now() - start > WAIT_MS) throw new Error("timeout");
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  await authed;
  const req = async (method: string, params: Record<string, unknown>) => {
    const myId = ++id;
    ws.send(JSON.stringify({ type: "req", id: myId, method, params }));
    return (await wait((m) => m.type === "res" && m.id === myId)) as Extract<ServerMessage, { type: "res" }>;
  };
  return { ws, got, req, wait, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

describe("browser handlers", () => {
  it("open/tabs/navigate/back/forward/reload/selectTab/newTab/close reach the manager", async () => {
    const { browsers, port } = await setup();
    const c = await client(port);
    expect((await c.req("browser.tabs", { projectId: "p1" })).ok).toBe(true);
    const opened = await c.req("browser.open", { projectId: "p1" });
    expect(opened).toMatchObject({ ok: true, result: { browser: { running: true, activeTabId: "T1" } } });
    for (const [m, extra] of [
      ["browser.navigate", { url: "https://example.com/" }],
      ["browser.back", {}],
      ["browser.forward", {}],
      ["browser.reload", {}],
      ["browser.selectTab", { tabId: "T1" }],
      ["browser.newTab", {}],
      ["browser.closeTab", { tabId: "T1" }],
      ["browser.close", {}],
    ] as const) {
      expect((await c.req(m, { projectId: "p1", ...extra })).ok, m).toBe(true);
    }
    expect(browsers.calls.map((x) => x[0])).toEqual(["open", "navigate", "back", "forward", "reload", "selectTab", "newTab", "closeTab", "close"]);
    expect(browsers.calls[1]).toEqual(["navigate", "p1", "https://example.com/"]);
    expect(browsers.calls[7]).toEqual(["closeTab", "p1", "T1"]);
    await c.req("browser.open", { projectId: "p1" });
    expect((await c.req("browser.reload", { projectId: "p1", ignoreCache: true })).ok).toBe(true);
    expect(browsers.calls.at(-1)).toEqual(["reload", "p1", true]);
  });

  it("closeTab: bad tab id → INVALID; client-side project → INVALID; not running → NOT_FOUND", async () => {
    const { browsers, port } = await setup();
    const c = await client(port);
    for (const tabId of ["", "x".repeat(10_000), 42, null]) {
      expect(await c.req("browser.closeTab", { projectId: "p1", tabId }), String(tabId)).toMatchObject({ ok: false, error: { code: "INVALID" } });
    }
    expect(await c.req("browser.closeTab", { projectId: "p1" })).toMatchObject({ ok: false, error: { code: "INVALID" } });
    expect(await c.req("browser.closeTab", { projectId: "pc", tabId: "T1" })).toMatchObject({ ok: false, error: { code: "INVALID" } });
    expect(await c.req("browser.closeTab", { projectId: "p1", tabId: "T1" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(browsers.calls).toEqual([]);
  });

  it("unknown project → NOT_FOUND; client-side project → INVALID with a Turkish reason", async () => {
    const { browsers, port } = await setup();
    const c = await client(port);
    expect(await c.req("browser.open", { projectId: "nope" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    const r = await c.req("browser.open", { projectId: "pc" });
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID" } });
    expect(!r.ok && r.error.message).toMatch(/bu bilgisayarda|uygulamanın/);
    expect(browsers.calls).toEqual([]);
  });


  it("Kopyalama: copy / paste / context reach the manager; nothing about the text is logged", async () => {
    const { browsers, port, logger } = await setup();
    const c = await client(port);
    await c.req("browser.open", { projectId: "p1" });
    browsers.selection = "gizli-seçim-Zx9!";
    expect(await c.req("browser.copy", { projectId: "p1" })).toMatchObject({ ok: true, result: { text: "gizli-seçim-Zx9!" } });
    expect(await c.req("browser.copy", { projectId: "p1", cut: true })).toMatchObject({ ok: true, result: { text: "gizli-seçim-Zx9!" } });
    expect(browsers.calls.slice(-2)).toEqual([
      ["copySelection", "p1", false],
      ["copySelection", "p1", true],
    ]);
    expect(await c.req("browser.paste", { projectId: "p1", text: "gizli-pano-Qw7#\nçğ" })).toMatchObject({ ok: true, result: {} });
    expect(browsers.pasted).toEqual([["p1", "gizli-pano-Qw7#\nçğ"]]);
    expect(await c.req("browser.context", { projectId: "p1", x: 12.5, y: 30 })).toMatchObject({
      ok: true,
      result: { hasSelection: true, editable: false, linkUrl: "https://example.com/" },
    });
    expect(browsers.calls.at(-1)).toEqual(["contextAt", "p1", 12.5, 30]);
    expect(logger.dump()).not.toContain("gizli");
  });

  it("Kopyalama: client-side and unknown projects, a closed browser and bad params are refused before any text moves", async () => {
    const { browsers, port, logger } = await setup();
    const c = await client(port);
    for (const [projectId, code] of [
      ["pc", "INVALID"],
      ["yok", "NOT_FOUND"],
      ["p1", "NOT_FOUND"],
    ] as const) {
      expect(await c.req("browser.copy", { projectId }), projectId).toMatchObject({ ok: false, error: { code } });
      expect(await c.req("browser.paste", { projectId, text: "gizli-pano" }), projectId).toMatchObject({ ok: false, error: { code } });
      expect(await c.req("browser.context", { projectId, x: 1, y: 1 }), projectId).toMatchObject({ ok: false, error: { code } });
    }
    await c.req("browser.open", { projectId: "p1" });
    for (const [method, params] of [
      ["browser.paste", { text: "" }],
      ["browser.paste", { text: "gizli-pano".repeat(20_000) }],
      ["browser.paste", {}],
      ["browser.copy", { cut: "evet" }],
      ["browser.copy", { expression: "document.body.innerText" }],
      ["browser.context", { x: -5, y: 1 }],
      ["browser.context", { x: 1 }],
    ] as const) {
      const r = await c.req(method, { projectId: "p1", ...params });
      expect(r, method).toMatchObject({ ok: false, error: { code: "INVALID" } });
      expect(!r.ok && r.error.message).not.toContain("gizli");
    }
    expect(browsers.pasted).toEqual([]);
    expect(logger.dump()).not.toContain("gizli");
    expect((await c.req("browser.tabs", { projectId: "p1" })).ok).toBe(true);
  });

  it("bad params are answered INVALID (connection stays)", async () => {
    const { port } = await setup();
    const c = await client(port);
    expect(await c.req("browser.navigate", { projectId: "p1", url: "javascript:alert(1)" })).toMatchObject({
      ok: false,
      error: { code: "INVALID" },
    });
    expect((await c.req("browser.tabs", { projectId: "p1" })).ok).toBe(true);
  });

  it("not running → NOT_FOUND for navigation and screencast", async () => {
    const { port } = await setup();
    const c = await client(port);
    expect(await c.req("browser.navigate", { projectId: "p1", url: "https://a.b/" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(
      await c.req("browser.screencast.start", { projectId: "p1", maxWidth: 800, maxHeight: 600, quality: 60 }),
    ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("screencast frames go to the subscribed connection only; acks and input reach the manager", async () => {
    const { browsers, port } = await setup();
    const a = await client(port);
    const b = await client(port);
    await a.req("browser.open", { projectId: "p1" });
    expect((await a.req("browser.screencast.start", { projectId: "p1", maxWidth: 800, maxHeight: 600, quality: 60 })).ok).toBe(true);
    browsers.pushFrame(1);
    const f = await a.wait((m) => m.type === "browser.frame");
    expect(f).toMatchObject({ type: "browser.frame", projectId: "p1", frameId: 1 });
    await tick();
    expect(b.got.some((m) => m.type === "browser.frame")).toBe(false);

    a.send({ type: "browser.ack", projectId: "p1", frameId: 1 });
    a.send({ type: "browser.input", projectId: "p1", event: { type: "mouse", action: "down", x: 5, y: 6, button: "left", clickCount: 1 } });
    await tick();
    expect(browsers.acks).toEqual([["p1", 1]]);
    expect(browsers.inputs).toEqual([["p1", { type: "mouse", action: "down", x: 5, y: 6, button: "left", clickCount: 1 }]]);

    expect((await a.req("browser.screencast.stop", { projectId: "p1" })).ok).toBe(true);
    expect(browsers.subs.size).toBe(0);
  });

  it("input for a closed browser is dropped quietly; malformed input closes like any bad frame", async () => {
    const { port } = await setup();
    const c = await client(port);
    c.send({ type: "browser.input", projectId: "p1", event: { type: "text", text: "x" } });
    await tick();
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.send({ type: "browser.input", projectId: "p1", event: { type: "exec", cmd: "x" } });
    await new Promise((r) => c.ws.once("close", r));
  });

  it("a closed connection is unsubscribed everywhere", async () => {
    const { browsers, port } = await setup();
    const c = await client(port);
    await c.req("browser.open", { projectId: "p1" });
    await c.req("browser.screencast.start", { projectId: "p1", maxWidth: 800, maxHeight: 600, quality: 60 });
    expect(browsers.subs.size).toBe(1);
    c.ws.close();
    await tick(100);
    expect(browsers.subs.size).toBe(0);
  });

  it("manager changes are broadcast as browser.changed", async () => {
    const { browsers, port } = await setup();
    const a = await client(port);
    const b = await client(port);
    await a.req("browser.open", { projectId: "p2" });
    browsers.changed("p2");
    await b.wait((m) => m.type === "event" && m.name === "browser.changed" && m.projectId === "p2");
  });

  it("without a browser manager the requests answer INVALID instead of crashing", async () => {
    const { port } = await setup(false);
    const c = await client(port);
    expect(await c.req("browser.open", { projectId: "p1" })).toMatchObject({ ok: false, error: { code: "INVALID" } });
    expect((await c.req("browser.tabs", { projectId: "p1" })).ok).toBe(true);
  });

  it("extensions: list / loadUnpacked / remove reach the manager and answer the list", async () => {
    const { browsers, port } = await setup();
    const c = await client(port);
    expect(await c.req("browser.extensions.list", { projectId: "p1" })).toMatchObject({ ok: true, result: { extensions: [] } });
    const loaded = await c.req("browser.extensions.loadUnpacked", { projectId: "p1", path: "/ext/a" });
    expect(loaded).toMatchObject({ ok: true, result: { extensions: [{ path: "/ext/a", id: "e1", loaded: true }] } });
    const removed = await c.req("browser.extensions.remove", { projectId: "p1", path: "/ext/a" });
    expect(removed).toMatchObject({ ok: true, result: { extensions: [] } });
    expect(browsers.calls).toEqual([
      ["extensions", "p1"],
      ["loadExtension", "p1", "/ext/a"],
      ["removeExtension", "p1", "/ext/a"],
    ]);
  });

  it("monkey: extension paths that are relative, traverse, carry NUL or are huge are refused before the manager", async () => {
    const { browsers, port } = await setup();
    const c = await client(port);
    for (const path of ["ext/a", "", "/ext/../etc", "/ext/./a", "/a/..", "/a\u0000b", "/" + "x".repeat(5000), "~/ext", 5, null]) {
      const r = await c.req("browser.extensions.loadUnpacked", { projectId: "p1", path });
      expect(r, String(path)).toMatchObject({ ok: false, error: { code: "INVALID" } });
    }
    expect(browsers.calls).toEqual([]);
  });

  it("extensions and showWindow of a client-side project → INVALID; showWindow reaches the manager", async () => {
    const { browsers, port } = await setup();
    const c = await client(port);
    for (const [m, extra] of [
      ["browser.extensions.list", {}],
      ["browser.extensions.loadUnpacked", { path: "/ext/a" }],
      ["browser.extensions.remove", { path: "/ext/a" }],
      ["browser.showWindow", {}],
    ] as const) {
      expect(await c.req(m, { projectId: "pc", ...extra }), m).toMatchObject({ ok: false, error: { code: "INVALID" } });
    }
    expect(await c.req("browser.showWindow", { projectId: "p1" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    await c.req("browser.open", { projectId: "p1" });
    expect(await c.req("browser.showWindow", { projectId: "p1" })).toMatchObject({ ok: true });
    expect(browsers.calls.at(-1)).toEqual(["showWindow", "p1"]);
  });

  it("browser.viewport.set reaches the manager (also before the browser runs); a hidden (0x0) panel or a client-side browser → INVALID", async () => {
    const { browsers, port } = await setup();
    const c = await client(port);
    expect(await c.req("browser.viewport.set", { projectId: "p1", width: 667, height: 380 })).toMatchObject({ ok: true, result: { applied: true } });
    expect(browsers.calls.at(-1)).toEqual(["setViewport", "p1", { width: 667, height: 380 }, false]);
    expect(await c.req("browser.viewport.set", { projectId: "pc", width: 667, height: 380 })).toMatchObject({ ok: false, error: { code: "INVALID" } });
    for (const bad of [{ width: 0, height: 0 }, { width: 667, height: 0 }, { width: "667", height: 380 }, { width: 667 }]) {
      expect(await c.req("browser.viewport.set", { projectId: "p1", ...bad }), JSON.stringify(bad)).toMatchObject({ ok: false, error: { code: "INVALID" } });
    }
    expect(browsers.calls.filter((x) => x[0] === "setViewport")).toHaveLength(1);
  });

  it("two apps, one browser: a size report is the connection's — the answer says whether it was used, the state who drives", async () => {
    const { browsers, port } = await setup();
    const a = await client(port);
    const b = await client(port);
    await a.req("browser.open", { projectId: "p1" });
    const owner = async (c: typeof a) => {
      const r = await c.req("browser.tabs", { projectId: "p1" });
      return r.ok && (r.result as { browser: { viewportOwner?: boolean } }).browser.viewportOwner;
    };
    expect([await owner(a), await owner(b)]).toEqual([false, false]);
    expect(await a.req("browser.viewport.set", { projectId: "p1", width: 900, height: 600 })).toMatchObject({ ok: true, result: { applied: true } });
    // The other app's report without a claim is not used…
    expect(await b.req("browser.viewport.set", { projectId: "p1", width: 700, height: 420 })).toMatchObject({ ok: true, result: { applied: false } });
    expect([await owner(a), await owner(b)]).toEqual([true, false]);
    // …with the claim that its user just used the panel it is; `interaction` reaches the manager as a boolean.
    expect(await b.req("browser.viewport.set", { projectId: "p1", width: 700, height: 420, interaction: true })).toMatchObject({ ok: true, result: { applied: true } });
    expect(browsers.calls.at(-1)).toEqual(["setViewport", "p1", { width: 700, height: 420 }, true]);
    expect([await owner(a), await owner(b)]).toEqual([false, true]);
    // Every answer that carries the browser's state says it too.
    const nav = await b.req("browser.navigate", { projectId: "p1", url: "https://example.com/" });
    expect(nav).toMatchObject({ ok: true, result: { browser: { running: true, viewportOwner: true } } });
    expect(await b.req("browser.viewport.set", { projectId: "p1", width: 700, height: 420, interaction: "yes" })).toMatchObject({ ok: false, error: { code: "INVALID" } });
  });

  it("İş Z: browser.zoom.set reaches the manager (also before the browser runs); client-side/bad zoom → INVALID", async () => {
    const { browsers, port } = await setup();
    const c = await client(port);
    expect(await c.req("browser.zoom.set", { projectId: "p1", zoom: 0.8, mode: "user" })).toMatchObject({ ok: true, result: { zoom: 0.8, applied: true } });
    expect(browsers.calls.at(-1)).toEqual(["setZoom", "p1", 0.8, "user"]);
    // The engine's answer is the project's zoom, whoever asks and however (hand-over, an old app's copy, a reset).
    expect(await c.req("browser.zoom.set", { projectId: "p1", zoom: 1.25, mode: "adopt" })).toMatchObject({ ok: true, result: { zoom: 0.8, applied: false } });
    expect(browsers.calls.at(-1)).toEqual(["setZoom", "p1", 1.25, "adopt"]);
    expect(await c.req("browser.zoom.set", { projectId: "p1", zoom: 0.8 })).toMatchObject({ ok: true, result: { zoom: 0.8, applied: false } });
    expect(browsers.calls.at(-1)).toEqual(["setZoom", "p1", 0.8, undefined]);
    expect(await c.req("browser.zoom.set", { projectId: "p1", zoom: null, mode: "user" })).toMatchObject({ ok: true, result: { zoom: 0.67, applied: true } });
    expect(await c.req("browser.zoom.set", { projectId: "pc", zoom: 0.8, mode: "user" })).toMatchObject({ ok: false, error: { code: "INVALID" } });
    const calls = browsers.calls.filter((x) => x[0] === "setZoom").length;
    for (const bad of [{ zoom: 0 }, { zoom: -1 }, { zoom: 100 }, { zoom: "1" }, { zoom: null }, { zoom: null, mode: "adopt" }, { zoom: 1, mode: "engine" }, {}]) {
      expect(await c.req("browser.zoom.set", { projectId: "p1", ...bad }), JSON.stringify(bad)).toMatchObject({ ok: false, error: { code: "INVALID" } });
    }
    expect(browsers.calls.filter((x) => x[0] === "setZoom")).toHaveLength(calls);
  });

  it("terminal.open with a tool that opens the browser starts the project's engine browser (only there)", async () => {
    const { browsers, port } = await setup();
    const c = await client(port);
    expect((await c.req("terminal.open", { projectId: "p1", toolId: "tb", cols: 80, rows: 24 })).ok).toBe(true);
    await tick();
    expect(browsers.calls).toEqual([["open", "p1"]]);
    // Not for client-side browsers or ssh projects (their terminals get no KOKPIT_CDP_URL).
    expect((await c.req("terminal.open", { projectId: "pc", toolId: "tb", cols: 80, rows: 24 })).ok).toBe(true);
    expect((await c.req("terminal.open", { projectId: "pssh", toolId: "tb", cols: 80, rows: 24 })).ok).toBe(true);
    await tick();
    expect(browsers.calls).toEqual([["open", "p1"]]);
  });

  it("a terminal running claude (the plain tool or a typed command) starts the browser too; other programs do not", async () => {
    const { browsers, port } = await setup();
    const c = await client(port);
    expect((await c.req("terminal.open", { projectId: "p2", toolId: "claude", cols: 80, rows: 24 })).ok).toBe(true);
    expect((await c.req("terminal.open", { projectId: "p1", command: "claude --resume", cols: 80, rows: 24 })).ok).toBe(true);
    expect((await c.req("terminal.open", { projectId: "p1", command: "codex", cols: 80, rows: 24 })).ok).toBe(true);
    expect((await c.req("terminal.open", { projectId: "p1", toolId: null, cols: 80, rows: 24 })).ok).toBe(true);
    expect((await c.req("terminal.open", { projectId: "pc", command: "claude", cols: 80, rows: 24 })).ok).toBe(true);
    await tick();
    expect(browsers.calls).toEqual([
      ["open", "p2"],
      ["open", "p1"],
    ]);
  });

  it("terminal.open still opens the terminal when starting the browser fails", async () => {
    const { browsers, port } = await setup();
    browsers.open = async () => {
      throw new EngineError("INTERNAL", "Chrome başlatılamadı");
    };
    const c = await client(port);
    expect((await c.req("terminal.open", { projectId: "p1", toolId: "tb", cols: 80, rows: 24 })).ok).toBe(true);
  });

  it("without a browser manager terminal.open with a browser tool still works", async () => {
    const { port } = await setup(false);
    const c = await client(port);
    expect((await c.req("terminal.open", { projectId: "p1", toolId: "tb", cols: 80, rows: 24 })).ok).toBe(true);
  });
});

describe("Bağlantılar: browser.openUrl", () => {
  const URL_WITH_SECRET = "https://ornek.test:8443/gizli/yol?token=COK_GIZLI#parca";

  it("starts the project's browser if needed and hands the address to the manager", async () => {
    const { browsers, port } = await setup();
    const c = await client(port);
    const r = await c.req("browser.openUrl", { projectId: "p1", url: "http://localhost:3000/a?b=1" });
    expect(r).toMatchObject({ ok: true, result: { browser: { running: true, activeTabId: "T1", viewportOwner: false } } });
    expect(browsers.calls).toEqual([["openUrl", "p1", "http://localhost:3000/a?b=1"]]);
  });

  it("the address reaches the manager as the URL parser normalizes it", async () => {
    const { browsers, port } = await setup();
    const c = await client(port);
    expect((await c.req("browser.openUrl", { projectId: "p1", url: "HTTP://LocalHost:3000" })).ok).toBe(true);
    expect(browsers.calls).toEqual([["openUrl", "p1", "http://localhost:3000/"]]);
  });

  it("anything but a plain http(s) address is INVALID and never reaches the manager", async () => {
    const { browsers, port } = await setup();
    const c = await client(port);
    const refused: unknown[] = ["about:blank", "chrome://settings", "javascript:alert(1)", "file:///etc/passwd", "vscode://x", "", "x", 42, null, "https://u:p@ornek.test/", "https://ornek.test/ a", `https://ornek.test/${"a".repeat(9000)}`];
    for (const url of refused) {
      expect(await c.req("browser.openUrl", { projectId: "p1", url }), String(url).slice(0, 40)).toMatchObject({ ok: false, error: { code: "INVALID" } });
    }
    expect(await c.req("browser.openUrl", { projectId: "p1" })).toMatchObject({ ok: false, error: { code: "INVALID" } });
    expect(browsers.calls).toEqual([]);
  });

  it("a project whose browser runs on the app's machine and an unknown project are refused", async () => {
    const { browsers, port } = await setup();
    const c = await client(port);
    const url = "http://localhost:3000/";
    expect(await c.req("browser.openUrl", { projectId: "pc", url })).toMatchObject({ ok: false, error: { code: "INVALID" } });
    expect(await c.req("browser.openUrl", { projectId: "nope", url })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(browsers.calls).toEqual([]);
  });

  it("without a browser manager it is INVALID", async () => {
    const { port } = await setup(false);
    const c = await client(port);
    expect(await c.req("browser.openUrl", { projectId: "p1", url: "http://localhost:3000/" })).toMatchObject({ ok: false, error: { code: "INVALID" } });
  });

  it("the log names the project and the address's origin — never its path or query", async () => {
    const { logger, port } = await setup();
    const c = await client(port);
    expect((await c.req("browser.openUrl", { projectId: "p1", url: URL_WITH_SECRET })).ok).toBe(true);
    const entry = logger.entries.find((e) => e.msg === "browser link opened");
    expect(entry).toMatchObject({ level: "info", extra: { projectId: "p1", origin: "https://ornek.test:8443" } });
    expect(logger.dump()).not.toContain("COK_GIZLI");
    expect(logger.dump()).not.toContain("gizli/yol");
  });

  it("a failure is logged without the address too", async () => {
    const { browsers, logger, port } = await setup();
    browsers.openUrl = async () => {
      throw new EngineError("INTERNAL", "Chrome başlatılamadı");
    };
    const c = await client(port);
    expect(await c.req("browser.openUrl", { projectId: "p1", url: URL_WITH_SECRET })).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    expect(logger.dump()).not.toContain("COK_GIZLI");
  });
});
