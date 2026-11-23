// Kopyalama — Tarayıcı, end-to-end against the real engine and a REAL headless Chrome (temp profile, mock keychain):
// - browser.copy returns exactly what is selected in the remote page (document, input, textarea, same-origin frame),
//   nothing when nothing is selected, never a password field; `cut` also removes an editable selection;
// - browser.paste inserts text at the caret of an input, a textarea and a contenteditable;
// - browser.context tells the app's right-click menu about the selection, the focus and the link under a point;
// - caps are enforced on the engine and no clipboard text reaches its log.
// No system clipboard is read or written here: the engine never touches one for the browser.
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContextInfo, BrowserState } from "@kokpit/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectCdp } from "../src/cdp.ts";
import { Client, startEngine, stopEngine, type EngineProc } from "./harness.ts";

const KEY = randomBytes(32).toString("base64url");
const WAIT_MS = 20_000;
const defaults = JSON.parse(readFileSync(new URL("../config.defaults.json", import.meta.url), "utf8")) as {
  browser: { chromePath: string; profilesDirName: string; clipboardMaxChars: number };
};
const CHROME = defaults.browser.chromePath;
const haveChrome = existsSync(CHROME);
/** This engine's cap (the shipped default is far larger): small enough to exceed with a page element. */
const CAP = 2000;
const PANEL = { width: 800, height: 500 };
const TURKISH = "Merhaba dünya çğıöşü İIĞÜŞÖÇ";
const SECRET = "gizli-parola-Zx9!";
const PASTE_SECRET = "yapıştırılan-sır-Qw7#";
const BIG = "b".repeat(CAP + 500);

const PAGE = `<!doctype html><meta charset="utf-8"><title>pano</title>
<body style="margin:0;font:16px/20px monospace">
<p id="p" style="position:absolute;left:10px;top:10px;margin:0">${TURKISH}</p>
<a id="a" href="/hedef?q=1" style="position:absolute;left:10px;top:40px;display:block;width:100px;height:20px">bağlantı</a>
<a id="js" href="javascript:void 0" style="position:absolute;left:200px;top:40px;display:block;width:100px;height:20px">js</a>
<input id="i" style="position:absolute;left:10px;top:70px;width:300px" value="0123456789">
<textarea id="t" style="position:absolute;left:10px;top:110px;width:300px;height:60px">satır1</textarea>
<div id="ce" contenteditable style="position:absolute;left:10px;top:190px;width:300px;height:40px">düzen</div>
<input id="pw" type="password" value="${SECRET}" style="position:absolute;left:10px;top:250px">
<iframe id="f" srcdoc="<body style='margin:0'><p id=fp style='margin:0;height:20px'>çerçeve metni</p><a id=fa href='https://example.com/ic' style='display:block;width:100px;height:20px'>iç</a><input id=fi value=abcdef>" style="position:absolute;left:400px;top:10px;width:300px;height:100px;border:0"></iframe>
<p id="big" style="position:absolute;left:10px;top:300px;width:700px;height:20px;overflow:hidden;margin:0">${BIG}</p>
</body>`;

let root: string;
let dataDir: string;
let engine: EngineProc | undefined;
let site: http.Server;
let siteUrl: string;
let c: Client;
let projectId: string;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const profile = () => join(dataDir, defaults.browser.profilesDirName, projectId);

async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, what: string): Promise<T> {
  const start = Date.now();
  for (;;) {
    const last = await fn();
    if (ok(last)) return last;
    if (Date.now() - start > WAIT_MS) throw new Error(`timeout: ${what} (last: ${JSON.stringify(last)?.slice(0, 200)})`);
    await sleep(50);
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

const tabs = async () => (await c.req<{ browser: BrowserState }>("browser.tabs", { projectId })).browser;

/** What a second CDP client (an agent, or here: the test standing in for the user's hands) does in the page. */
async function pageEval<T>(expression: string): Promise<T> {
  const version = (await (await fetch(`http://127.0.0.1:${devtoolsPort()}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  const cdp = await connectCdp(version.webSocketDebuggerUrl, { timeoutMs: 15_000 });
  try {
    const { activeTabId } = await tabs();
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: activeTabId, flatten: true });
    const r = await cdp.send<{ result: { value: T }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(`page eval failed: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
    return r.result.value;
  } finally {
    cdp.close();
  }
}

const input = (event: Record<string, unknown>) => c.ws.send(JSON.stringify({ type: "browser.input", projectId, event }));
const copy = async (cut?: boolean) => (await c.req<{ text: string }>("browser.copy", { projectId, ...(cut ? { cut } : {}) })).text;
const paste = (text: string) => c.req("browser.paste", { projectId, text });
const context = (x: number, y: number) => c.req<BrowserContextInfo>("browser.context", { projectId, x, y });
const clearSelection = () => pageEval("(document.activeElement && document.activeElement.blur(), getSelection().removeAllRanges(), true)");

async function errorOf(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    return { code: String((e as { code?: string }).code), message: String((e as Error).message) };
  }
  return { code: "(no error)", message: "" };
}

async function click(x: number, y: number, clickCount = 1): Promise<void> {
  input({ type: "mouse", action: "move", x, y });
  for (let n = 1; n <= clickCount; n++) {
    input({ type: "mouse", action: "down", x, y, button: "left", clickCount: n });
    input({ type: "mouse", action: "up", x, y, button: "left", clickCount: n });
  }
}

beforeAll(async () => {
  if (!haveChrome) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-e2e-bclip-")));
  dataDir = join(root, "data");
  mkdirSync(join(root, "p"));
  const configPath = join(root, "engine.json");
  const cdpPortBase = 47000 + Math.floor(Math.random() * 20) * 100;
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
      browser: { headless: true, testMode: true, startTimeoutMs: 30000, cdpPortBase, cdpPortSpan: 100, clipboardMaxChars: CAP },
    }),
  );
  site = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(PAGE);
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", () => r()));
  siteUrl = `http://127.0.0.1:${(site.address() as net.AddressInfo).port}`;
  engine = await startEngine({ KOKPIT_CONFIG: configPath, KOKPIT_KEY: KEY });
  c = await Client.connect(engine.port, KEY);
  await c.req("settings.update", { defaultToolId: null });
  projectId = (await c.req<{ project: { id: string } }>("projects.create", { name: "Pano", location: { kind: "local", path: join(root, "p") } })).project.id;
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

describe.skipIf(!haveChrome)("Kopyalama: Tarayıcı sayfası ↔ pano, with a real Chrome", { timeout: 120_000 }, () => {
  it("the shipped cap is within the protocol's", () => {
    expect(defaults.browser.clipboardMaxChars).toBeGreaterThanOrEqual(10_000);
  });

  it("a closed browser has nothing to copy, paste into or ask about", async () => {
    expect((await errorOf(copy())).code).toBe("NOT_FOUND");
    expect((await errorOf(paste("x"))).code).toBe("NOT_FOUND");
    expect((await errorOf(context(1, 1))).code).toBe("NOT_FOUND");
  });

  it("nothing selected → nothing to copy", async () => {
    await c.req("browser.viewport.set", { projectId, ...PANEL });
    await c.req("browser.zoom.set", { projectId, zoom: 1 });
    await c.req("browser.open", { projectId });
    await c.req("browser.navigate", { projectId, url: `${siteUrl}/` });
    await until(async () => (await tabs()).tabs.find((t) => t.title === "pano"), (t) => t !== undefined, "page title");
    await until(() => pageEval<boolean>("!!document.getElementById('f').contentDocument.getElementById('fi')"), (v) => v, "iframe loaded");
    expect(await copy()).toBe("");
    expect(await context(400, 400)).toEqual({ hasSelection: false, editable: false });
  });

  it("copies the document's selection, Turkish letters intact", async () => {
    await pageEval("(getSelection().selectAllChildren(document.getElementById('p')), true)");
    expect(await copy()).toBe(TURKISH);
    expect((await context(400, 400)).hasSelection).toBe(true);
  });

  it("copies what the user selected with the mouse through the panel (double click = one word)", async () => {
    await clearSelection();
    await click(30, 20, 2);
    expect(await until(copy, (t) => t !== "", "word selected")).toBe("Merhaba");
  });

  it("copies the selected part of an input and of a textarea, not the whole field", async () => {
    await pageEval("(document.getElementById('i').focus(), document.getElementById('i').setSelectionRange(2, 6), true)");
    expect(await copy()).toBe("2345");
    await pageEval("(document.getElementById('t').focus(), document.getElementById('t').setSelectionRange(0, 5), true)");
    expect(await copy()).toBe("satır");
    // A caret without a selection copies nothing.
    await pageEval("(document.getElementById('i').focus(), document.getElementById('i').setSelectionRange(3, 3), true)");
    expect(await copy()).toBe("");
    expect((await context(400, 400)).editable).toBe(true);
  });

  it("a click into an empty field after selecting text elsewhere: the old selection is gone, nothing is copied", async () => {
    await pageEval("(document.activeElement.blur(), document.getElementById('i').value = '', getSelection().selectAllChildren(document.getElementById('p')), true)");
    expect(await copy()).toBe(TURKISH);
    await click(100, 80);
    await until(() => pageEval<string>("document.activeElement.id"), (id) => id === "i", "input focused by the click");
    expect(await copy()).toBe("");
    expect((await context(400, 400)).hasSelection).toBe(false);
    await pageEval("(document.getElementById('i').value = '0123456789', true)");
  });

  it("never copies out of a password field", async () => {
    await pageEval("(document.getElementById('pw').focus(), document.getElementById('pw').select(), true)");
    expect(await copy()).toBe("");
    expect(await copy(true)).toBe("");
    expect(await pageEval<string>("document.getElementById('pw').value")).toBe(SECRET);
    const info = await context(400, 400);
    expect(info.hasSelection).toBe(false);
    // Pasting INTO a password field is still possible.
    expect(info.editable).toBe(true);
  });

  it("copies a selection inside a same-origin frame (text and input)", async () => {
    await pageEval(`(() => { const f = document.getElementById('f'); f.focus(); const d = f.contentDocument; d.getSelection().selectAllChildren(d.getElementById('fp')); return true; })()`);
    expect(await copy()).toBe("çerçeve metni");
    await pageEval(`(() => { const d = document.getElementById('f').contentDocument; d.getElementById('fi').focus(); d.getElementById('fi').setSelectionRange(1, 4); return true; })()`);
    expect(await copy()).toBe("bcd");
  });

  it("cut = copy + the page loses an editable selection; a read-only selection is only copied", async () => {
    await pageEval("(document.getElementById('i').focus(), document.getElementById('i').setSelectionRange(2, 6), true)");
    expect(await copy(true)).toBe("2345");
    expect(await pageEval<string>("document.getElementById('i').value")).toBe("016789");
    await pageEval("(document.activeElement.blur(), getSelection().selectAllChildren(document.getElementById('p')), true)");
    expect(await copy(true)).toBe(TURKISH);
    expect(await pageEval<string>("document.getElementById('p').textContent")).toBe(TURKISH);
  });

  it("a selection over the cap is refused, not truncated; a refused cut removes nothing", async () => {
    await pageEval("(getSelection().selectAllChildren(document.getElementById('big')), true)");
    const err = await errorOf(copy());
    expect(err.code).toBe("INVALID");
    expect(err.message).toContain(String(CAP));
    expect(err.message).not.toContain("bbbb");
    await pageEval("(document.getElementById('t').value = 'k'.repeat(" + String(CAP + 1) + "), document.getElementById('t').focus(), document.getElementById('t').select(), true)");
    expect((await errorOf(copy(true))).code).toBe("INVALID");
    expect(await pageEval<number>("document.getElementById('t').value.length")).toBe(CAP + 1);
    await pageEval("(document.getElementById('t').value = 'satır1', true)");
  });

  it("pastes at the caret of an input the user clicked", async () => {
    await pageEval("(document.getElementById('i').value = '', true)");
    await click(100, 80);
    await until(() => pageEval<string>("document.activeElement.id"), (id) => id === "i", "input focused by the click");
    await paste("çğıöşü İ 😀");
    expect(await pageEval<string>("document.getElementById('i').value")).toBe("çğıöşü İ 😀");
    // In the middle, replacing a selection.
    await pageEval("(document.getElementById('i').setSelectionRange(1, 3), true)");
    await paste("XY");
    expect(await pageEval<string>("document.getElementById('i').value")).toBe("çXYöşü İ 😀");
  });

  it("a copied line with its line break pastes into a one-line input (the break is dropped, like a real paste)", async () => {
    await pageEval("(document.getElementById('i').value = '', document.getElementById('i').focus(), true)");
    await paste("tek satır çğ\n");
    expect(await pageEval<string>("document.getElementById('i').value")).toBe("tek satır çğ");
    await pageEval("(document.getElementById('i').value = '', true)");
    await paste("iki\r\nsatır\n");
    expect(await pageEval<string>("document.getElementById('i').value")).toBe("iki satır");
  });

  it("pastes several lines into a textarea", async () => {
    await pageEval("(document.getElementById('t').focus(), document.getElementById('t').setSelectionRange(6, 6), true)");
    await paste("\nsatır2\n\tgirinti");
    expect(await pageEval<string>("document.getElementById('t').value")).toBe("satır1\nsatır2\n\tgirinti");
  });

  it("pastes into a contenteditable", async () => {
    await click(100, 200);
    await until(() => pageEval<string>("document.activeElement.id"), (id) => id === "ce", "contenteditable focused by the click");
    await pageEval("(getSelection().selectAllChildren(document.getElementById('ce')), getSelection().collapseToEnd(), true)");
    await paste(` + ${PASTE_SECRET}`);
    expect(await pageEval<string>("document.getElementById('ce').textContent")).toBe(`düzen + ${PASTE_SECRET}`);
    const info = await context(400, 400);
    expect(info.editable).toBe(true);
  });

  it("refuses a paste over the cap and inserts nothing", async () => {
    await pageEval("(document.getElementById('i').value = '', document.getElementById('i').focus(), true)");
    const err = await errorOf(paste("z".repeat(CAP + 1)));
    expect(err.code).toBe("INVALID");
    expect(err.message).not.toContain("zzzz");
    expect(await pageEval<string>("document.getElementById('i').value")).toBe("");
    await paste("z".repeat(CAP));
    expect(await pageEval<number>("document.getElementById('i').value.length")).toBe(CAP);
  });

  it("the right-click menu learns the link under the pointer — http(s) only, also inside a frame", async () => {
    await clearSelection();
    expect(await context(50, 50)).toEqual({ hasSelection: false, editable: false, linkUrl: `${siteUrl}/hedef?q=1` });
    expect(await context(250, 50)).toEqual({ hasSelection: false, editable: false });
    expect(await context(700, 400)).toEqual({ hasSelection: false, editable: false });
    // The frame is at 400,10; its link is the second line (20 px lower).
    expect((await context(420, 40)).linkUrl).toBe("https://example.com/ic");
  });

  it("a page that lies about its selection can at worst change what is copied: oversized and odd answers are contained", async () => {
    await pageEval(`(document.getSelection = () => ({ toString: () => "${"q".repeat(50)}".repeat(1000) }), true)`);
    const err = await errorOf(copy());
    expect(err.code).toBe("INVALID");
    expect(err.message).not.toContain("qqqq");
    await pageEval("(document.getSelection = () => { throw new Error('hayır'); }, true)");
    expect((await errorOf(copy())).code).not.toBe("(no error)");
    // The connection and the browser are still fine.
    expect((await tabs()).running).toBe(true);
  });

  it("no selected or pasted text ever reached the engine's log", () => {
    const logs = engine!.logs();
    for (const secret of [SECRET, PASTE_SECRET, TURKISH, "çerçeve metni", "satır2", "2345"]) expect(logs, secret).not.toContain(secret);
  });
});
