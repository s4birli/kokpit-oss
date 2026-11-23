// Yollar: "open ~/Documents/Acme-ux-2026-11-05/index.html" — a local page a Claude Code session points at shows
// up in the project's Kokpit browser. Real engine + REAL headless Chrome (temp profile, mock keychain), a temp HOME
// with a small "report" (page + stylesheet + script + picture + sub-folder), and a FAKE `open` that only records
// its arguments: the user's /usr/bin/open, browser, Documents and running engine are never touched.
// Chrome itself is the witness: computed styles, the title a script set, the picture's size, what `fetch` may reach.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserState, FileLocation, FilePreviewUrl } from "@kokpit/shared";
import { FILES_PREVIEW_HTTP_PREFIX } from "@kokpit/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { connectCdp } from "../src/cdp.ts";
import { openMac, openRequestText } from "../src/terminal-open.ts";
import { HandshakeError, authenticate } from "../src/ws-auth-client.ts";
import { randomBytes } from "node:crypto";
import { Client, escapeRe, startEngine, stopEngine, type EngineProc } from "./harness.ts";

const KEY = randomBytes(32).toString("base64url");
const defaults = JSON.parse(readFileSync(new URL("../config.defaults.json", import.meta.url), "utf8")) as { browser: { chromePath: string } };
const haveChrome = existsSync(defaults.browser.chromePath);
const LOOPBACK = "127.0.0.1";
const WAIT_MS = 20_000;
const FAILURE_LOG_TAIL_CHARS = 6_000;
/** A 1×1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const SECRET = "GIZLI_ONIZLEME_4c1e";
const REPORT = "Acme-ux-2026-11-05";
const PREVIEW_URL = new RegExp(`^http://127\\.0\\.0\\.1:\\d+${escapeRe(FILES_PREVIEW_HTTP_PREFIX)}[A-Za-z0-9_-]{43}/`);

let root: string;
let home: string;
let engine: EngineProc | undefined;
let c: Client;
let site: http.Server;
let siteUrl: string;
const hits: string[] = [];
let fakeOpen: string;
let openedLog: string;
let nextMarker = 0;

function ourChromePids(): number[] {
  const out = execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" });
  return out
    .split("\n")
    .filter((l) => l.includes(root) && l.includes("--user-data-dir="))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function devtoolsPort(projectId: string): number {
  let port: number | undefined;
  for (const line of engine!.logs().split("\n")) {
    if (!line.includes('"chrome started"')) continue;
    try {
      const entry = JSON.parse(line) as { msg: string; projectId?: string; port?: number };
      if (entry.msg === "chrome started" && entry.projectId === projectId) port = entry.port;
    } catch {
      /* a partial line */
    }
  }
  if (port === undefined) throw new Error(`no chrome for ${projectId}`);
  return port;
}

const state = async (projectId: string): Promise<BrowserState> => (await c.req<{ browser: BrowserState }>("browser.tabs", { projectId })).browser;
const activeUrl = (s: BrowserState): string | undefined => s.tabs.find((t) => t.id === s.activeTabId)?.url;
/** Waits until the project's active tab is at an address matching `re`; returns that address. */
async function activeMatches(projectId: string, re: RegExp): Promise<string> {
  let last: string | undefined;
  await expect.poll(async () => re.test((last = activeUrl(await state(projectId)) ?? "")), { timeout: WAIT_MS, message: `active tab ~ ${re}` }).toBe(true);
  return last!;
}

/** Evaluates in the project's ACTIVE tab, asked from Chrome itself. */
async function pageEval<T>(projectId: string, expression: string): Promise<T> {
  const version = (await (await fetch(`http://${LOOPBACK}:${devtoolsPort(projectId)}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  const cdp = await connectCdp(version.webSocketDebuggerUrl, { timeoutMs: WAIT_MS });
  try {
    const { activeTabId } = await state(projectId);
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: activeTabId, flatten: true });
    const r = await cdp.send<{ result: { value: T }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(`page eval failed: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
    return r.result.value;
  } finally {
    cdp.close();
  }
}

const write = (path: string, content: string | Buffer): string => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
};

/** A report like the ones agents write: a page with relative assets and a sub-folder. `color` tells them apart. */
function report(dir: string, name: string, color: string): string {
  write(
    join(dir, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>yükleniyor</title><link rel="stylesheet" href="./style.css">` +
      `<body><h1 id="baslik">${name}</h1><img id="resim" src="img/a.png"><a id="alt" href="alt/sayfa.html">alt</a><script src="app.js"></script></body>`,
  );
  write(join(dir, "style.css"), `body { background-color: ${color}; } #baslik { font-size: 37px; }`);
  write(join(dir, "app.js"), `document.title = "betik çalıştı: ${name}";`);
  write(join(dir, "img", "a.png"), PNG);
  write(join(dir, "alt", "sayfa.html"), `<!doctype html><meta charset="utf-8"><title>alt sayfa</title><link rel="stylesheet" href="../style.css"><link rel="stylesheet" href="alt.css"><p id="p">alt</p>`);
  write(join(dir, "alt", "alt.css"), `#p { margin-left: 23px; }`);
  write(join(dir, "veri.json"), `{"ad":"${name}"}`);
  write(join(dir, ".env"), SECRET);
  return join(dir, "index.html");
}

async function project(name: string, extra: Record<string, unknown> = {}): Promise<string> {
  mkdirSync(join(root, "projeler", name), { recursive: true });
  return (await c.req<{ project: { id: string } }>("projects.create", { name, location: { kind: "local", path: join(root, "projeler", name) }, ...extra })).project.id;
}
/** What a parent Kokpit terminal would have handed the engine (fake values). */
const INHERITED = {
  KOKPIT_OPEN_ID: "inherited-open-id",
  KOKPIT_OPEN_KEY_IPAD: "inherited-ipad",
  KOKPIT_OPEN_ENDPOINT: "http://127.0.0.1:9/inherited",
  KOKPIT_SHIM_DIR: "/tmp/kokpit-inherited-shim",
  KOKPIT_TERMINAL_ID: "inherited-terminal",
  KOKPIT_PROJECT_ID: "inherited-project",
  KOKPIT_CARD_ID: "inherited-card",
  KOKPIT_CDP_URL: "http://127.0.0.1:9",
} as const;

async function terminal(projectId: string): Promise<string> {
  const { terminal: t } = await c.req<{ terminal: { id: string } }>("terminal.open", { projectId, cols: 200, rows: 30 });
  return t.id;
}
/** Types a command and waits until the shell finished it (a marker line printed after it). */
async function run(terminalId: string, command: string): Promise<string> {
  const marker = `BITTI_${++nextMarker}_`;
  // The marker is assembled by the shell, so the echoed command line itself never matches.
  c.input(terminalId, `${command}; printf '%s%s\\n' '${marker}' "$?"\r`);
  return c.waitForOutput(terminalId, new RegExp(`${marker}\\d+\\r?\\n`), WAIT_MS);
}
/** Argument lists the fake `open` was started with. */
function passedOn(): string[][] {
  if (!existsSync(openedLog)) return [];
  const lines = readFileSync(openedLog, "utf8").split("\n");
  const runs: string[][] = [];
  for (let i = 0; i < lines.length; i++) {
    const count = /^RUN (\d+)$/.exec(lines[i]!);
    if (!count) continue;
    runs.push(lines.slice(i + 1, i + 1 + Number(count[1])));
    i += Number(count[1]);
  }
  return runs;
}
const refusal = async (work: Promise<unknown>): Promise<{ code?: string; message: string } | undefined> =>
  work.then(
    () => undefined,
    (err: unknown) => ({ code: (err as { code?: string }).code, message: (err as Error).message }),
  );
const httpStatus = async (url: string): Promise<number> => (await fetch(url, { redirect: "manual" })).status;

beforeAll(async () => {
  if (!haveChrome) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-e2e-open-file-")));
  home = join(root, "home");
  openedLog = join(root, "opened.log");
  fakeOpen = write(join(root, "bin", "fake-open"), `#!/bin/sh\nprintf 'RUN %s\\n' "$#" >> '${openedLog}'\nfor a in "$@"; do printf '%s\\n' "$a" >> '${openedLog}'; done\n`);
  chmodSync(fakeOpen, 0o755);
  report(join(home, "Documents", REPORT), "Acme", "rgb(10, 20, 30)");
  report(join(home, "Documents", "ikinci rapor"), "ikinci", "rgb(40, 50, 60)");
  write(join(home, "Documents", "tek.html"), `<!doctype html><title>tek</title><script>fetch("komsu.txt").then((r) => (document.title = "komşu " + r.status), () => (document.title = "komşu yok"));</script>`);
  write(join(home, "Documents", "komsu.txt"), SECRET);
  write(join(home, "Movies", "resim.png"), PNG);
  write(join(home, "ev.html"), "<!doctype html>");
  write(join(home, ".ssh", "sayfa.html"), SECRET);
  write(join(home, "Library", "x", "index.html"), SECRET);
  write(join(root, "disarisi", "index.html"), SECRET);
  const configPath = join(root, "engine.json");
  const cdpPortBase = 53000 + Math.floor(Math.random() * 20) * 100;
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
      // Never the real open: what the shim hands on is only recorded.
      files: { open: { realOpenPath: fakeOpen } },
    }),
  );
  site = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><title>site ${req.url ?? ""}</title>`);
  });
  await new Promise<void>((r) => site.listen(0, LOOPBACK, () => r()));
  siteUrl = `http://${LOOPBACK}:${(site.address() as net.AddressInfo).port}`;
  // The engine runs as if started inside a Kokpit terminal (a developer's, a test runner's): that terminal's
  // variables and shim folder are in its environment and must reach none of ITS terminals.
  engine = await startEngine({
    KOKPIT_CONFIG: configPath,
    KOKPIT_KEY: KEY,
    HOME: home,
    ...INHERITED,
    PATH: `${INHERITED.KOKPIT_SHIM_DIR}:${process.env.PATH ?? ""}`,
  });
  c = await Client.connect(engine.port, KEY);
  await c.req("settings.update", { defaultToolId: null });
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

describe.skipIf(!haveChrome)("Yollar: yerel sayfa projenin Chrome'unda (gerçek Chrome)", { timeout: 180_000 }, () => {
  afterEach((ctx) => {
    if (ctx.task.result?.state !== "fail" || !engine) return;
    console.warn(`[e2e] "${ctx.task.name}" failed; engine log tail:\n${engine.logs().slice(-FAILURE_LOG_TAIL_CHARS)}`);
  });

  let first: string;
  let firstTerminal: string;
  let firstSite: string;

  it("the user's case: the report opens in the project's Chrome with its stylesheet, script, picture and sub-page", async () => {
    first = await project("ilk");
    firstTerminal = await terminal(first);
    expect((await state(first)).running).toBe(false);

    const located = await c.req<FileLocation>("files.locate", { terminalId: firstTerminal, path: `~/Documents/${REPORT}/index.html` });
    expect(located).toEqual({ path: join(home, "Documents", REPORT, "index.html"), kind: "page", browser: true });

    const opened = (await c.req<{ browser: BrowserState }>("browser.openFile", { terminalId: firstTerminal, path: `~/Documents/${REPORT}/index.html` })).browser;
    expect(opened.running).toBe(true);
    const url = await activeMatches(first, PREVIEW_URL);
    // Served by the engine's own listener — never file:.
    expect(url).toBe(`http://${LOOPBACK}:${engine!.port}${new URL(url).pathname}`);
    expect(url.endsWith("/index.html")).toBe(true);
    firstSite = url.slice(0, url.lastIndexOf("/"));
    // The blank tab of the Chrome this request started is not left behind.
    expect((await state(first)).tabs.map((t) => t.url)).toEqual([url]);

    await expect.poll(() => pageEval<string>(first, "document.title"), { timeout: WAIT_MS }).toBe("betik çalıştı: Acme");
    expect(await pageEval(first, "getComputedStyle(document.body).backgroundColor")).toBe("rgb(10, 20, 30)");
    expect(await pageEval(first, "getComputedStyle(document.getElementById('baslik')).fontSize")).toBe("37px");
    await expect.poll(() => pageEval<number>(first, "document.getElementById('resim').naturalWidth"), { timeout: WAIT_MS }).toBe(1);
    expect(await pageEval(first, "location.protocol")).toBe("http:");
    // Its own files are its to fetch…
    expect(await pageEval(first, "fetch('veri.json').then((r) => r.json()).then((j) => j.ad)")).toBe("Acme");

    // …and a link into the sub-folder works, with assets relative to that folder and to the one above.
    await pageEval(first, "document.getElementById('alt').click()");
    await activeMatches(first, /\/alt\/sayfa\.html$/);
    await expect.poll(() => pageEval<string>(first, "document.title"), { timeout: WAIT_MS }).toBe("alt sayfa");
    await expect.poll(() => pageEval<string>(first, "getComputedStyle(document.getElementById('p')).marginLeft"), { timeout: WAIT_MS }).toBe("23px");
    expect(await pageEval(first, "getComputedStyle(document.body).backgroundColor")).toBe("rgb(10, 20, 30)");
  });

  it("the page reaches nothing but its own folder: no dot files, no listing, nothing else of the engine", async () => {
    await c.req("browser.openFile", { terminalId: firstTerminal, path: `~/Documents/${REPORT}/index.html` });
    await activeMatches(first, /\/index\.html$/);
    await expect.poll(() => pageEval<string>(first, "document.title"), { timeout: WAIT_MS }).toBe("betik çalıştı: Acme");
    const status = (path: string) => pageEval<number | string>(first, `fetch(${JSON.stringify(path)}).then((r) => r.status, (e) => "engellendi: " + e.name)`);
    expect(await status(".env")).toBe(404);
    expect(await status("img/")).toBe(404);
    expect(await status("../tek.html")).toBe("engellendi: TypeError");
    // The policy keeps the page inside its own prefix: the engine's other routes are not even asked.
    expect(await status("/health")).toBe("engellendi: TypeError");
    expect(await status(`${siteUrl}/disari`)).toBe("engellendi: TypeError");
    expect(hits).not.toContain("/disari");
    // From outside the page: the same address space answers 404 for everything that is not the folder's.
    expect(await httpStatus(`${firstSite}/index.html`)).toBe(200);
    expect(await httpStatus(`${firstSite}/.env`)).toBe(404);
    expect(await httpStatus(`${firstSite}/%2e%2e/tek.html`)).toBe(404);
    expect(await httpStatus(`${firstSite}/..%2f..%2f.ssh/sayfa.html`)).toBe(404);
    expect(await httpStatus(`${firstSite}/alt/`)).toBe(404);
    const headers = (await fetch(`${firstSite}/index.html`)).headers;
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("cache-control")).toBe("no-store");
    expect(headers.get("referrer-policy")).toBe("no-referrer");
    expect(headers.get("access-control-allow-origin")).toBeNull();
    expect(headers.get("content-security-policy")).toContain(`connect-src ${firstSite}/;`);
  });

  it("refused folders and missing files open nothing", async () => {
    const before = (await state(first)).tabs.map((t) => t.url);
    for (const [path, code, text] of [
      ["~/.ssh/sayfa.html", "INVALID", "Gizli"],
      ["~/ev.html", "INVALID", "Ev klasörünün kendisi"],
      ["~/Library/x/index.html", "INVALID", "kapalı"],
      [join(root, "disarisi", "index.html"), "INVALID", "açık değil"],
      ["~/Documents/yok.html", "NOT_FOUND", "bulunamadı"],
      [`~/Documents/${REPORT}`, "INVALID", "önizlenemez"],
      ["/", "INVALID", "önizlenemez"],
      ["/dev/null", "INVALID", "Yalnız dosyalar"],
    ] as const) {
      const r = await refusal(c.req("browser.openFile", { terminalId: firstTerminal, path }));
      expect(r?.code, path).toBe(code);
      expect(r?.message, path).toContain(text);
    }
    expect((await state(first)).tabs.map((t) => t.url)).toEqual(before);
    // Shown as refused before anyone clicks.
    expect(await c.req<FileLocation>("files.locate", { terminalId: firstTerminal, path: "~/.ssh/sayfa.html" })).toMatchObject({ kind: "page", browser: false });
  });

  it("a relative path is looked for where the terminal's shell is", async () => {
    await run(firstTerminal, `cd '${join(home, "Documents")}'`);
    // The cached directory of a moment ago (the project folder) is not this one: asked again after the cache time.
    await expect
      .poll(async () => (await refusal(c.req<FileLocation>("files.locate", { terminalId: firstTerminal, path: `${REPORT}/style.css` }))) === undefined, { timeout: WAIT_MS })
      .toBe(true);
    expect(await c.req<FileLocation>("files.locate", { terminalId: firstTerminal, path: `${REPORT}/style.css` })).toMatchObject({ path: join(home, "Documents", REPORT, "style.css"), kind: "file", browser: true });
    // An unquoted path with a space, as a program would print it.
    expect(await c.req<FileLocation>("files.locate", { terminalId: firstTerminal, path: "./ikinci", tail: " rapor/index.html dosyası" })).toMatchObject({ path: join(home, "Documents", "ikinci rapor", "index.html"), kind: "page" });
    await run(firstTerminal, `cd '${join(root, "projeler", "ilk")}'`);
  });

  it("a file directly in Documents is served alone: its neighbours are not its assets", async () => {
    await c.req("browser.openFile", { terminalId: firstTerminal, path: "~/Documents/tek.html" });
    await activeMatches(first, /\/tek\.html$/);
    await expect.poll(() => pageEval<string>(first, "document.title"), { timeout: WAIT_MS }).toBe("komşu 404");
  });

  it("a picture outside the project opens in the browser too", async () => {
    expect(await c.req<FileLocation>("files.locate", { terminalId: firstTerminal, path: "~/Movies/resim.png" })).toMatchObject({ kind: "media", media: "image", browser: true });
    await c.req("browser.openFile", { terminalId: firstTerminal, path: "~/Movies/resim.png" });
    await activeMatches(first, /\/resim\.png$/);
    await expect.poll(() => pageEval<number>(first, "document.images[0] ? document.images[0].naturalWidth : 0"), { timeout: WAIT_MS }).toBe(1);
  });

  it("two previews are two sites: one page cannot read the other, and each project has its own address", async () => {
    const second = await project("ikinci");
    const secondTerminal = await terminal(second);
    await c.req("browser.openFile", { terminalId: secondTerminal, path: `~/Documents/ikinci rapor/index.html` });
    const secondUrl = await activeMatches(second, PREVIEW_URL);
    const secondSite = secondUrl.slice(0, secondUrl.lastIndexOf("/"));
    await expect.poll(() => pageEval<string>(second, "document.title"), { timeout: WAIT_MS }).toBe("betik çalıştı: ikinci");
    expect(await pageEval(second, "getComputedStyle(document.body).backgroundColor")).toBe("rgb(40, 50, 60)");
    expect(secondSite).not.toBe(firstSite);

    // Even knowing the other preview's address (it cannot: tokens are random, nothing lists them), the page's
    // policy does not let it fetch there, and a script from there does not load.
    const blocked = await pageEval<string>(second, `fetch(${JSON.stringify(`${firstSite}/veri.json`)}).then((r) => "okundu " + r.status, (e) => "engellendi: " + e.name)`);
    expect(blocked).toBe("engellendi: TypeError");
    // One site's address does not serve the other's folder.
    expect(await httpStatus(`${secondSite}/../${REPORT}/index.html`)).toBe(404);
    expect(await httpStatus(`${secondSite}/veri.json`)).toBe(200);

    // The same folder in another project gets an address of its own.
    await c.req("browser.openFile", { projectId: second, path: `~/Documents/${REPORT}/index.html` });
    const again = await activeMatches(second, /\/index\.html$/);
    expect(again.slice(0, again.lastIndexOf("/"))).not.toBe(firstSite);

    // Deleting the project ends its previews; the other project's go on.
    await c.req("projects.delete", { projectId: second });
    expect(await httpStatus(`${secondSite}/index.html`)).toBe(404);
    expect(await httpStatus(`${firstSite}/index.html`)).toBe(200);
  });

  it("a browser on the app's machine gets an address to join to the engine's; revoking ends it", async () => {
    const client = await project("istemci", { browser: { runOn: "client" } });
    expect((await refusal(c.req("browser.openFile", { projectId: client, path: `~/Documents/${REPORT}/index.html` })))?.code).toBe("INVALID");
    const url = await c.req<FilePreviewUrl>("files.previewUrl", { projectId: client, path: `~/Documents/${REPORT}/index.html` });
    expect(url.single).toBe(false);
    const full = `http://${LOOPBACK}:${engine!.port}${url.path}`;
    expect(await httpStatus(full)).toBe(200);
    await c.req("files.previewRevoke", { path: url.path });
    expect(await httpStatus(full)).toBe(404);
  });

  it("`open <address>` and `open <page>` typed in the terminal show up in the project's browser", async () => {
    const reveals = (): number => c.frames.filter((f) => f.type === "event" && f.name === "browser.reveal" && f.projectId === first).length;
    const before = reveals();
    const out = await run(firstTerminal, `open ${siteUrl}/kabuktan`);
    expect(out).not.toContain("kokpit:");
    await activeMatches(first, new RegExp(`^${escapeRe(siteUrl)}/kabuktan$`));
    await expect.poll(() => hits.includes("/kabuktan"), { timeout: WAIT_MS }).toBe(true);
    await expect.poll(reveals, { timeout: WAIT_MS }).toBe(before + 1);

    await run(firstTerminal, `open ~/Documents/${REPORT}/index.html`);
    const url = await activeMatches(first, PREVIEW_URL);
    expect(url.slice(0, url.lastIndexOf("/"))).toBe(firstSite);
    await expect.poll(() => pageEval<string>(first, "document.title"), { timeout: WAIT_MS }).toBe("betik çalıştı: Acme");
    await expect.poll(reveals, { timeout: WAIT_MS }).toBe(before + 2);
    // Neither went to the operating system's open.
    expect(passedOn()).toEqual([]);
  });

  it("everything else is the real open's, unchanged; a refused page says so and does NOT open the desktop browser", async () => {
    const tabs = (await state(first)).tabs.length;
    await run(firstTerminal, `open -a Safari ${siteUrl}/secenekli`);
    await run(firstTerminal, `open -R ~/Documents/${REPORT}/index.html`);
    await run(firstTerminal, `open ~/Documents/komsu.txt`);
    await run(firstTerminal, `open ~/Documents`);
    await run(firstTerminal, `open ${siteUrl}/bir ${siteUrl}/iki`);
    expect(passedOn()).toEqual([
      ["-a", "Safari", `${siteUrl}/secenekli`],
      ["-R", join(home, "Documents", REPORT, "index.html")],
      [join(home, "Documents", "komsu.txt")],
      [join(home, "Documents")],
      [`${siteUrl}/bir`, `${siteUrl}/iki`],
    ]);
    const refused = await run(firstTerminal, `open ~/.ssh/sayfa.html`);
    expect(refused).toContain(
      "kokpit: Kokpit tarayıcısında açılmadı (Gizli (noktayla başlayan) klasör ve dosyalar önizlenmez); masaüstü tarayıcısında da açılmadı (ayar: files.open.fallbackToSystemOpen).",
    );
    // files.open.fallbackToSystemOpen is off: nothing went to the engine Mac's desktop browser.
    expect(passedOn()).toHaveLength(5);
    expect((await state(first)).tabs.length).toBe(tabs);
    expect(hits.some((h) => h.includes("secenekli") || h === "/bir" || h === "/iki")).toBe(false);
  });

  it("the terminal's credential is good for that one thing, for its own project, while the terminal lives", async () => {
    const out = await run(firstTerminal, `printf 'ID=%s IPAD=%s END=%s\\n' "$KOKPIT_OPEN_ID" "$KOKPIT_OPEN_KEY_IPAD" "$KOKPIT_OPEN_ENDPOINT"`);
    const m = /ID=([0-9a-f-]{36}) IPAD=([0-9a-f]{128}) END=(http:\/\/127\.0\.0\.1:\d+\/terminal\/open)\r?\n/.exec(out);
    expect(m, "grant id, padded key and endpoint in the terminal's environment").not.toBeNull();
    const [, grantId, ipad, endpoint] = m!;
    // The terminal holds the key only pre-padded; HMAC with the padded block is HMAC with the key.
    const key = Buffer.from(Buffer.from(ipad!, "hex").map((b) => b ^ 0x36));
    /** A request as the shim signs it (fresh nonce, the current time). */
    const sign = (kind: string, target: string): string => {
      const ts = String(Math.floor(Date.now() / 1000));
      const nonce = randomBytes(16).toString("hex");
      return `${grantId}\n${ts}\n${nonce}\n${openMac(key, openRequestText(grantId!, ts, nonce, kind, target))}\n${kind}\n${target}`;
    };
    const post = (body: string, headers: Record<string, string> = {}) => fetch(endpoint!, { method: "POST", body, headers: { "content-type": "text/plain", ...headers } });
    // Not the engine's key: neither as the access key nor as a screen grant does it open a connection.
    for (const credential of [{ kind: "key" as const, key: key.toString("hex") }, { kind: "grant" as const, grantId: grantId!, token: key.toString("hex") }]) {
      const ws = new WebSocket(`ws://${LOOPBACK}:${engine!.port}`);
      const err = await authenticate(ws, credential).catch((e: unknown) => e);
      expect(err, credential.kind).toBeInstanceOf(HandshakeError);
      expect((err as HandshakeError).closeCode, credential.kind).toBe(4401);
    }
    // No other scheme, no application, no file that is not a page.
    for (const body of [sign("url", "file:///etc/hosts"), sign("url", "x-apple.systempreferences:x"), sign("file", "/Applications/Safari.app"), sign("file", join(home, "Documents", "komsu.txt"))]) {
      expect((await post(body)).status, body.split("\n").slice(4).join(" ")).toBe(422);
    }
    // A page it may not show.
    expect((await post(sign("file", join(home, ".ssh", "sayfa.html")))).status).toBe(409);
    expect((await post(sign("file", join(root, "disarisi", "index.html")))).status).toBe(409);
    // A web page cannot use it even if it had it (fetch sends Origin).
    expect((await post(sign("url", `${siteUrl}/sayfadan`), { origin: "http://evil.example" })).status).toBe(403);
    expect(hits).not.toContain("/sayfadan");

    // Turned off for the project: declined — the shim then runs the real open (the user's choice).
    await c.req("projects.update", { projectId: first, openInBrowser: false });
    expect((await post(sign("url", `${siteUrl}/kapaliyken`))).status).toBe(303);
    const off = await run(firstTerminal, `open ${siteUrl}/kapaliyken`);
    expect(off).toContain("kokpit: Kokpit tarayıcısında açılmadı (Bu projede open Kokpit tarayıcısına yönlendirilmiyor); sistemin open komutu kullanılıyor.");
    expect(passedOn().at(-1)).toEqual([`${siteUrl}/kapaliyken`]);
    // …and a new terminal of that project does not get the shim at all.
    const plain = await terminal(first);
    expect(await run(plain, `printf 'ID=[%s]\\n' "$KOKPIT_OPEN_ID"`)).toContain("ID=[]");
    // Nothing the engine inherited from a terminal of its own, nor the engine's access key: only its own two ids.
    const vars = await run(plain, `env | grep '^KOKPIT_' | cut -d= -f1 | sort | tr '\\n' ' '; printf '|PATH=%s|\\n' "$PATH"`);
    expect(vars).toMatch(/KOKPIT_PROJECT_ID KOKPIT_TERMINAL_ID \|PATH=/);
    expect(vars).not.toContain(INHERITED.KOKPIT_SHIM_DIR);
    await c.req("terminal.close", { terminalId: plain });
    await c.req("projects.update", { projectId: first, openInBrowser: true });
    expect((await post(sign("url", `${siteUrl}/yeniden-acik`))).status).toBe(200);

    // The terminal closes: its credential is gone.
    await c.req("terminal.close", { terminalId: firstTerminal });
    await expect.poll(async () => (await post(sign("url", `${siteUrl}/kapandiktan-sonra`))).status, { timeout: WAIT_MS }).toBe(401);
    expect(hits).not.toContain("/kapaliyken");
    expect(hits).not.toContain("/kapandiktan-sonra");
  });

  it("nothing secret reached the log, and the real open never ran", () => {
    const logs = engine!.logs();
    expect(logs).not.toContain(firstSite.slice(firstSite.lastIndexOf("/") + 1));
    expect(logs).not.toContain(SECRET);
    expect(logs).not.toContain("KOKPIT_OPEN_KEY");
    expect(logs).toContain('"preview opened"');
    expect(logs).toContain(`"root":"${REPORT}"`);
    for (const run of passedOn()) expect(run.join(" ")).not.toContain("kabuktan");
  });
});
