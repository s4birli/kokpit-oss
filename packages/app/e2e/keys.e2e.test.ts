// Tuşlar end-to-end: the built app (Electron, Playwright `_electron`) against a real engine.
// "Ajanlar arasında ok tuşlarıyla gezemiyorum; Shift+Enter yeni satır açmıyor": a fake full-screen program
// (fixtures/fake-keys-tui.mjs — never the real `claude`) records every byte that reaches it through the PTY, in each
// terminal mode Claude Code switches (DECCKM, mouse tracking, bracketed paste, focus events, kitty/modifyOtherKeys
// requests). Every key must arrive exactly once, as these bytes — also over a link, after ⌘ was held, and next to
// Kokpit's own shortcuts (⌘V pastes once, ⌘ = / − / 0 resize the font and send nothing).
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ElectronApplication, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { engineRequest, launchApp, launchTerminal, SCREENSHOT_DIR, sleep, startEngine, stopEngine, xtermText, type EngineHandle } from "./harness.ts";
import { diagnoseFailures } from "./diagnostics.ts";

const KEY = randomBytes(32).toString("hex");
const UI_TIMEOUT_MS = 20_000;
/** After a key's bytes arrived: long enough for a duplicate (or a late second part) to have arrived too. */
const SETTLE_MS = 300;
/** Long enough for bytes to have arrived if a shortcut (wrongly) sent any. */
const QUIET_MS = 800;
const PROJECT = "Tuş Projesi";
const FAKE_TUI = fileURLToPath(new URL("./fixtures/fake-keys-tui.mjs", import.meta.url));
const keyDefaults = JSON.parse(readFileSync(new URL("../src/renderer/engine/terminal-keys.defaults.json", import.meta.url), "utf8")) as { shiftEnter: string };
const LINK = "https://ornek.invalid/ajan/1";
const PATH = "/tmp/ajan-bir.txt";
const PASTE = `YAPISTIR_${randomBytes(3).toString("hex")}`;

let root: string;
let engine: EngineHandle | undefined;
let app: ElectronApplication | undefined;
let page: Page;
let stdinLog: string;
let TUI_CMD: string;
let previousClipboard: string | undefined;

diagnoseFailures("keys", () => ({ app, page, engine }));

const panel = (): Locator => page.getByRole("region", { name: "Terminaller", exact: true });
const paneOf = (title: string): Locator => panel().locator('[role="tabpanel"]').filter({ has: page.locator(`[aria-label="Terminal: ${title}"]`) });
const rail = (): Locator => page.getByRole("navigation", { name: "Kokpit" });
/** Everything the program read; focus reports (ESC [ I / ESC [ O) left out — they are not keys. */
const received = (): string => (existsSync(stdinLog) ? readFileSync(stdinLog, "latin1") : "").replace(/\x1b\[[IO]/g, "");
const hex = (s: string): string => Buffer.from(s, "latin1").toString("hex").replace(/(..)(?!$)/g, "$1 ");
const readClipboard = (): Promise<string> => app!.evaluate(({ clipboard }) => clipboard.readText());
const writeClipboard = (text: string): Promise<void> => app!.evaluate(({ clipboard }, t) => clipboard.writeText(t), text);

async function setModes(modes: string): Promise<void> {
  writeFileSync(`${stdinLog}.mode`, modes);
  const want = modes.split(/[ ,]+/).filter(Boolean).sort().join("+") || "duz";
  await expect.poll(() => xtermText(paneOf(TUI_CMD)), { timeout: UI_TIMEOUT_MS, interval: 50 }).toContain(`KIP_${want}`);
}

/** Presses one key on the focused terminal and returns exactly the bytes the program got for it (hex). */
async function bytesOf(key: string): Promise<string> {
  const before = received().length;
  await page.keyboard.press(key);
  await expect.poll(() => received().length, { timeout: UI_TIMEOUT_MS, interval: 25 }).toBeGreaterThan(before);
  await sleep(SETTLE_MS);
  return hex(received().slice(before));
}

/** The middle of the character cell showing the middle of `text` (page coordinates). */
async function pointOf(text: string): Promise<{ x: number; y: number }> {
  const p = await paneOf(TUI_CMD).evaluate((el, needle) => {
    for (const row of el.querySelectorAll(".xterm-rows > div")) {
      const at = (row.textContent ?? "").indexOf(needle);
      if (at < 0) continue;
      const want = at + Math.floor(needle.length / 2);
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      let seen = 0;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const len = (n.textContent ?? "").length;
        if (want < seen + len) {
          const r = document.createRange();
          r.setStart(n, want - seen);
          r.setEnd(n, want - seen + 1);
          const b = r.getBoundingClientRect();
          return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
        }
        seen += len;
      }
    }
    return null;
  }, text);
  if (!p) throw new Error(`"${text}" is not on screen`);
  return p;
}

/** What each key must send — as xterm (and every standard terminal) sends it; Shift+Enter is Kokpit's setting. */
function expected(decckm: boolean): [string, string][] {
  const cursor = decckm ? "1b 4f" : "1b 5b";
  return [
    ["ArrowUp", `${cursor} 41`],
    ["ArrowDown", `${cursor} 42`],
    ["ArrowRight", `${cursor} 43`],
    ["ArrowLeft", `${cursor} 44`],
    ["Home", `${cursor} 48`],
    ["End", `${cursor} 46`],
    ["PageUp", "1b 5b 35 7e"],
    ["PageDown", "1b 5b 36 7e"],
    ["Enter", "0d"],
    ["Shift+Enter", hex(keyDefaults.shiftEnter)],
    ["Alt+Enter", "1b 0d"],
    ["Control+j", "0a"],
    ["Escape", "1b"],
    ["Tab", "09"],
    ["Shift+Tab", "1b 5b 5a"],
    ["Control+c", "03"],
    ["Control+d", "04"],
  ];
}

async function expectKeys(decckm: boolean): Promise<void> {
  const got: string[] = [];
  for (const [key] of expected(decckm)) got.push(`${key}: ${await bytesOf(key)}`);
  expect(got).toEqual(expected(decckm).map(([key, bytes]) => `${key}: ${bytes}`));
}

beforeAll(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-keys-")));
  const repo = join(root, "depo");
  mkdirSync(repo);
  mkdirSync(join(root, "home"));
  stdinLog = join(root, "tui-stdin.log");
  TUI_CMD = `'${process.execPath}' '${FAKE_TUI}' '${stdinLog}'`;
  const configPath = join(root, "engine.json");
  writeFileSync(
    configPath,
    JSON.stringify({ dataDir: join(root, "data"), port: 0, shell: "/bin/sh", shellArgs: [], listenTailscale: false, flushIntervalMs: 100, killGraceMs: 200 }),
  );
  engine = await startEngine(configPath, KEY, { HOME: join(root, "home") });
  // Never start the seeded global default tool (claude).
  await engineRequest(engine.url, KEY, "settings.update", { defaultToolId: null });
  await engineRequest(engine.url, KEY, "projects.create", { name: PROJECT, location: { kind: "local", path: repo } });
  app = await launchApp({ KOKPIT_USER_DATA_DIR: join(root, "user-data") });
  previousClipboard = await readClipboard();
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.getByLabel("Motor adresi").fill(engine.url);
  await page.getByLabel("Anahtar").fill(KEY);
  await page.getByRole("button", { name: "Bağlan" }).click();
  await rail().getByRole("button", { name: PROJECT, exact: true }).click();
});

afterAll(async () => {
  // The tests run on the user's Mac: give the clipboard its text back, unless the user copied something meanwhile.
  if (app && previousClipboard !== undefined && (await readClipboard().catch(() => "")) === PASTE) await writeClipboard(previousClipboard).catch(() => {});
  await app?.close().catch(() => {});
  await stopEngine(engine);
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("Tuşlar end-to-end", () => {
  it("1. the fake program runs in a focused terminal", async () => {
    await expect.poll(() => page.locator(".kp-header__title").textContent(), { timeout: UI_TIMEOUT_MS }).toBe(PROJECT);
    await launchTerminal(page, TUI_CMD);
    await expect.poll(() => xtermText(paneOf(TUI_CMD)), { timeout: UI_TIMEOUT_MS, interval: 100 }).toContain("TUS_HAZIR");
    await paneOf(TUI_CMD).locator(".xterm").click();
    await sleep(SETTLE_MS);
  });

  it("2. normal cursor keys, no mouse tracking: every key arrives once, as a terminal sends it", async () => {
    await setModes("");
    await expectKeys(false);
  });

  it("3. mouse tracking on (as Claude Code has it)", async () => {
    await setModes("mouse");
    await expectKeys(false);
  });

  it("4. application cursor keys (DECCKM): arrows, Home and End as ESC O …", async () => {
    await setModes("decckm");
    await expectKeys(true);
  });

  it("5. DECCKM with mouse tracking and the kitty / modifyOtherKeys requests xterm does not speak", async () => {
    await setModes("mouse decckm kitty modkeys");
    await expectKeys(true);
    await page.screenshot({ path: join(SCREENSHOT_DIR, "keys-05-tum-kipler.png") });
  });

  it("6. the pointer resting on a link and on a path, mouse tracking on: keys still reach the program", async () => {
    await setModes("mouse");
    for (const target of [LINK, PATH]) {
      const p = await pointOf(target);
      await page.mouse.move(p.x - 4, p.y);
      await page.mouse.move(p.x, p.y, { steps: 3 });
      expect(await bytesOf("ArrowDown")).toBe("1b 5b 42");
      expect(await bytesOf("Shift+Enter")).toBe(hex(keyDefaults.shiftEnter));
    }
  });

  it("7. after ⌘ was held and let go (link modifier): keys still reach the program", async () => {
    await page.keyboard.down("Meta");
    await sleep(SETTLE_MS);
    await page.keyboard.up("Meta");
    expect(await bytesOf("ArrowUp")).toBe("1b 5b 41");
    expect(await bytesOf("Enter")).toBe("0d");
  });

  it("8. Kokpit's shortcuts stay Kokpit's: ⌘ = / − / 0 resize the font and send nothing; ⌘V pastes once, bracketed", async () => {
    const section = page.locator("section.kp-tabs");
    const size = async (): Promise<string | null> => section.getAttribute("data-font-size");
    const start = await size();
    const before = received().length;
    await page.keyboard.press("Meta+=");
    await expect.poll(size, { timeout: UI_TIMEOUT_MS }).not.toBe(start);
    await page.keyboard.press("Meta+0");
    await expect.poll(size, { timeout: UI_TIMEOUT_MS }).toBe(start);
    await page.keyboard.press("Meta+-");
    await expect.poll(size, { timeout: UI_TIMEOUT_MS }).not.toBe(start);
    await page.keyboard.press("Meta+0");
    await sleep(QUIET_MS);
    expect(hex(received().slice(before))).toBe("");

    await writeClipboard(PASTE);
    expect(await bytesOf("Meta+v")).toBe(hex(`\x1b[200~${PASTE}\x1b[201~`));
  });
});
