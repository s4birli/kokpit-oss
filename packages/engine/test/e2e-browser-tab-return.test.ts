// Coming back to a browser tab: the picture must have the page's shape again by itself. Real engine + REAL headless
// Chrome (temp profile, mock keychain). A tab that was in the background while another one was shown is given the
// panel's viewport again when it is activated; whatever Chrome does to its view while bringing it to the front, a
// frame of the page's size (panel ÷ zoom) must reach the viewer WITHOUT any further input, size report or change of
// the (static) page — and it must be the last word: no window-shaped frame after it.
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserFrameMessage, BrowserState } from "@kokpit/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, startEngine, stopEngine, type EngineProc } from "./harness.ts";

const KEY = randomBytes(32).toString("base64url");
const WAIT_MS = 10_000;
const defaults = JSON.parse(readFileSync(new URL("../config.defaults.json", import.meta.url), "utf8")) as {
  browser: { chromePath: string; viewportHealIntervalMs: number; viewportHealMaxTries: number };
};
const haveChrome = existsSync(defaults.browser.chromePath);
/** The app's panel (CSS px) and the user's zoom: the page must be 515×304. */
const PANEL = { width: 644, height: 380 };
const ZOOM = 1.25;
const PAGE = { width: Math.round(PANEL.width / ZOOM), height: Math.round(PANEL.height / ZOOM) };
/** Round trips to another tab and back. */
const ROUNDS = 12;
/** After the right frame arrived: long enough for every self-heal try to have run. */
const SETTLE_MS = (defaults.browser.viewportHealMaxTries + 1) * defaults.browser.viewportHealIntervalMs;

let root: string;
let engine: EngineProc | undefined;
let site: http.Server;
let siteUrl: string;
let c: Client;
let projectId: string;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ourChromePids(): number[] {
  const out = execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" });
  return out
    .split("\n")
    .filter((l) => l.includes(root) && l.includes("--user-data-dir="))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => Number.isInteger(n) && n > 0);
}

const frames = () => c.frames.filter((f): f is BrowserFrameMessage => f.type === "browser.frame" && f.projectId === projectId);
const shape = (f: BrowserFrameMessage | undefined) => (f ? `${f.metadata.deviceWidth}x${f.metadata.deviceHeight}` : "none");
const WANT = `${PAGE.width}x${PAGE.height}`;
/** Acks like the app: the newest frame, as soon as it is drawn. */
function ack(): void {
  const last = frames().at(-1);
  if (last) c.ws.send(JSON.stringify({ type: "browser.ack", projectId, frameId: last.frameId }));
}
const tabs = async () => (await c.req<{ browser: BrowserState }>("browser.tabs", { projectId })).browser;

/** Waits (acking) until a frame newer than `afterId` has the page's size; says what came instead. */
async function pageShapedFrame(afterId: number, what: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    ack();
    const fresh = frames().filter((f) => f.frameId > afterId);
    if (fresh.some((f) => shape(f) === WANT)) return;
    if (Date.now() - start > WAIT_MS) {
      throw new Error(`${what}: no ${WANT} frame within ${WAIT_MS} ms; frames since: [${fresh.map(shape).join(", ")}]`);
    }
    await sleep(50);
  }
}

beforeAll(async () => {
  if (!haveChrome) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-e2e-tab-return-")));
  mkdirSync(join(root, "p"));
  const configPath = join(root, "engine.json");
  const cdpPortBase = 48000 + Math.floor(Math.random() * 20) * 100;
  writeFileSync(
    configPath,
    JSON.stringify({
      dataDir: join(root, "data"),
      port: 0,
      shell: "/bin/sh",
      shellArgs: [],
      listenTailscale: false,
      flushIntervalMs: 100,
      killGraceMs: 200,
      browser: { headless: true, testMode: true, startTimeoutMs: 30000, cdpPortBase, cdpPortSpan: 100 },
    }),
  );
  // A static page: nothing repaints by itself, so no frame comes unless the engine makes one come.
  site = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><title>sayfa</title><body style="margin:0;background:#fde68a"><h1>Kokpit</h1></body>`);
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", () => r()));
  siteUrl = `http://127.0.0.1:${(site.address() as net.AddressInfo).port}`;
  engine = await startEngine({ KOKPIT_CONFIG: configPath, KOKPIT_KEY: KEY });
  c = await Client.connect(engine.port, KEY);
  await c.req("settings.update", { defaultToolId: null });
  projectId = (await c.req<{ project: { id: string } }>("projects.create", { name: "Sekmeye dönüş", location: { kind: "local", path: join(root, "p") } })).project.id;
}, 60_000);

afterAll(async () => {
  if (!haveChrome) return;
  await c?.close();
  await stopEngine(engine);
  for (const pid of ourChromePids()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  await new Promise<void>((r) => site?.close(() => r()));
  rmSync(root, { recursive: true, force: true });
}, 60_000);

describe.skipIf(!haveChrome)("Tarayıcı sekmesine dönüş: resim kendiliğinden sayfanın biçimine gelir", { timeout: 240_000 }, () => {
  it(`a new tab and back, ${ROUNDS} times: each time a page-shaped frame arrives by itself and stays the last word`, async () => {
    await c.req("browser.zoom.set", { projectId, zoom: ZOOM, mode: "user" });
    await c.req("browser.viewport.set", { projectId, ...PANEL, interaction: true });
    await c.req("browser.open", { projectId });
    await c.req("browser.navigate", { projectId, url: `${siteUrl}/` });
    await c.req("browser.screencast.start", { projectId, maxWidth: PANEL.width * 2, maxHeight: PANEL.height * 2, quality: 70 });
    await pageShapedFrame(0, "first tab");
    const first = (await tabs()).activeTabId!;
    const bad: string[] = [];
    for (let round = 1; round <= ROUNDS; round++) {
      // The app: "+" in the tab strip, then a click on the first tab — nothing else.
      let mark = frames().at(-1)?.frameId ?? 0;
      const opened = (await c.req<{ browser: BrowserState }>("browser.newTab", { projectId })).browser;
      await pageShapedFrame(mark, `round ${round}: new tab`).catch((err: Error) => bad.push(err.message));
      mark = frames().at(-1)?.frameId ?? 0;
      await c.req("browser.selectTab", { projectId, tabId: first });
      await pageShapedFrame(mark, `round ${round}: back on the first tab`).catch((err: Error) => bad.push(err.message));
      // Nothing may undo it afterwards.
      const until = Date.now() + SETTLE_MS;
      while (Date.now() < until) {
        ack();
        await sleep(50);
      }
      if (shape(frames().at(-1)) !== WANT) bad.push(`round ${round}: the last frame is ${shape(frames().at(-1))}, not ${WANT}`);
      // And the viewer was never shown the page in another shape on the way (no window-shaped first frame).
      const odd = frames().filter((f) => f.frameId > mark && shape(f) !== WANT);
      if (odd.length > 0) bad.push(`round ${round}: frames of another shape after the switch: [${odd.map(shape).join(", ")}]`);
      await c.req("browser.closeTab", { projectId, tabId: opened.activeTabId! });
    }
    expect(bad).toEqual([]);
    // The engine never had to heal: the size is applied once the tab is in front, before the first frame.
    expect(engine!.logs().split("applying it again").length - 1).toBe(0);
  });
});
