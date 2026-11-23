// Tam ekran ve yanıp sönme: the panel's size changes (the app window enters / leaves macOS full screen) while the
// page keeps painting. Real engine + REAL headless Chrome (temp profile, mock keychain). The app reports the new
// size and restarts its screencast; frames of the old size are still on their way at that moment. The self-healing
// (§7A) must not take those for "Chrome lost the panel's size" and apply the size and restart the stream once more
// on its own: measured before the fix, every full-screen entry and exit logged one such heal ("frame 996x567, want
// 1410x737"), i.e. one extra override and one extra screencast restart per transition.
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserFrameMessage } from "@kokpit/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, startEngine, stopEngine, type EngineProc } from "./harness.ts";

const KEY = randomBytes(32).toString("base64url");
const WAIT_MS = 20_000;
const defaults = JSON.parse(readFileSync(new URL("../config.defaults.json", import.meta.url), "utf8")) as {
  browser: { chromePath: string; viewportHealIntervalMs: number; viewportHealMaxTries: number; defaultZoom: number };
};
const haveChrome = existsSync(defaults.browser.chromePath);
/** The engine's log line for a self-heal (browser.ts). */
const HEAL_LOG = "browser frame is not the panel's size; applying it again";
/** The panel in a window and in full screen (CSS px, measured on a 1920×1080 display), on a 2× screen. */
const WINDOWED = { width: 667, height: 380 };
const FULL_SCREEN = { width: 945, height: 494 };
const DPR = 2;
/** Full screen entered and left this many times. */
const ROUNDS = 4;
/** After the new size's frame arrived: long enough for every self-heal try to have run. */
const SETTLE_MS = (defaults.browser.viewportHealMaxTries + 1) * defaults.browser.viewportHealIntervalMs;

let root: string;
let engine: EngineProc | undefined;
let site: http.Server;
let c: Client;
let projectId: string;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frames = () => c.frames.filter((f): f is BrowserFrameMessage => f.type === "browser.frame" && f.projectId === projectId);
const pageOf = (panel: { width: number; height: number }) => ({
  width: Math.round(panel.width / defaults.browser.defaultZoom),
  height: Math.round(panel.height / defaults.browser.defaultZoom),
});
const heals = () => (engine?.logs().match(new RegExp(HEAL_LOG, "g")) ?? []).length;

function ourChromePids(): number[] {
  const out = execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" });
  return out
    .split("\n")
    .filter((l) => l.includes(root) && l.includes("--user-data-dir="))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** Acks like the app (the newest frame, at once) until a frame of `want` arrives. */
const ACK_EVERY_MS = 5;
async function frameOf(want: { width: number; height: number }, what: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    const last = frames().at(-1);
    if (last) c.ws.send(JSON.stringify({ type: "browser.ack", projectId, frameId: last.frameId }));
    if (last && Math.abs(last.metadata.deviceWidth - want.width) <= 1 && Math.abs(last.metadata.deviceHeight - want.height) <= 1) return;
    if (Date.now() - start > WAIT_MS) throw new Error(`timeout: ${what} (last frame ${last?.metadata.deviceWidth}x${last?.metadata.deviceHeight})`);
    await sleep(ACK_EVERY_MS);
  }
}

/** Keeps acking for `ms`, as a panel that keeps drawing does. */
async function watch(ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const last = frames().at(-1);
    if (last) c.ws.send(JSON.stringify({ type: "browser.ack", projectId, frameId: last.frameId }));
    await sleep(ACK_EVERY_MS);
  }
}

/**
 * What the app sends when its panel changes size: the size, then the screencast at the new device-pixel bounds —
 * while it keeps drawing and acking the frames that are still coming (so old-sized frames do reach the engine while
 * it applies the new size).
 */
async function resizePanel(panel: { width: number; height: number }): Promise<void> {
  let done = false;
  const acking = (async () => {
    while (!done) {
      const last = frames().at(-1);
      if (last) c.ws.send(JSON.stringify({ type: "browser.ack", projectId, frameId: last.frameId }));
      await sleep(ACK_EVERY_MS);
    }
  })();
  try {
    await Promise.all([
      c.req("browser.viewport.set", { projectId, ...panel, interaction: true }),
      c.req("browser.screencast.start", { projectId, maxWidth: panel.width * DPR, maxHeight: panel.height * DPR, quality: 80 }),
    ]);
  } finally {
    done = true;
    await acking;
  }
}

beforeAll(async () => {
  if (!haveChrome) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-e2e-resize-heal-")));
  mkdirSync(join(root, "p"));
  const configPath = join(root, "engine.json");
  const cdpPortBase = 45000 + Math.floor(Math.random() * 20) * 100;
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
  // A page that never stops painting (an animation): frames keep coming while the size changes.
  site = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      '<!doctype html><title>canli</title><body style="margin:0;background:#fde68a"><div style="width:80px;height:80px;background:#1d4ed8;' +
        'animation:s 1s linear infinite alternate"></div><style>@keyframes s{to{transform:translateX(300px)}}</style></body>',
    );
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", () => r()));
  const siteUrl = `http://127.0.0.1:${(site.address() as net.AddressInfo).port}/`;
  engine = await startEngine({ KOKPIT_CONFIG: configPath, KOKPIT_KEY: KEY });
  c = await Client.connect(engine.port, KEY);
  await c.req("settings.update", { defaultToolId: null });
  projectId = (await c.req<{ project: { id: string } }>("projects.create", { name: "Tam ekran", location: { kind: "local", path: join(root, "p") } })).project.id;
  await c.req("browser.viewport.set", { projectId, ...WINDOWED, interaction: true });
  await c.req("browser.open", { projectId });
  await c.req("browser.navigate", { projectId, url: siteUrl });
  await c.req("browser.screencast.start", { projectId, maxWidth: WINDOWED.width * DPR, maxHeight: WINDOWED.height * DPR, quality: 80 });
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

describe.skipIf(!haveChrome)("tam ekran: a panel resize while the page paints is not 'healed' a second time", { timeout: 120_000 }, () => {
  it("entering and leaving full screen: the page follows each new size, the engine never re-applies it by itself", async () => {
    await frameOf(pageOf(WINDOWED), "the windowed panel's frame");
    await watch(SETTLE_MS);
    const before = heals();
    for (let i = 0; i < ROUNDS; i++) {
      for (const panel of [FULL_SCREEN, WINDOWED]) {
        await resizePanel(panel);
        await frameOf(pageOf(panel), `round ${i}: ${panel.width}x${panel.height}`);
        await watch(SETTLE_MS);
        // The last frame is the panel's: nothing changed it back.
        const last = frames().at(-1)!.metadata;
        expect(`${last.deviceWidth}x${last.deviceHeight}`).toBe(`${pageOf(panel).width}x${pageOf(panel).height}`);
      }
    }
    expect(heals() - before).toBe(0);
  });
});
