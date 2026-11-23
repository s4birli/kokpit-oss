// Performans: the screencast of an animated page is capped (browser.screencastEveryNthFrame of Chrome's ~60 Hz
// compositor frames). Before the cap a viewer that acks at once got ~60 frames/s, each a JPEG encode in the
// project's Chrome (~40 % CPU of one core on the Mac mini for one spinning div). Real engine, REAL headless Chrome
// with a temp profile and the mock keychain (testMode).
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrowserFrameMessage } from "@kokpit/shared";
import { Client, startEngine, stopEngine, type EngineProc } from "./harness.ts";

const KEY = randomBytes(32).toString("base64url");
const defaults = JSON.parse(readFileSync(new URL("../config.defaults.json", import.meta.url), "utf8")) as {
  browser: { chromePath: string; projectId: string; screencastEveryNthFrame: number };
};
const haveChrome = existsSync(defaults.browser.chromePath);
/** Chrome's compositor runs at about this rate for an animated page. */
const COMPOSITOR_HZ = 60;
const EVERY_NTH = 4;
const MEASURE_MS = 4000;
const ANIMATED =
  "<!doctype html><title>a</title><style>@keyframes s{to{transform:rotate(360deg)}}div{width:200px;height:200px;background:#c33;animation:s 1s linear infinite}</style><div></div>";

let root: string;
let engine: EngineProc | undefined;
let site: http.Server;
let c: Client;
const projectId = defaults.browser.projectId;

beforeAll(async () => {
  if (!haveChrome) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-e2e-browser-fps-")));
  mkdirSync(join(root, "home"));
  site = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(ANIMATED);
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  const configPath = join(root, "engine.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      dataDir: join(root, "data"),
      port: 0,
      shell: "/bin/sh",
      shellArgs: [],
      listenTailscale: false,
      browser: { testMode: true, headless: true, screencastEveryNthFrame: EVERY_NTH },
    }),
  );
  engine = await startEngine({ KOKPIT_CONFIG: configPath, KOKPIT_KEY: KEY, HOME: join(root, "home") });
  c = await Client.connect(engine.port, KEY);
}, 60_000);

afterAll(async () => {
  if (!haveChrome) return;
  await c?.req("browser.close", { projectId }).catch(() => {});
  await c?.close();
  await stopEngine(engine);
  site?.close();
  rmSync(root, { recursive: true, force: true });
});

describe("tarayıcı akışı: kare sınırı", () => {
  it("the shipped default sends EVERY frame: Chrome emits a single frame for a static page, and skipping frames dropped it (the panel stayed empty)", () => {
    expect(defaults.browser.screencastEveryNthFrame).toBe(1);
  });

  it.skipIf(!haveChrome)("an animated page reaches a viewer that acks at once at about 60 / everyNthFrame frames per second", async () => {
    await c.req("browser.open", { projectId });
    await c.req("browser.navigate", { projectId, url: `http://127.0.0.1:${(site.address() as { port: number }).port}/` });
    const frames = () => c.frames.filter((f): f is BrowserFrameMessage => f.type === "browser.frame" && f.projectId === projectId);
    const acker = setInterval(() => {
      const last = frames().at(-1);
      if (last) c.ws.send(JSON.stringify({ type: "browser.ack", projectId, frameId: last.frameId }));
    }, 5);
    try {
      await c.req("browser.screencast.start", { projectId, maxWidth: 800, maxHeight: 600, quality: 70 });
      await new Promise((r) => setTimeout(r, 1500));
      const before = frames().length;
      await new Promise((r) => setTimeout(r, MEASURE_MS));
      const fps = ((frames().length - before) * 1000) / MEASURE_MS;
      expect(fps).toBeGreaterThan(1);
      // Room for a compositor a little over 60 Hz and for timing noise on a loaded machine.
      expect(fps).toBeLessThanOrEqual((COMPOSITOR_HZ / EVERY_NTH) * 1.5);
    } finally {
      clearInterval(acker);
      await c.req("browser.screencast.stop", { projectId }).catch(() => {});
    }
  }, 60_000);
});
