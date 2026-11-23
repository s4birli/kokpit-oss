// Kısayollar end-to-end: "Tarayıcıda klavye kısayollarını kullanamıyorum". The built app against a real engine with a
// real (headless, test-only) Chrome and a local test page that reports every keydown / keyup / input / clipboard
// event and its field's value and selection to the test server. Real keys go through Playwright's keyboard into the
// app window (not dispatched DOM events). For every shortcut a Chrome user on macOS expects, either the app's action
// happened (address bar focused, tab opened / closed / reopened / switched, page reloaded, back / forward, find bar,
// zoom) and the page got no key, or the page got exactly that key once (keydown + keyup, with its modifiers) and
// the editing it means happened in the field (select all, undo, word / line moves, deletes). Runs in Turkish and
// English.
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENGINE_DIR, engineRequest, launchApp, sleep, startEngine, stopEngine, type EngineHandle } from "./harness.ts";
import { diagnoseFailures } from "./diagnostics.ts";

const KEY = randomBytes(32).toString("hex");
const UI_TIMEOUT_MS = 30_000;
/** After a key: long enough for its events (or a duplicate) to have reached the page and the test server. */
const SETTLE_MS = 500;
const engineDefaults = JSON.parse(readFileSync(join(ENGINE_DIR, "config.defaults.json"), "utf8")) as { browser: { projectName: string } };
const PROJECT = engineDefaults.browser.projectName;
const catalog = (lang: string, file: string): Record<string, Record<string, string>> =>
  JSON.parse(readFileSync(new URL(`../src/i18n/locales/${lang}/${file}.json`, import.meta.url), "utf8")) as Record<string, Record<string, string>>;

/** Where the test page's fields are (page CSS px): [left, top, width, height]. */
const FIELD = [20, 80, 400, 30] as const;
const AREA = [20, 130, 400, 60] as const;
const FIELD_TEXT = "alpha beta gamma";

interface PageEvent {
  t: string;
  key?: string;
  code?: string;
  mods?: string;
  value?: string;
  sel?: [number, number];
  doc?: string;
  url?: string;
  data?: string | null;
  inputType?: string;
}

let root: string;
let engine: EngineHandle | undefined;
let app: ElectronApplication | undefined;
let page: Page;
let server: http.Server;
let port: number;
let projectId: string;
const events: PageEvent[] = [];

diagnoseFailures("browser-keys", () => ({ app, page, engine }));

const TEST_PAGE = (name: string) => `<!doctype html><meta charset="utf-8"><title>${name}</title>
<body style="margin:0;font:16px sans-serif">
<h1 style="margin:8px;font-size:20px">Kokpit ${name}</h1>
<input id="f" value="${FIELD_TEXT}" style="position:absolute;left:${FIELD[0]}px;top:${FIELD[1]}px;width:${FIELD[2]}px;height:${FIELD[3]}px;box-sizing:border-box;font:16px monospace">
<textarea id="a" style="position:absolute;left:${AREA[0]}px;top:${AREA[1]}px;width:${AREA[2]}px;height:${AREA[3]}px;box-sizing:border-box;font:16px monospace">line one
line two</textarea>
<p style="position:absolute;top:220px;left:20px">Sayfa metni burada</p>
<script>
const send=(o)=>{const el=document.activeElement;const f=el&&("value" in el)?el:null;
o.value=f?f.value:undefined;o.sel=f?[f.selectionStart,f.selectionEnd]:undefined;o.doc=String(getSelection());o.url=location.pathname;
fetch("/log",{method:"POST",body:JSON.stringify(o),keepalive:true});};
const mods=(e)=>(e.metaKey?"M":"")+(e.ctrlKey?"C":"")+(e.altKey?"A":"")+(e.shiftKey?"S":"");
addEventListener("keydown",(e)=>send({t:"down",key:e.key,code:e.code,mods:mods(e)}),true);
addEventListener("keyup",(e)=>send({t:"up",key:e.key,code:e.code,mods:mods(e)}),true);
addEventListener("input",(e)=>send({t:"input",inputType:e.inputType,data:e.data}),true);
for(const n of ["copy","cut","paste"])addEventListener(n,()=>send({t:n}),true);
addEventListener("load",()=>send({t:"load"}));
</script></body>`;

const rail = (): Locator => page.getByRole("navigation", { name: "Kokpit" });
const browser = (): Locator => page.locator("section.kp-browser");
const canvas = (): Locator => browser().locator("canvas");

interface TabsState {
  activeTabId?: string;
  tabs: { id: string; url: string; title: string }[];
}
const tabs = async (): Promise<TabsState> =>
  ((await engineRequest(engine!.url, KEY, "browser.tabs", { projectId })) as { browser: TabsState }).browser;
const activeUrl = async (): Promise<string> => {
  const s = await tabs();
  return s.tabs.find((t) => t.id === s.activeTabId)?.url ?? "";
};

/** Clicks a point of the page (page CSS px) through the picture. */
async function clickPage(x: number, y: number): Promise<void> {
  const box = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>(".kp-browser__canvas")!;
    const r = c.getBoundingClientRect();
    const [fw, fh] = (c.getAttribute("data-frame-size") ?? "0x0").split("x").map(Number);
    return { x: r.x, y: r.y, width: r.width, height: r.height, fw: fw!, fh: fh! };
  });
  await page.mouse.click(box.x + (x * box.width) / box.fw, box.y + (y * box.height) / box.fh);
}

/** The field the user works in, with its text and caret reset (a click, then the page's own selection API). */
async function focusField(which: "f" | "a" = "f"): Promise<void> {
  const r = which === "f" ? FIELD : AREA;
  await canvas().focus();
  await clickPage(r[0] + r[2] - 10, r[1] + r[3] / 2);
  await sleep(SETTLE_MS);
  events.length = 0;
}

/** What the page got from one key press (after the settle time). */
async function pressOnPage(combo: string): Promise<PageEvent[]> {
  events.length = 0;
  await page.keyboard.press(combo);
  await sleep(SETTLE_MS);
  return [...events];
}

const keyEvents = (evs: PageEvent[]): string[] =>
  evs.filter((e) => e.t === "down" || e.t === "up").filter((e) => !["Meta", "Control", "Alt", "Shift"].includes(e.key!)).map((e) => `${e.t}:${e.mods}+${e.key}`);
const last = (evs: PageEvent[]): PageEvent | undefined => [...evs].reverse().find((e) => e.value !== undefined);

function processes(needle: string): number[] {
  const out = execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" });
  return out
    .split("\n")
    .filter((l) => l.includes(needle) && !l.includes("ps -ax"))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-keys-")));
  server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/log") {
      let body = "";
      req.on("data", (d: Buffer) => (body += d.toString()));
      req.on("end", () => {
        try {
          events.push(JSON.parse(body) as PageEvent);
        } catch {
          /* ignore */
        }
        res.writeHead(204).end();
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(TEST_PAGE((req.url ?? "/").slice(1) || "ana"));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as { port: number }).port;
  const configPath = join(root, "engine.json");
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
      browser: { headless: true, testMode: true },
    }),
  );
  engine = await startEngine(configPath, KEY);
  await engineRequest(engine.url, KEY, "settings.update", { defaultToolId: null });
  const { projects } = (await engineRequest(engine.url, KEY, "projects.list", {})) as { projects: { id: string; name: string }[] };
  projectId = projects.find((p) => p.name === PROJECT)!.id;
}, 120_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  await stopEngine(engine);
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  if (root) {
    for (const pid of processes(root)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe.each(["tr", "en"] as const)("Tarayıcı kısayolları (%s)", (lang) => {
  const connect = catalog(lang, "connect").screen!;
  const panel = catalog(lang, "browser").panel!;

  it("0. open the app and the browser on the test page", async () => {
    await app?.close().catch(() => {});
    const userDataDir = join(root, `user-data-${lang}`);
    mkdirSync(userDataDir, { recursive: true });
    app = await launchApp({ KOKPIT_USER_DATA_DIR: userDataDir, KOKPIT_TEST_LANGUAGE: lang });
    page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 900));
    await page.getByLabel(connect.url!).fill(engine!.url);
    await page.getByLabel(connect.key!).fill(KEY);
    await page.getByRole("button", { name: connect.submit! }).click();
    await expect.poll(() => rail().getByRole("button", { name: PROJECT, exact: true }).isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await rail().getByRole("button", { name: PROJECT, exact: true }).click();
    const open = browser().getByRole("button", { name: panel.open! });
    if (await open.isVisible()) await open.click();
    await expect.poll(async () => Number((await canvas().getAttribute("data-frames")) ?? "0"), { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(0);
    const address = browser().getByLabel(panel.address!);
    await address.fill(`http://127.0.0.1:${port}/ana`);
    await address.press("Enter");
    await expect.poll(activeUrl, { timeout: UI_TIMEOUT_MS }).toContain("/ana");
    await expect.poll(async () => (await canvas().getAttribute("data-frame-size")) ?? "", { timeout: UI_TIMEOUT_MS }).not.toBe("");
  });

  /** A fresh test page (its field back to FIELD_TEXT), the caret at the end of `which`. */
  async function freshField(which: "f" | "a" = "f"): Promise<void> {
    events.length = 0;
    await engineRequest(engine!.url, KEY, "browser.navigate", { projectId, url: `http://127.0.0.1:${port}/ana` });
    await expect.poll(() => events.some((e) => e.t === "load"), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await focusField(which);
  }
  /** One key on the page: it got exactly that key once (down + up, these modifiers); returns the field's state after. */
  async function pageKey(combo: string, mods: string, key: string): Promise<PageEvent | undefined> {
    const evs = await pressOnPage(combo);
    expect(keyEvents(evs), combo).toEqual([`down:${mods}+${key}`, `up:${mods}+${key}`]);
    return last(evs);
  }
  /** An app action: the page got no key at all. */
  async function appKey(combo: string): Promise<void> {
    const evs = await pressOnPage(combo);
    expect(keyEvents(evs), combo).toEqual([]);
  }
  const L = FIELD_TEXT.length;

  it("1. editing keys reach the page once and edit as in Chrome: ⌘A, ⌘Z / ⇧⌘Z, ⌥← ⌘← ⌘→, ⇧←, ⌥⌫, ⌘⌫", async () => {
    await freshField();
    expect((await pageKey("Meta+a", "M", "a"))?.sel).toEqual([0, L]);
    await page.keyboard.press("ArrowRight");
    await sleep(SETTLE_MS);
    await page.keyboard.type("x");
    await sleep(SETTLE_MS);
    expect((await pageKey("Meta+z", "M", "z"))?.value).toBe(FIELD_TEXT);
    expect((await pageKey("Meta+Shift+z", "MS", "z"))?.value).toBe(`${FIELD_TEXT}x`);
    await freshField();
    expect((await pageKey("Alt+ArrowLeft", "A", "ArrowLeft"))?.sel).toEqual([11, 11]);
    expect((await pageKey("Meta+ArrowLeft", "M", "ArrowLeft"))?.sel).toEqual([0, 0]);
    expect((await pageKey("Meta+ArrowRight", "M", "ArrowRight"))?.sel).toEqual([L, L]);
    expect((await pageKey("Shift+ArrowLeft", "S", "ArrowLeft"))?.sel).toEqual([L - 1, L]);
    await page.keyboard.press("ArrowRight");
    await sleep(SETTLE_MS);
    expect((await pageKey("Alt+Backspace", "A", "Backspace"))?.value).toBe("alpha beta ");
    expect((await pageKey("Meta+Backspace", "M", "Backspace"))?.value).toBe("");
  });

  it("2. textarea: ⌘↑ / ⌘↓ go to the start / end; Enter, Tab and Escape reach the page once", async () => {
    await freshField("a");
    const len = "line one\nline two".length;
    expect((await pageKey("Meta+ArrowUp", "M", "ArrowUp"))?.sel).toEqual([0, 0]);
    expect((await pageKey("Meta+ArrowDown", "M", "ArrowDown"))?.sel).toEqual([len, len]);
    expect((await pageKey("Enter", "", "Enter"))?.value).toBe("line one\nline two\n");
    await pageKey("Escape", "", "Escape");
    await pageKey("Tab", "", "Tab");
  });

  it("3. Turkish characters and ⌥Q (@ on Turkish Q) are typed into the field", async () => {
    await freshField();
    // Turkish Q is a layout Playwright cannot switch to: the key events as macOS reports them on it (the letters' own
    // keys; Option+Q types "@").
    const cdp = await page.context().newCDPSession(page);
    const turkishQ: [string, string, number][] = [["ş", "Semicolon", 0], ["ğ", "BracketLeft", 0], ["ı", "KeyI", 0], ["ç", "Backslash", 0], ["ö", "Comma", 0], ["ü", "BracketRight", 0], ["İ", "Quote", 8], ["@", "KeyQ", 1]];
    for (const [key, code, modifiers] of turkishQ) {
      for (const type of ["keyDown", "keyUp"] as const) {
        await cdp.send("Input.dispatchKeyEvent", { type, key, code, modifiers, ...(type === "keyDown" ? { text: key } : {}) });
      }
    }
    await cdp.detach();
    await expect.poll(() => last(events)?.value, { timeout: UI_TIMEOUT_MS }).toBe(`${FIELD_TEXT}şğıçöüİ@`);
    // each once
    expect(keyEvents(events).filter((k) => k.startsWith("down:"))).toHaveLength(turkishQ.length);
  });

  it("4. ⌘C copies the page's selection to this Mac's clipboard; ⌘V pastes it once", async () => {
    const previous = await app!.evaluate(({ clipboard }) => clipboard.readText());
    try {
      await freshField();
      await page.keyboard.press("Meta+a");
      await sleep(SETTLE_MS);
      await page.keyboard.press("Meta+c");
      await expect.poll(() => app!.evaluate(({ clipboard }) => clipboard.readText()), { timeout: UI_TIMEOUT_MS }).toBe(FIELD_TEXT);
      await page.keyboard.press("ArrowRight");
    await sleep(SETTLE_MS);
      const evs = await pressOnPage("Meta+v");
      expect(keyEvents(evs)).toEqual([]);
      expect(last(evs)?.value).toBe(FIELD_TEXT + FIELD_TEXT);
    } finally {
      await app!.evaluate(({ clipboard }, t) => clipboard.writeText(t), previous);
    }
  });

  it("5. ⌘L focuses the address bar (the page gets nothing)", async () => {
    await freshField();
    await appKey("Meta+l");
    expect(await browser().getByLabel(panel.address!).evaluate((el) => el === document.activeElement)).toBe(true);
  });

  it("6. ⌘T opens a tab (caret in the address bar), ⌘W closes it, ⇧⌘T opens it again", async () => {
    await freshField();
    const n = (await tabs()).tabs.length;
    await appKey("Meta+t");
    await expect.poll(async () => (await tabs()).tabs.length, { timeout: UI_TIMEOUT_MS }).toBe(n + 1);
    const address = browser().getByLabel(panel.address!);
    expect(await address.evaluate((el) => el === document.activeElement)).toBe(true);
    await page.keyboard.type(`http://127.0.0.1:${port}/zwei`);
    await page.keyboard.press("Enter");
    await expect.poll(activeUrl, { timeout: UI_TIMEOUT_MS }).toContain("/zwei");
    // The strip shows the new address (what the user closes is what the panel shows).
    await expect.poll(() => browser().locator('.kp-browser__tab[data-active] .kp-browser__tab-select[title$="/zwei"]').count(), { timeout: UI_TIMEOUT_MS }).toBe(1);
    await canvas().focus();
    await appKey("Meta+w");
    await expect.poll(async () => (await tabs()).tabs.length, { timeout: UI_TIMEOUT_MS }).toBe(n);
    await appKey("Meta+Shift+t");
    await expect.poll(async () => (await tabs()).tabs.length, { timeout: UI_TIMEOUT_MS }).toBe(n + 1);
    await expect.poll(activeUrl, { timeout: UI_TIMEOUT_MS }).toContain("/zwei");
  });

  it("7. ⌘1 / ⌘9 / Ctrl+Tab / Ctrl+⇧Tab switch tabs", async () => {
    await canvas().focus();
    const s = await tabs();
    const first = s.tabs[0]!.id;
    const lastId = s.tabs.at(-1)!.id;
    const active = async () => (await tabs()).activeTabId;
    await appKey("Meta+1");
    await expect.poll(active, { timeout: UI_TIMEOUT_MS }).toBe(first);
    await appKey("Meta+9");
    await expect.poll(active, { timeout: UI_TIMEOUT_MS }).toBe(lastId);
    await appKey("Control+Tab");
    await expect.poll(active, { timeout: UI_TIMEOUT_MS }).toBe(first);
    await appKey("Control+Shift+Tab");
    await expect.poll(active, { timeout: UI_TIMEOUT_MS }).toBe(lastId);
  });

  it("8. ⌘R and ⇧⌘R reload the page once each; ⌘[ / ⌘] go back / forward", async () => {
    await freshField();
    for (const combo of ["Meta+r", "Meta+Shift+r"]) {
      await appKey(combo);
      await expect.poll(() => events.filter((e) => e.t === "load").length, { timeout: UI_TIMEOUT_MS, message: combo }).toBe(1);
      await sleep(SETTLE_MS);
      expect(events.filter((e) => e.t === "load")).toHaveLength(1);
    }
    await engineRequest(engine!.url, KEY, "browser.navigate", { projectId, url: `http://127.0.0.1:${port}/iki` });
    await expect.poll(activeUrl, { timeout: UI_TIMEOUT_MS }).toContain("/iki");
    await canvas().focus();
    await appKey("Meta+BracketLeft");
    await expect.poll(activeUrl, { timeout: UI_TIMEOUT_MS }).toContain("/ana");
    await appKey("Meta+BracketRight");
    await expect.poll(activeUrl, { timeout: UI_TIMEOUT_MS }).toContain("/iki");
  });

  it("9. ⌘= / ⌘0 zoom the page; no key reaches it", async () => {
    await freshField();
    const zoom = async () => Number(await browser().locator(".kp-browser__view").getAttribute("data-zoom"));
    const z0 = await zoom();
    await appKey("Meta+Equal");
    await expect.poll(zoom, { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(z0);
    await appKey("Meta+0");
    await expect.poll(zoom, { timeout: UI_TIMEOUT_MS }).toBe(z0);
  });

  it("10. Kokpit's menu keys (⌘, ⌘H) are left to the menu bar — never the page's, never prevented", async () => {
    await freshField();
    // Synthetic keys do not reach macOS's menu bar (the menu's own path is not testable here): what is checked is
    // that the page view lets the key through untouched, as it does for a key the menu then runs.
    await page.evaluate(() => {
      const w = window as unknown as { menuKeys: string[] };
      w.menuKeys = [];
      addEventListener("keydown", (e) => {
        if (e.metaKey && e.key !== "Meta") {
          w.menuKeys.push(`${e.key}:${e.defaultPrevented}`);
          // keep the test's own app open and visible
          e.preventDefault();
        }
      });
    });
    for (const combo of ["Meta+Comma", "Meta+h"]) await appKey(combo);
    expect(await page.evaluate(() => (window as unknown as { menuKeys: string[] }).menuKeys)).toEqual([",:false", "h:false"]);
  });
});
