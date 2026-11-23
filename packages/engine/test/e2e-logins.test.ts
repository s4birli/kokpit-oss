// Girişler, end-to-end against the real engine, a REAL headless Chrome (temp profile, mock keychain) and a FAKE
// `security` tool (test/fakes/fake-security-setup.ts) — the real macOS Keychain is never touched:
// - logins.save → the password is in the (fake) Keychain only; logins.list returns metadata;
// - logins.fill fills the open page's username and password fields the way frameworks notice (plain form, React-style
//   controlled inputs, a form inside a same-origin frame), submits nothing, and reports field names only;
// - it refuses another origin (naming both sites), a sign-up form with two password fields, a page without fields
//   and fields inside a cross-origin frame; a page that redefines DOM functions or lies about its origin changes nothing;
// - the password is in no engine log line, no protocol frame, not in the state file and in no process's argv;
// - deleting the project deletes its Keychain items.
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginOriginOf, type BrowserState, type LoginPolicy, type SavedLogin } from "@kokpit/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectCdp } from "../src/cdp.ts";
import { installFakeSecurity, type FakeSecurity } from "./fakes/fake-security-setup.ts";
import { Client, startEngine, stopEngine, type EngineProc } from "./harness.ts";

const KEY = randomBytes(32).toString("base64url");
const WAIT_MS = 20_000;
const defaults = JSON.parse(readFileSync(new URL("../config.defaults.json", import.meta.url), "utf8")) as {
  browser: { chromePath: string; profilesDirName: string };
  logins: { secretPrefix: string };
};
const CHROME = defaults.browser.chromePath;
const haveChrome = existsSync(CHROME);
const PANEL = { width: 800, height: 500 };
const USER = "ayşe.kullanıcı@ornek.example";
const SECRET = "Gizli-parola çğıöşü \"'\\ <b>&amp; 😀 Zx9!";
const OTHER_USER = "ikinci-hesap";
const OTHER_SECRET = "ikinci-gizli-Qw7#";

const head = (title: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="margin:8px;font:14px sans-serif">`;
const LOGIN_FORM = (id: string) =>
  `<form id="${id}" onsubmit="window.__submitted=true;return false"><input name="q" type="hidden" value="x"><input name="user" type="text"><input name="pw" type="password"><button>Giriş</button></form>`;

const PAGES: Record<string, string> = {
  "/plain": `${head("düz")}<input id="search" type="text" placeholder="ara"><input type="password" id="tuzak" style="display:none">${LOGIN_FORM("f")}
<script>window.__events=[];for(const el of document.querySelectorAll("#f input"))for(const t of ["input","change"])el.addEventListener(t,(e)=>window.__events.push(el.name+":"+t+":"+e.isTrusted));</script>`,
  // What React does to a controlled input: it tracks the value through its own property on the node, ignores an
  // "input" event that did not change the tracked value, and writes its state back into the DOM after each event.
  "/react": `${head("react")}<div id="root"><input name="user" type="email"><input name="pw" type="password"></div>
<script>
const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
window.__state = { user: "", pw: "" };
const nodes = [...document.querySelectorAll("#root input")];
for (const node of nodes) {
  let tracked = desc.get.call(node);
  Object.defineProperty(node, "value", { configurable: true, get() { return desc.get.call(this); }, set(v) { tracked = "" + v; desc.set.call(this, v); } });
  node.__tracker = { get: () => tracked, set: (v) => { tracked = v; } };
}
const render = () => { for (const node of nodes) if (desc.get.call(node) !== window.__state[node.name]) node.value = window.__state[node.name]; };
document.addEventListener("input", (e) => {
  const node = e.target, actual = desc.get.call(node);
  if (node.__tracker.get() !== actual) { node.__tracker.set(actual); window.__state = { ...window.__state, [node.name]: actual }; }
  render();
});
setInterval(render, 20);
</script>`,
  "/frame": `${head("çerçeve")}<p>dış sayfa</p><iframe id="fr" src="/plain" style="width:600px;height:200px"></iframe>`,
  "/signup": `${head("kayıt")}<form id="s" onsubmit="window.__submitted=true;return false"><input name="user" type="text"><input name="pw" type="password" autocomplete="new-password"><input name="pw2" type="password" autocomplete="new-password"><button>Kaydol</button></form>`,
  "/both": `${head("ikisi")}<form id="s"><input name="user" type="text"><input name="pw" type="password"><input name="pw2" type="password"></form>${LOGIN_FORM("f")}`,
  "/nofields": `${head("alansız")}<p>Burada form yok.</p><input type="text" id="search" placeholder="ara">`,
  "/twostep": `${head("iki adım")}<form id="t"><input name="q" type="text"><input name="email" type="email" autocomplete="username"><button>İleri</button></form>`,
  "/two": `${head("iki form")}${LOGIN_FORM("a")}${LOGIN_FORM("b")}`,
  // A hostile page: it redefines what a fill would call, and claims to be another origin.
  "/tamper": `${head("oyunbozan")}${LOGIN_FORM("f")}
<script>
window.__stolen = [];
const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
Object.defineProperty(HTMLInputElement.prototype, "value", { configurable: true, get() { return d.get.call(this); }, set(v) { window.__stolen.push("setter"); d.set.call(this, "ELE-GEÇİRİLDİ"); } });
Document.prototype.querySelectorAll = () => { window.__stolen.push("qsa"); return []; };
Object.getOwnPropertyDescriptor = () => { window.__stolen.push("gopd"); return { set() {} }; };
window.InputEvent = function () { window.__stolen.push("event"); throw new Error("hayır"); };
</script>`,
};

let root: string;
let dataDir: string;
let engine: EngineProc | undefined;
let fake: FakeSecurity;
let site: http.Server;
let other: http.Server;
let siteUrl: string;
let otherUrl: string;
let origin: string;
let c: Client;
let projectId: string;
let secondProjectId: string;
let login: SavedLogin;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const profile = () => join(dataDir, defaults.browser.profilesDirName, projectId);
const storedForms = (secret: string) => [secret, JSON.stringify(secret).slice(1, -1), `${defaults.logins.secretPrefix}${Buffer.from(secret, "utf8").toString("base64url")}`, Buffer.from(secret, "utf8").toString("base64")];

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

/** What a second CDP client sees in the page's own (main) world — an agent attached to the same Chrome. */
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

async function open(url: string, title: string): Promise<void> {
  await c.req("browser.navigate", { projectId, url });
  await until(async () => (await tabs()).tabs.find((t) => t.id !== undefined && t.title === title && t.url === url), (t) => t !== undefined, `page ${title}`);
  await until(() => pageEval<string>("document.readyState"), (s) => s === "complete", "page loaded");
}

const fill = (id = login.id, project = projectId) => c.req<{ filled: string[] }>("logins.fill", { projectId: project, id });
const values = (formSel: string, doc = "document") =>
  pageEval<Record<string, string>>(`Object.fromEntries([...${doc}.querySelectorAll(${JSON.stringify(`${formSel} input`)})].map((el) => [el.name || el.id, el.value]))`);

async function errorOf(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    return { code: String((e as { code?: string }).code), message: String((e as Error).message) };
  }
  return { code: "(no error)", message: "" };
}

function serve(): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const body = path === "/cross" ? `${head("çapraz")}<p>dış sayfa</p><iframe id="fr" src="${otherUrl}/plain" style="width:600px;height:200px"></iframe>` : PAGES[path];
    res.statusCode = body === undefined ? 404 : 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(body ?? "yok");
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}` })));
}

beforeAll(async () => {
  if (!haveChrome) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-e2e-logins-")));
  dataDir = join(root, "data");
  mkdirSync(join(root, "p"));
  mkdirSync(join(root, "p2"));
  fake = installFakeSecurity(root);
  const configPath = join(root, "engine.json");
  const cdpPortBase = 44000 + Math.floor(Math.random() * 20) * 100;
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
      logins: { securityPath: fake.path, env: fake.env, envPassthrough: [], timeoutMs: 5000, fillRateMax: 1000 },
    }),
  );
  ({ server: site, url: siteUrl } = await serve());
  ({ server: other, url: otherUrl } = await serve());
  origin = loginOriginOf(siteUrl)!;
  engine = await startEngine({ KOKPIT_CONFIG: configPath, KOKPIT_KEY: KEY });
  c = await Client.connect(engine.port, KEY);
  await c.req("settings.update", { defaultToolId: null });
  projectId = (await c.req<{ project: { id: string } }>("projects.create", { name: "Girişler", location: { kind: "local", path: join(root, "p") } })).project.id;
  secondProjectId = (await c.req<{ project: { id: string } }>("projects.create", { name: "Başka proje", location: { kind: "local", path: join(root, "p2") } })).project.id;
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
  await new Promise<void>((r) => other?.close(() => r()));
  rmSync(root, { recursive: true, force: true });
}, 60_000);

describe.skipIf(!haveChrome)("Girişler: kaydet → doldur, with a real Chrome and a fake Keychain", { timeout: 120_000 }, () => {
  it("nothing can be saved while the project's browser is closed", async () => {
    expect((await errorOf(c.req("logins.save", { projectId, origin, username: USER, password: SECRET }))).code).toBe("NOT_FOUND");
    expect(fake.runs()).toEqual([]);
  });

  it("a login is saved only for the site that is open: another origin is refused naming both, whatever the client says", async () => {
    await c.req("browser.viewport.set", { projectId, ...PANEL });
    await c.req("browser.zoom.set", { projectId, zoom: 1 });
    await c.req("browser.open", { projectId });
    await open(`${otherUrl}/plain`, "düz");
    const err = await errorOf(c.req("logins.save", { projectId, origin, username: USER, password: SECRET }));
    expect(err.code).toBe("INVALID");
    expect(err.message).toContain(origin);
    expect(err.message).toContain(loginOriginOf(otherUrl)!);
    for (const bad of [`${origin}/`, `${origin}/plain`, origin.replace("http://", "http://kullanici:parola@"), origin.replace("http:", "ftp:"), "null"]) {
      expect((await errorOf(c.req("logins.save", { projectId, origin: bad, username: USER, password: SECRET }))).code, bad).toBe("INVALID");
    }
    expect(fake.runs()).toEqual([]);
    expect((await c.req<{ logins: SavedLogin[] }>("logins.list", { projectId })).logins).toEqual([]);
  });

  it("saves a login: the password goes to the Keychain, the answer and the list hold metadata only", async () => {
    await open(`${siteUrl}/plain`, "düz");
    const saved = await c.req<{ login: SavedLogin }>("logins.save", { projectId, origin, username: USER, password: SECRET, label: "İş hesabı" });
    login = saved.login;
    expect(login).toMatchObject({ projectId, origin, username: USER, label: "İş hesabı" });
    expect(Object.keys(login).sort()).toEqual(["createdAt", "id", "label", "origin", "projectId", "updatedAt", "username"]);
    const listed = await c.req<{ logins: SavedLogin[]; policy: LoginPolicy }>("logins.list", { projectId });
    expect(listed.logins).toEqual([login]);
    expect(listed.policy).toEqual({ keychainAccess: "confirm", agentRiskAccepted: false, agentsPresent: false });
    expect((await c.req<{ logins: SavedLogin[] }>("logins.list", { projectId: secondProjectId })).logins).toEqual([]);
    const key = `dev.kokpit.login.${projectId}\n${login.id}`;
    expect(Object.keys(fake.items())).toEqual([key]);
    // The default policy: nobody — not even the tool that created it — may read the item without the user's click.
    expect(fake.trusted()).toEqual({ [key]: "nobody" });
    expect(fake.commands().at(-1)).toEqual(["add-generic-password", "-a", login.id, "-s", `dev.kokpit.login.${projectId}`, "-w", "<secret>", "-T", ""]);
  });

  it("the ENGINE refuses a fill until the user accepted the agent risk for the project", async () => {
    const runsBefore = fake.runs().length;
    const err = await errorOf(fill());
    expect(err.code).toBe("LOGIN_RISK_UNACCEPTED");
    expect(err.message).toMatch(/ajanlar da sürebiliyor/);
    expect(fake.runs().length).toBe(runsBefore);
    expect(await values("#f")).toEqual({ q: "x", user: "", pw: "" });
    expect((await c.req<{ policy: LoginPolicy }>("logins.risk.set", { projectId, accepted: true })).policy.agentRiskAccepted).toBe(true);
  });

  it("fills a plain form: username and password, events fired, nothing submitted, hidden and unrelated fields untouched", async () => {
    expect(await fill()).toEqual({ filled: ["username", "password"] });
    expect(await values("#f")).toEqual({ q: "x", user: USER, pw: SECRET });
    expect(await pageEval<string[]>("window.__events")).toEqual(["user:input:false", "user:change:false", "pw:input:false", "pw:change:false"]);
    expect(await pageEval<unknown>("window.__submitted")).toBeUndefined();
    expect(await pageEval<string>("document.getElementById('search').value")).toBe("");
    expect(await pageEval<string>("document.getElementById('tuzak').value")).toBe("");
  });

  it("filling again replaces what is in the fields", async () => {
    await pageEval("(document.querySelector('#f [name=user]').value = 'eski', document.querySelector('#f [name=pw]').value = 'eski-parola', true)");
    expect(await fill()).toEqual({ filled: ["username", "password"] });
    expect(await values("#f")).toEqual({ q: "x", user: USER, pw: SECRET });
  });

  it("React-style controlled inputs keep the values (the framework's state has them)", async () => {
    await open(`${siteUrl}/react`, "react");
    expect(await fill()).toEqual({ filled: ["username", "password"] });
    await sleep(150); // several re-renders later
    expect(await pageEval<unknown>("window.__state")).toEqual({ user: USER, pw: SECRET });
    expect(await values("#root")).toEqual({ user: USER, pw: SECRET });
  });

  it("a form inside a same-origin frame is filled", async () => {
    await open(`${siteUrl}/frame`, "çerçeve");
    await until(() => pageEval<boolean>("!!document.getElementById('fr').contentDocument?.querySelector('#f [name=pw]')"), (v) => v, "frame loaded");
    expect(await fill()).toEqual({ filled: ["username", "password"] });
    expect(await values("#f", "document.getElementById('fr').contentDocument")).toEqual({ q: "x", user: USER, pw: SECRET });
  });

  it("a form inside a CROSS-origin frame is not reached: says so, fills nothing", async () => {
    await open(`${siteUrl}/cross`, "çapraz");
    await sleep(500);
    const err = await errorOf(fill());
    expect(err.code).toBe("INVALID");
    expect(err.message).toMatch(/Başka kökenli çerçeve/);
  });

  it("another origin is refused, naming both sites; the Keychain is not read and the page is untouched", async () => {
    await open(`${otherUrl}/plain`, "düz");
    const runsBefore = fake.runs().length;
    const err = await errorOf(fill());
    expect(err.code).toBe("INVALID");
    expect(err.message).toContain(origin);
    expect(err.message).toContain(loginOriginOf(otherUrl)!);
    expect(fake.runs().length).toBe(runsBefore);
    expect(await values("#f")).toEqual({ q: "x", user: "", pw: "" });
    // The same host under another name is another origin too.
    await open(`${siteUrl.replace("127.0.0.1", "localhost")}/plain`, "düz");
    expect((await errorOf(fill())).code).toBe("INVALID");
    expect(await values("#f")).toEqual({ q: "x", user: "", pw: "" });
  });

  it("the active tab changes after the app drew its list: the engine looks at the tab that is active NOW", async () => {
    await open(`${siteUrl}/plain`, "düz");
    const first = (await tabs()).activeTabId!;
    const after = (await c.req<{ browser: BrowserState }>("browser.newTab", { projectId, url: `${otherUrl}/plain` })).browser;
    expect(after.activeTabId).not.toBe(first);
    await until(async () => (await tabs()).tabs.find((t) => t.id === after.activeTabId)?.url, (u) => u === `${otherUrl}/plain`, "new tab loaded");
    await until(() => pageEval<string>("document.readyState"), (st) => st === "complete", "new tab ready");
    const err = await errorOf(fill());
    expect(err.code).toBe("INVALID");
    expect(err.message).toContain(loginOriginOf(otherUrl)!);
    expect(await values("#f")).toEqual({ q: "x", user: "", pw: "" });
    await c.req("browser.closeTab", { projectId, tabId: after.activeTabId! });
    await until(async () => (await tabs()).activeTabId, (id) => id === first, "back on the first tab");
    expect(await fill()).toEqual({ filled: ["username", "password"] });
  });

  it("the page navigates away between the app's click and the engine's fill: the other site never gets the values", async () => {
    await open(`${siteUrl}/plain`, "düz");
    // An agent (or a redirect) sends the tab elsewhere; the app's list still shows 'Doldur' for the old site.
    await pageEval(`(setTimeout(() => { location.href = ${JSON.stringify(`${otherUrl}/plain`)}; }, 0), true)`);
    const outcome = await fill().then(
      () => "filled-before-leaving",
      (e: { code?: string }) => String(e.code),
    );
    // Either the old document was still there (its own site: fine) or the engine refused. Never the new site.
    expect(["filled-before-leaving", "INVALID"]).toContain(outcome);
    await until(async () => (await tabs()).tabs.find((t) => t.url === `${otherUrl}/plain`), (t) => t !== undefined, "arrived at the other site");
    await until(() => pageEval<string>("document.readyState"), (st) => st === "complete", "other site ready");
    expect(await pageEval<string>("location.origin")).toBe(loginOriginOf(otherUrl)!);
    expect(await values("#f")).toEqual({ q: "x", user: "", pw: "" });
    expect((await errorOf(fill())).code).toBe("INVALID");
    expect(await values("#f")).toEqual({ q: "x", user: "", pw: "" });
  });

  it("while a project terminal (which knows the browser's DevTools address) runs, every fill needs a fresh confirmation", async () => {
    await open(`${siteUrl}/plain`, "düz");
    const terminal = (await c.req<{ terminal: { id: string } }>("terminal.open", { projectId, cols: 80, rows: 24 })).terminal;
    expect((await c.req<{ policy: LoginPolicy }>("logins.list", { projectId })).policy.agentsPresent).toBe(true);
    const err = await errorOf(fill());
    expect(err.code).toBe("LOGIN_RISK_UNACCEPTED");
    expect(await values("#f")).toEqual({ q: "x", user: "", pw: "" });
    expect(await c.req("logins.fill", { projectId, id: login.id, confirmAgentRisk: true })).toEqual({ filled: ["username", "password"] });
    expect((await errorOf(fill())).code).toBe("LOGIN_RISK_UNACCEPTED");
    await c.req("terminal.close", { terminalId: terminal.id });
    expect((await c.req<{ policy: LoginPolicy }>("logins.list", { projectId })).policy.agentsPresent).toBe(false);
    expect(await fill()).toEqual({ filled: ["username", "password"] });
  });

  it("what CDP lets one client know about ANOTHER client: nothing — which is why the engine asks instead of cutting agents off", async () => {
    const version = (await (await fetch(`http://127.0.0.1:${devtoolsPort()}/json/version`)).json()) as { webSocketDebuggerUrl: string };
    const watcher = await connectCdp(version.webSocketDebuggerUrl, { timeoutMs: 15_000 });
    const agent = await connectCdp(version.webSocketDebuggerUrl, { timeoutMs: 15_000 });
    try {
      const events: string[] = [];
      watcher.on((method) => void events.push(method));
      await watcher.send("Target.setDiscoverTargets", { discover: true });
      const { activeTabId } = await tabs();
      type Info = { targetInfos: { targetId: string; attached: boolean }[] };
      const before = (await watcher.send<Info>("Target.getTargets")).targetInfos.find((t) => t.targetId === activeTabId)!;
      // `attached` is already true: the engine's own session is attached (it streams the page).
      expect(before.attached).toBe(true);
      events.length = 0;
      // A second client — what an agent's Playwright does — attaches to the same page and reads the form.
      const { sessionId } = await agent.send<{ sessionId: string }>("Target.attachToTarget", { targetId: activeTabId, flatten: true });
      const read = await agent.send<{ result: { value: string } }>("Runtime.evaluate", { expression: "document.forms.f.elements.pw.value", returnByValue: true }, sessionId);
      expect(read.result.value).toBe(SECRET); // the residual risk, demonstrated: a filled password is readable
      await sleep(300);
      const after = (await watcher.send<Info>("Target.getTargets")).targetInfos.find((t) => t.targetId === activeTabId)!;
      expect(after.attached).toBe(true); // unchanged: no count, no identity
      // No event told the first client that somebody else attached.
      expect(events.filter((m) => m === "Target.attachedToTarget")).toEqual([]);
    } finally {
      watcher.close();
      agent.close();
    }
  });

  it("a page that claims the saved origin in its own scripts is still another origin", async () => {
    await open(`${otherUrl}/plain`, "düz");
    await pageEval(`(window.origin = ${JSON.stringify(origin)}, self.origin === ${JSON.stringify(origin)})`);
    const err = await errorOf(fill());
    expect(err.code).toBe("INVALID");
    expect(await values("#f")).toEqual({ q: "x", user: "", pw: "" });
  });

  it("a sign-up form (two password fields) is ambiguous: nothing is filled until the user clicks a field", async () => {
    await open(`${siteUrl}/signup`, "kayıt");
    const err = await errorOf(fill());
    expect(err.code).toBe("INVALID");
    expect(err.message).toMatch(/birden çok parola alanı/);
    expect(await values("#s")).toEqual({ user: "", pw: "", pw2: "" });
    // Focused field first: the user clicked the first password field.
    await pageEval("(document.querySelector('#s [name=pw]').focus(), true)");
    expect(await fill()).toEqual({ filled: ["username", "password"] });
    expect(await values("#s")).toEqual({ user: USER, pw: SECRET, pw2: "" });
    expect(await pageEval<unknown>("window.__submitted")).toBeUndefined();
  });

  it("a page with a sign-up form and a login form: the login form is filled", async () => {
    await open(`${siteUrl}/both`, "ikisi");
    expect(await fill()).toEqual({ filled: ["username", "password"] });
    expect(await values("#s")).toEqual({ user: "", pw: "", pw2: "" });
    expect(await values("#f")).toEqual({ q: "x", user: USER, pw: SECRET });
  });

  it("two login forms: the first by default, the one holding the focus when there is one", async () => {
    await open(`${siteUrl}/two`, "iki form");
    await fill();
    expect(await values("#a")).toEqual({ q: "x", user: USER, pw: SECRET });
    expect(await values("#b")).toEqual({ q: "x", user: "", pw: "" });
    await open(`${siteUrl}/two`, "iki form");
    await pageEval("(document.querySelector('#b [name=user]').focus(), true)");
    await fill();
    expect(await values("#a")).toEqual({ q: "x", user: "", pw: "" });
    expect(await values("#b")).toEqual({ q: "x", user: USER, pw: SECRET });
  });

  it("a page without fields: says so; a search box is not a username field", async () => {
    await open(`${siteUrl}/nofields`, "alansız");
    const err = await errorOf(fill());
    expect(err.code).toBe("INVALID");
    expect(err.message).toMatch(/bulunamadı/);
    await pageEval("(document.getElementById('search').focus(), true)");
    expect((await errorOf(fill())).code).toBe("INVALID");
    expect(await pageEval<string>("document.getElementById('search').value")).toBe("");
  });

  it("first step of a two-step login: only the username field is filled and reported", async () => {
    await open(`${siteUrl}/twostep`, "iki adım");
    expect(await fill()).toEqual({ filled: ["username"] });
    expect(await values("#t")).toEqual({ q: "", email: USER });
  });

  it("a hostile page that redefines DOM functions neither breaks nor intercepts the fill", async () => {
    await open(`${siteUrl}/tamper`, "oyunbozan");
    expect(await fill()).toEqual({ filled: ["username", "password"] });
    expect(await pageEval<string[]>("window.__stolen")).toEqual([]);
    // (the page broke its own querySelectorAll: read the fields through the form)
    expect(await pageEval<string[]>("[document.forms.f.elements.user.value, document.forms.f.elements.pw.value]")).toEqual([USER, SECRET]);
  });

  it("a login of this project cannot be filled through another project", async () => {
    expect((await errorOf(fill(login.id, secondProjectId))).code).toBe("NOT_FOUND");
  });

  it("the second login of the same site is its own item; each fills its own values", async () => {
    await open(`${siteUrl}/plain`, "düz");
    const second = (await c.req<{ login: SavedLogin }>("logins.save", { projectId, origin, username: OTHER_USER, password: OTHER_SECRET })).login;
    expect(second.id).not.toBe(login.id);
    expect(await fill(second.id)).toEqual({ filled: ["username", "password"] });
    expect(await values("#f")).toEqual({ q: "x", user: OTHER_USER, pw: OTHER_SECRET });
    await fill();
    expect(await values("#f")).toEqual({ q: "x", user: USER, pw: SECRET });
    await c.req("logins.delete", { id: second.id });
    expect((await errorOf(fill(second.id))).code).toBe("NOT_FOUND");
    expect(Object.keys(fake.items())).toEqual([`dev.kokpit.login.${projectId}\n${login.id}`]);
  });

  it("a locked Keychain: a clear message, the page stays as it is; working again afterwards", async () => {
    await pageEval("(document.querySelector('#f [name=user]').value = '', document.querySelector('#f [name=pw]').value = '', true)");
    fake.mode("locked");
    const err = await errorOf(fill());
    expect(err.code).toBe("KEYCHAIN_FAILED");
    expect(err.message).toMatch(/ekranında/);
    expect(await values("#f")).toEqual({ q: "x", user: "", pw: "" });
    fake.mode("ok");
    expect(await fill()).toEqual({ filled: ["username", "password"] });
  });

  it("the password is in no engine log line, no frame the client received, not in the state file and in no argv", async () => {
    await c.req("logins.save", { projectId, origin, username: USER, password: SECRET, nope: 1 }).catch(() => {});
    expect(fake.commands().flat()).not.toContain(SECRET);
    const places: Record<string, string> = {
      "engine log": engine!.logs(),
      "frames to the client": c.raw.join("\n"),
      "state file": readFileSync(join(dataDir, "state.json"), "utf8"),
      "security argv + env": fake.runLog(),
    };
    for (const [where, text] of Object.entries(places)) {
      for (const secret of [SECRET, OTHER_SECRET]) for (const form of storedForms(secret)) expect(text.includes(form), `${where}: ${form.slice(0, 12)}…`).toBe(false);
    }
    // Usernames are personal data: in the state (and sent to the app), never in the log.
    expect(places["engine log"]).not.toContain(USER);
    expect(places["engine log"]).not.toContain(OTHER_USER);
    expect(places["state file"]).toContain(USER);
    expect(fake.runs().filter((r) => r.argv[0] === "-i").length).toBeGreaterThanOrEqual(2);
    expect(fake.runs().every((r) => r.env.KOKPIT_KEY === undefined)).toBe(true);
  });

  it("deleting the project deletes its Keychain items; another project's stay", async () => {
    await c.req("browser.open", { projectId: secondProjectId });
    await c.req("browser.navigate", { projectId: secondProjectId, url: `${siteUrl}/plain` });
    await until(async () => (await c.req<{ browser: BrowserState }>("browser.tabs", { projectId: secondProjectId })).browser.tabs.find((t) => t.title === "düz"), (t) => t !== undefined, "second project's page");
    const keep = await until(
      () => c.req<{ login: SavedLogin }>("logins.save", { projectId: secondProjectId, origin, username: USER, password: OTHER_SECRET }).then((r) => r.login, () => undefined),
      (l) => l !== undefined,
      "save in the second project",
    ) as SavedLogin;
    await c.req("projects.delete", { projectId });
    await until(() => Object.keys(fake.items()), (k) => k.length === 1, "keychain items of the deleted project gone");
    expect(Object.keys(fake.items())).toEqual([`dev.kokpit.login.${secondProjectId}\n${keep.id}`]);
    expect((await c.req<{ logins: SavedLogin[] }>("logins.list", { projectId: secondProjectId })).logins).toEqual([keep]);
    expect(readFileSync(join(dataDir, "state.json"), "utf8")).not.toContain(login.id);
  });
});
