// İş Z end-to-end against the real engine and a REAL headless Chrome (temp profile, mock keychain):
// - browser.zoom.set makes the page itself render at that zoom, and a click mapped from the screencast image
//   exactly like the app does (image px → metadata device CSS px) lands on the intended button at 0.67, 0.8,
//   1 and 1.25;
// - session cookies (no expiry) survive closing and reopening the project's browser ("Continue where you left off").
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserFrameMessage, BrowserState } from "@kokpit/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectCdp, type CdpConnection } from "../src/cdp.ts";
import { Client, startEngine, stopEngine, type EngineProc } from "./harness.ts";

const KEY = randomBytes(32).toString("base64url");
const WAIT_MS = 20_000;
const defaults = JSON.parse(readFileSync(new URL("../config.defaults.json", import.meta.url), "utf8")) as {
  browser: { chromePath: string; profilesDirName: string };
};
const CHROME = defaults.browser.chromePath;
const haveChrome = existsSync(CHROME);

/** Button id → [left, top, width, height] CSS px and colour; spread so zoom moves them across the image. */
const BUTTONS = {
  red: { box: [40, 40, 140, 70], rgb: [230, 30, 30] },
  green: { box: [520, 60, 140, 70], rgb: [30, 200, 60] },
  blue: { box: [90, 420, 140, 70], rgb: [30, 60, 230] },
  yellow: { box: [820, 520, 140, 70], rgb: [240, 220, 20] },
} as const;
type Color = keyof typeof BUTTONS;

let root: string;
let dataDir: string;
let configPath: string;
let engine: EngineProc | undefined;
let site: http.Server;
let siteUrl: string;
let c: Client;
let projectId: string;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const profile = () => join(dataDir, defaults.browser.profilesDirName, projectId);

async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, what: string, timeoutMs = WAIT_MS): Promise<T> {
  const start = Date.now();
  let last: T | undefined;
  for (;;) {
    last = await fn();
    if (ok(last)) return last;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${what} (last: ${JSON.stringify(last)?.slice(0, 300)})`);
    await sleep(100);
  }
}

function ourChromePids(): number[] {
  const out = execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" });
  return out
    .split("\n")
    .filter((l) => l.includes(root) && l.includes("--user-data-dir="))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function devtoolsPort(): number {
  const out = execFileSync("ps", ["-ax", "-o", "command="], { encoding: "utf8" });
  const line = out.split("\n").find((l) => l.includes(`--user-data-dir=${profile()}`) && !l.includes("--type="));
  return Number(/--remote-debugging-port=(\d+)/.exec(line ?? "")?.[1]);
}

const frames = () => c.frames.filter((f): f is BrowserFrameMessage => f.type === "browser.frame" && f.projectId === projectId);
const lastFrameId = () => frames().at(-1)?.frameId ?? 0;

async function nextFrame(afterId: number, pred: (f: BrowserFrameMessage) => boolean = () => true): Promise<BrowserFrameMessage> {
  return until(
    () => {
      const last = frames().at(-1);
      if (last) c.ws.send(JSON.stringify({ type: "browser.ack", projectId, frameId: last.frameId }));
      return frames().find((f) => f.frameId > afterId && pred(f));
    },
    (f) => f !== undefined,
    `frame after ${afterId}`,
  ) as Promise<BrowserFrameMessage>;
}

const tabs = async () => (await c.req<{ browser: BrowserState }>("browser.tabs", { projectId })).browser;
const activeTitle = async () => {
  const s = await tabs();
  return s.tabs.find((t) => t.id === s.activeTabId)?.title ?? "";
};
const waitTitle = (re: RegExp) => until(activeTitle, (t) => re.test(t), `title ${re}`);
const input = (event: Record<string, unknown>) => c.ws.send(JSON.stringify({ type: "browser.input", projectId, event }));

/** A second CDP client on the page (like an agent would be): evaluates in the active tab. */
async function pageEval<T>(expression: string): Promise<T> {
  const port = devtoolsPort();
  const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  const cdp: CdpConnection = await connectCdp(version.webSocketDebuggerUrl, { timeoutMs: 15_000 });
  try {
    const { activeTabId } = await tabs();
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: activeTabId, flatten: true });
    const r = await cdp.send<{ result: { value: T }; exceptionDetails?: unknown }>(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (r.exceptionDetails) throw new Error(`page eval failed: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
    return r.result.value;
  } finally {
    cdp.close();
  }
}

/** Centroid (image px) of each button colour in a JPEG frame, found by decoding it in the page. */
async function findButtons(frame: BrowserFrameMessage): Promise<{ width: number; height: number; at: Record<Color, { x: number; y: number } | null> }> {
  const colors = Object.fromEntries(Object.entries(BUTTONS).map(([k, v]) => [k, v.rgb]));
  return pageEval(`(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(frame.data)}), (ch) => ch.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
    const cv = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = cv.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    const colors = ${JSON.stringify(colors)};
    const at = {};
    for (const [name, [r, g, b]] of Object.entries(colors)) {
      let sx = 0, sy = 0, n = 0;
      for (let y = 0; y < bmp.height; y++) for (let x = 0; x < bmp.width; x++) {
        const i = (y * bmp.width + x) * 4;
        if (Math.abs(px[i] - r) < 40 && Math.abs(px[i + 1] - g) < 40 && Math.abs(px[i + 2] - b) < 40) { sx += x; sy += y; n++; }
      }
      at[name] = n > 20 ? { x: sx / n, y: sy / n } : null;
    }
    return { width: bmp.width, height: bmp.height, at };
  })()`);
}

function startSite(): Promise<void> {
  site = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (url.pathname === "/buttons") {
      const buttons = Object.entries(BUTTONS)
        .map(
          ([name, { box, rgb }]) =>
            `<button id="${name}" style="position:absolute;left:${box[0]}px;top:${box[1]}px;width:${box[2]}px;height:${box[3]}px;` +
            `border:0;padding:0;background:rgb(${rgb.join(",")})" onclick="document.title='clicked:${name}'"></button>`,
        )
        .join("");
      res.end(`<!doctype html><title>buttons</title><body style="margin:0;background:#fff">${buttons}</body>`);
      return;
    }
    if (url.pathname === "/set-session-cookie") {
      // No Max-Age / Expires: a session cookie.
      res.setHeader("set-cookie", "oturum=acik; Path=/; SameSite=Lax");
      res.end(`<!doctype html><title>session set</title>ok`);
      return;
    }
    if (url.pathname === "/whoami") {
      const cookie = (req.headers.cookie ?? "").replace(/[^A-Za-z0-9=; ]/g, "");
      res.end(`<!doctype html><title>cookies:${cookie}</title>${cookie}`);
      return;
    }
    res.statusCode = 404;
    res.end("<!doctype html><title>yok</title>");
  });
  return new Promise((r) =>
    site.listen(0, "127.0.0.1", () => {
      siteUrl = `http://127.0.0.1:${(site.address() as net.AddressInfo).port}`;
      r();
    }),
  );
}

beforeAll(async () => {
  if (!haveChrome) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-e2e-zoom-")));
  dataDir = join(root, "data");
  mkdirSync(join(root, "p"));
  configPath = join(root, "engine.json");
  const cdpPortBase = 43000 + Math.floor(Math.random() * 20) * 100;
  writeFileSync(
    configPath,
    JSON.stringify({
      dataDir,
      port: 0,
      shell: "/bin/sh",
      shellArgs: [],
      listenTailscale: false,
      flushIntervalMs: 100,
      killGraceMs: 200,
      browser: { headless: true, testMode: true, startTimeoutMs: 30000, cdpPortBase, cdpPortSpan: 100 },
    }),
  );
  await startSite();
  engine = await startEngine({ KOKPIT_CONFIG: configPath, KOKPIT_KEY: KEY });
  c = await Client.connect(engine.port, KEY);
  await c.req("settings.update", { defaultToolId: null });
  projectId = (await c.req<{ project: { id: string } }>("projects.create", { name: "Zoom", location: { kind: "local", path: join(root, "p") } })).project.id;
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

describe.skipIf(!haveChrome)("İş Z: browser zoom and session cookies with a real Chrome", { timeout: 120_000 }, () => {
  let viewport = { width: 0, height: 0 };

  it("at 100 % the screencast shows the window's viewport", async () => {
    // A project nobody zoomed is at the configured default; the user chooses 100 %.
    expect(await c.req("browser.zoom.set", { projectId, zoom: 1, mode: "user" })).toEqual({ zoom: 1, applied: true });
    await c.req("browser.open", { projectId });
    await c.req("browser.navigate", { projectId, url: `${siteUrl}/buttons` });
    await waitTitle(/^buttons$/);
    await c.req("browser.screencast.start", { projectId, maxWidth: 1280, maxHeight: 800, quality: 80 });
    const f = await nextFrame(0);
    viewport = await pageEval<{ width: number; height: number }>("({ width: innerWidth, height: innerHeight })");
    expect(f.metadata.deviceWidth).toBeCloseTo(viewport.width, 0);
    expect(f.metadata.deviceHeight).toBeCloseTo(viewport.height, 0);
  });

  for (const zoom of [0.67, 0.8, 1, 1.25]) {
    it(`zoom ${zoom}: the page renders zoomed and a click mapped from the image hits each button`, async () => {
      const before = lastFrameId();
      await c.req("browser.zoom.set", { projectId, zoom, mode: "user" });
      const want = Math.round(viewport.width / zoom);
      // The page itself is laid out at window px / zoom CSS px.
      await until(() => pageEval<number>("innerWidth"), (w) => Math.abs(w - want) <= 1, `innerWidth ${want}`);
      const frame = await nextFrame(before, (f) => Math.abs(f.metadata.deviceWidth - want) <= 1);
      const img = await findButtons(frame);
      // Buttons appear smaller when zoomed out: red's width in image px ≈ 140 CSS px × zoom × image/window ratio.
      const scale = img.width / viewport.width;
      for (const [name, { box }] of Object.entries(BUTTONS) as [Color, (typeof BUTTONS)[Color]][]) {
        const p = img.at[name];
        expect(p, `${name} visible at zoom ${zoom}`).not.toBeNull();
        // Where the button's centre must appear in the image at this zoom.
        expect(p!.x).toBeCloseTo((box[0] + box[2] / 2) * zoom * scale, -1);
        // Same mapping as the app's toPagePoint: image px → device CSS px (minus offsetTop).
        const x = (p!.x * frame.metadata.deviceWidth) / img.width;
        const y = (p!.y * frame.metadata.deviceHeight) / img.height - (frame.metadata.offsetTop || 0);
        input({ type: "mouse", action: "move", x, y });
        input({ type: "mouse", action: "down", x, y, button: "left", clickCount: 1 });
        input({ type: "mouse", action: "up", x, y, button: "left", clickCount: 1 });
        await waitTitle(new RegExp(`^clicked:${name}$`));
      }
    });
  }

  it("zoom survives a tab switch (applied to the newly active tab)", async () => {
    await c.req("browser.zoom.set", { projectId, zoom: 0.8, mode: "user" });
    await c.req("browser.newTab", { projectId, url: `${siteUrl}/buttons` });
    await waitTitle(/^buttons$/);
    const want = Math.round(viewport.width / 0.8);
    await until(() => pageEval<number>("innerWidth"), (w) => Math.abs(w - want) <= 1, "innerWidth in the new tab");
    await c.req("browser.zoom.set", { projectId, zoom: 1, mode: "user" });
    await until(() => pageEval<number>("innerWidth"), (w) => Math.abs(w - viewport.width) <= 1, "back to 100 %");
  });

  it("a session cookie (no expiry) survives closing and reopening the project's browser", async () => {
    await c.req("browser.navigate", { projectId, url: `${siteUrl}/set-session-cookie` });
    await waitTitle(/^session set$/);
    await c.req("browser.navigate", { projectId, url: `${siteUrl}/whoami` });
    await waitTitle(/oturum=acik/);
    await c.req("browser.close", { projectId });
    await until(() => ourChromePids().length, (n) => n === 0, "Chrome gone");
    await c.req("browser.open", { projectId });
    await c.req("browser.navigate", { projectId, url: `${siteUrl}/whoami` });
    await waitTitle(/^cookies:/);
    expect(await activeTitle()).toMatch(/oturum=acik/);
  });
});
