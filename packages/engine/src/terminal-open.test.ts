// Yollar — `open` in a Kokpit terminal: the per-terminal credential, the one HTTP route it is good for, and the shim
// script itself (wrappers/bin/open) run with a FAKE `open` that only records its arguments. The user's real
// /usr/bin/open is never started here.
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "@kokpit/shared";
import { EngineError } from "./contracts.ts";
import { loadFilesConfig, type FilesConfig } from "./files.ts";
import { createTerminalOpen, OPEN_ENV, OpenDeclinedError, replayCapacity, openMac, openReplyText, openRequestText, projectUsesOpenShim, TERMINAL_OPEN_HTTP_PATH, type OpenActions, type OpenGrant, type TerminalOpenService } from "./terminal-open.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { FakeLogger } from "../test/fakes/server-fakes.ts";

const ENGINE_DIR = fileURLToPath(new URL("..", import.meta.url));
const SHIM = join(ENGINE_DIR, "wrappers", "bin", "open");
const local = (id: string, extra: Partial<Project> = {}): Project => ({ id, name: id, location: { kind: "local", path: "/p" }, ...extra });

let base: string;
let fakeOpen: string;
let opened: string;
let server: http.Server;
let port: number;
let clock = Date.now();
let logger: FakeLogger;
let service: TerminalOpenService;
/** What the engine was asked to show. */
let shown: { grant: OpenGrant; kind: "url" | "file"; target: string }[] = [];
let fail: EngineError | Error | undefined;
const actions: OpenActions = {
  async url(grant, url) {
    if (fail) throw fail;
    shown.push({ grant, kind: "url", target: url });
  },
  async file(grant, path) {
    if (fail) throw fail;
    shown.push({ grant, kind: "file", target: path });
  },
};

function build(overrides: Partial<FilesConfig["open"]> = {}, deps: { shell?: string; env?: NodeJS.ProcessEnv; userZdotdir?: string; listening?: boolean } = {}): void {
  logger = new FakeLogger();
  service = createTerminalOpen({
    config: loadFilesConfig({ open: { realOpenPath: fakeOpen, ...overrides } }).open,
    engineDir: ENGINE_DIR,
    shell: deps.shell ?? "/bin/sh",
    userZdotdir: deps.userZdotdir,
    env: deps.env ?? { PATH: "/usr/bin:/bin" },
    endpoint: () => (deps.listening === false ? undefined : { host: "127.0.0.1", port }),
    logger,
    now: () => clock,
  });
}

interface Res {
  status: number;
  body: string;
}

/** What a terminal holds: the grant id and its key (recovered from the pre-padded half, as HMAC would use it). */
interface Cred {
  id: string;
  key: Buffer;
}
const credOf = (env: Record<string, string>): Cred => ({ id: env[OPEN_ENV.id]!, key: Buffer.from(Buffer.from(env[OPEN_ENV.ipad]!, "hex").map((b) => b ^ 0x36)) });
/** A request body as the shim makes it; `over` forges parts of it. */
function body(c: Cred, kind: string, target: string, over: { ts?: string; nonce?: string; mac?: string } = {}): string {
  const ts = over.ts ?? String(Math.floor(clock / 1000));
  const nonce = over.nonce ?? randomBytes(16).toString("hex");
  const mac = over.mac ?? openMac(c.key, openRequestText(c.id, ts, nonce, kind, target));
  return `${c.id}\n${ts}\n${nonce}\n${mac}\n${kind}\n${target}`;
}
/** The reply's message line (the first line is the engine's MAC). */
const msg = (r: Res): string => r.body.split("\n")[1] ?? "";
function post(body: string, opts: { path?: string; method?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: opts.method ?? "POST", path: opts.path ?? TERMINAL_OPEN_HTTP_PATH, headers: opts.headers ?? {}, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** Runs the shim like a program in the terminal would. Never the real `open`: `KOKPIT_OPEN_REAL` is the recorder. */
function runShim(args: string[], env: Record<string, string>, cwd: string = base): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(SHIM, args, { cwd, env: { PATH: "/usr/bin:/bin", HOME: base, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}
/** Argument lists the fake `open` was started with, one per run. */
function passedOn(): string[][] {
  if (!existsSync(opened)) return [];
  const lines = readFileSync(opened, "utf8").split("\n");
  const runs: string[][] = [];
  for (let i = 0; i < lines.length; i++) {
    const count = /^RUN (\d+)$/.exec(lines[i]!);
    if (!count) continue;
    runs.push(lines.slice(i + 1, i + 1 + Number(count[1])));
    i += Number(count[1]);
  }
  return runs;
}

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-open-")));
  opened = join(base, "opened.log");
  fakeOpen = join(base, "fake-open");
  // Records "RUN <count>" and then its arguments, one per line. Opens nothing.
  writeFileSync(fakeOpen, `#!/bin/sh\nprintf 'RUN %s\\n' "$#" >> '${opened}'\nfor a in "$@"; do printf '%s\\n' "$a" >> '${opened}'; done\n`);
  chmodSync(fakeOpen, 0o755);
  mkdirSync(join(base, "site", "alt klasör"), { recursive: true });
  writeFileSync(join(base, "site", "index.html"), "<!doctype html>");
  writeFileSync(join(base, "site", "alt klasör", "Sayfa.HTM"), "<!doctype html>");
  writeFileSync(join(base, "site", "not.txt"), "x");
  server = http.createServer((req, res) => {
    if (!service.handleHttp(req, res, actions)) {
      res.writeHead(418);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
});
beforeEach(() => {
  clock = Date.now();
  shown = [];
  fail = undefined;
  rmSync(opened, { force: true });
  build();
});
afterEach(() => service.shutdown());
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(base, { recursive: true, force: true });
});

describe("open izni: hangi terminale verilir", () => {
  it("local terminals of projects whose browser runs on the engine get the shim's environment", () => {
    const prepared = service.prepare(local("p1"))!;
    expect(prepared.env[OPEN_ENV.endpoint]).toBe(`http://127.0.0.1:${port}${TERMINAL_OPEN_HTTP_PATH}`);
    // The grant's id and the key's padded halves — the key itself is not among them.
    expect(prepared.env[OPEN_ENV.id]).toMatch(/^[0-9a-f-]{36}$/);
    expect(prepared.env[OPEN_ENV.ipad]).toMatch(/^[0-9a-f]{128}$/);
    expect(prepared.env[OPEN_ENV.opad]).toMatch(/^[0-9a-f]{128}$/);
    expect(Object.keys(prepared.env).some((k) => k.endsWith("TOKEN"))).toBe(false);
    expect(prepared.env[OPEN_ENV.real]).toBe(fakeOpen);
    expect(prepared.env[OPEN_ENV.shimDir]).toBe(join(ENGINE_DIR, "wrappers", "bin"));
    expect(prepared.env.PATH).toBe(`${join(ENGINE_DIR, "wrappers", "bin")}:/usr/bin:/bin`);
    // sh: the shim stays first on PATH through ENV; zsh needs nothing of it.
    expect(prepared.env.ENV).toBe(join(ENGINE_DIR, "wrappers", "sh-env.sh"));
    expect(prepared.env.ZDOTDIR).toBeUndefined();
    // Every terminal has its own credential.
    expect(service.prepare(local("p1"))!.env[OPEN_ENV.ipad]).not.toBe(prepared.env[OPEN_ENV.ipad]);
  });

  it("zsh starts through Kokpit's .zshenv, which hands back the user's own ZDOTDIR", () => {
    build({}, { shell: "/bin/zsh", userZdotdir: "/Users/ada/.zsh" });
    const env = service.prepare(local("p1"))!.env;
    expect(env.ZDOTDIR).toBe(join(ENGINE_DIR, "wrappers", "zsh"));
    expect(env[OPEN_ENV.userZdotdir]).toBe("/Users/ada/.zsh");
    expect(env.ENV).toBeUndefined();
    build({}, { shell: "/bin/zsh" });
    expect(service.prepare(local("p1"))!.env[OPEN_ENV.userZdotdir]).toBe("");
    // An ENV the user already has is never replaced; other shells get the PATH entry only.
    build({}, { env: { PATH: "/bin", ENV: "/Users/ada/.shrc" } });
    expect(service.prepare(local("p1"))!.env.ENV).toBeUndefined();
    build({}, { shell: "/opt/homebrew/bin/fish" });
    const fish = service.prepare(local("p1"))!.env;
    expect(fish.ZDOTDIR).toBeUndefined();
    expect(fish.ENV).toBeUndefined();
  });

  it.each([
    ["the global switch is off", () => build({ enabled: false }), local("p1")],
    ["the project opted out", () => build(), local("p1", { openInBrowser: false })],
    ["an SSH project", () => build(), local("p1", { location: { kind: "ssh", hostId: "h" } })],
    ["a project whose browser runs on the app's machine", () => build(), local("p1", { browser: { runOn: "client" } })],
    ["the engine listens nowhere yet", () => build({}, { listening: false }), local("p1")],
  ])("no shim when %s", (_name, setup, project) => {
    setup();
    expect(service.prepare(project)).toBeUndefined();
    expect(service.stats().grants).toBe(0);
  });

  it("projectUsesOpenShim is on by default", () => {
    expect(projectUsesOpenShim(local("p"))).toBe(true);
    expect(projectUsesOpenShim(local("p", { openInBrowser: true }))).toBe(true);
    expect(projectUsesOpenShim(local("p", { openInBrowser: false }))).toBe(false);
  });
});

describe("POST /terminal/open", () => {
  const token = (project: Project = local("p1")): Cred => credOf(service.prepare(project)!.env);

  it("shows an http(s) address for the grant's own project, normalized", async () => {
    const t = token();
    const r = await post(body(t, "url", `HTTP://LocalHost:3000/a?b=1`));
    expect(r.status).toBe(200);
    expect(msg(r)).toBe("ok");
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ kind: "url", target: "http://localhost:3000/a?b=1", grant: { projectId: "p1" } });
  });

  it("shows an absolute .html/.htm path; a card's terminal acts for its card", async () => {
    const t = credOf(service.prepare(local("p1"), { id: "c1", projectId: "p1", name: "k", branch: "b", worktreePath: "/w", createdAt: "x" })!.env);
    expect((await post(body(t, "file", `/Users/ada/rapor/index.html`))).status).toBe(200);
    expect((await post(body(t, "file", `/Users/ada/a b/Sayfa.HTM`))).status).toBe(200);
    expect(shown.map((s) => [s.kind, s.target, s.grant.projectId, s.grant.cardId])).toEqual([
      ["file", "/Users/ada/rapor/index.html", "p1", "c1"],
      ["file", "/Users/ada/a b/Sayfa.HTM", "p1", "c1"],
    ]);
  });

  it.each([
    ["javascript:alert(1)", "url"],
    ["file:///etc/passwd", "url"],
    ["vscode://file/x", "url"],
    ["x-apple.systempreferences:com.apple.preference.security", "url"],
    ["https://user:pw@example.com/", "url"],
    ["http://exa mple.com/", "url"],
    ["/Applications/Safari.app", "file"],
    ["/Users/ada/.ssh/id_rsa", "file"],
    ["/Users/ada/notlar.txt", "file"],
    ["relative/index.html", "file"],
    ["~/index.html", "file"],
    ["http://localhost/index.html", "file"],
  ])("refuses %s as %s: nothing but web addresses and pages", async (target, kind) => {
    const r = await post(body(token(), kind, target));
    expect(r.status).toBe(422);
    expect(shown).toEqual([]);
  });

  it.each([
    ["no id line", (c: Cred) => body(c, "url", "http://localhost/").split("\n").slice(1).join("\n")],
    ["unknown kind", (c: Cred) => body(c, "app", "Safari")],
    ["empty target", (c: Cred) => body(c, "url", "")],
    ["nothing", () => ""],
    ["a NUL in the target", (c: Cred) => body(c, "file", "/a\0/index.html")],
    ["a raw key instead of a MAC (the old body)", (c: Cred) => `${c.key.toString("hex")}\nurl\nhttp://localhost/`],
    ["a nonce that is not 16 hex bytes", (c: Cred) => body(c, "url", "http://localhost/", { nonce: "x" })],
  ])("malformed body (%s) → 400", async (_n, make) => {
    const r = await post(make(token()));
    expect(r.status).toBe(400);
    expect(shown).toEqual([]);
  });

  it("the key never travels: a forged MAC (the right id, no key) is refused, and gets no proof back", async () => {
    const c = token();
    const forged = body(c, "url", "http://localhost/", { mac: "0".repeat(64) });
    const r = await post(forged);
    expect(r.status).toBe(401);
    expect(r.body.split("\n")[0]).toBe("-");
    // Another terminal's key for this id: refused too.
    expect((await post(body({ id: c.id, key: token().key }, "url", "http://localhost/"))).status).toBe(401);
    expect(shown).toEqual([]);
  });

  it("a request is good once: the same nonce again (a replay) is refused", async () => {
    const c = token();
    const once = body(c, "url", "http://localhost/r");
    expect((await post(once)).status).toBe(200);
    const again = await post(once);
    expect(again.status).toBe(401);
    expect(msg(again)).toContain("tekrarlanmış");
    expect(shown).toHaveLength(1);
  });

  it("a timestamp outside the window (an old captured request, or a clock far off) is refused", async () => {
    const c = token();
    const skew = loadFilesConfig({}).open.clockSkewS;
    const at = (s: number) => String(Math.floor(clock / 1000) + s);
    expect((await post(body(c, "url", "http://localhost/a", { ts: at(-skew - 1) }))).status).toBe(401);
    expect((await post(body(c, "url", "http://localhost/b", { ts: at(skew + 1) }))).status).toBe(401);
    expect((await post(body(c, "url", "http://localhost/c", { ts: at(-skew + 1) }))).status).toBe(200);
    expect(shown.map((x) => x.target)).toEqual(["http://localhost/c"]);
  });

  it("every answer to a signed request carries the engine's proof over the nonce and the status", async () => {
    const c = token();
    const nonce = randomBytes(16).toString("hex");
    const ok = await post(body(c, "url", "http://localhost/p", { nonce }));
    expect(ok.body.split("\n")[0]).toBe(openMac(c.key, openReplyText(nonce, 200)));
    const n2 = randomBytes(16).toString("hex");
    const refused = await post(body(c, "url", "javascript:alert(1)", { nonce: n2 }));
    expect(refused.status).toBe(422);
    expect(refused.body.split("\n")[0]).toBe(openMac(c.key, openReplyText(n2, 422)));
  });

  it("a captured request stays refused for its whole window, however many accepted requests come in between", async () => {
    build({ clockSkewS: 60, rate: { max: 100, windowMs: 1000 } });
    const c = token();
    const late = String(Math.floor(clock / 1000) + 59);
    const cap = body(c, "url", "http://localhost/late", { ts: late });
    expect((await post(cap)).status).toBe(200);
    for (let i = 0; i < 300; i++, clock += 20) await post(body(c, "url", `http://localhost/f${i}`));
    expect(shown.length).toBeGreaterThan(256);
    expect((await post(cap)).status).toBe(401);
  });

  it("the nonce memory is sized from the window and the rate limit (2 × skew × rate), not a separate number", () => {
    const cfg = loadFilesConfig({ open: { realOpenPath: fakeOpen, clockSkewS: 30, rate: { max: 10, windowMs: 1000 } } }).open;
    expect(replayCapacity(cfg)).toBeGreaterThanOrEqual(2 * 30 * 10);
    expect(replayCapacity(cfg)).toBeLessThanOrEqual(2 * 30 * 10 + 2 * 10);
    expect("replayMemory" in cfg).toBe(false);
  });

  it("a request refused by the rate limit is not remembered: the same request is accepted once the limit allows", async () => {
    build({ rate: { max: 1, windowMs: 1000 } });
    const c = token();
    expect((await post(body(c, "url", "http://localhost/one"))).status).toBe(200);
    const second = body(c, "url", "http://localhost/two");
    expect((await post(second)).status).toBe(429);
    clock += 1001;
    expect((await post(second)).status).toBe(200);
  });


  it("an unknown, released, expired or foreign-project credential is refused", async () => {
    expect((await post(body({ id: randomUUID(), key: randomBytes(32) }, "url", "http://localhost/"))).status).toBe(401);
    const prepared = service.prepare(local("p1"))!;
    const t = credOf(prepared.env);
    expect((await post(body(t, "url", `http://localhost/`))).status).toBe(200);
    // The terminal closed.
    prepared.release();
    expect((await post(body(t, "url", `http://localhost/`))).status).toBe(401);
    // Too old.
    const old = token();
    clock += loadFilesConfig({}).open.grantMaxAgeMs + 1;
    expect((await post(body(old, "url", `http://localhost/`))).status).toBe(401);
    // The project is gone: its terminals' credentials go, another project's stay.
    const mine = token(local("p1"));
    const theirs = token(local("p2"));
    service.revokeProject("p1");
    expect((await post(body(mine, "url", `http://localhost/`))).status).toBe(401);
    expect((await post(body(theirs, "url", `http://localhost/`))).status).toBe(200);
    expect(shown.at(-1)!.grant.projectId).toBe("p2");
    service.shutdown();
    expect((await post(body(theirs, "url", `http://localhost/`))).status).toBe(401);
  });

  it("the credential names its project: the body cannot choose another one", async () => {
    const t = token(local("p1"));
    await post(body(t, "url", `http://localhost/?projectId=p2`));
    await post(body(t, "url", `http://localhost/\nprojectId: p2`));
    expect(shown.every((s) => s.grant.projectId === "p1")).toBe(true);
    // A line break inside a target is not an address at all.
    expect(shown).toHaveLength(1);
  });

  it("only POST to the exact path, only from this machine, never from a web page", async () => {
    const t = token();
    const body = `${t}\nurl\nhttp://localhost/`;
    expect((await post(body, { method: "GET" })).status).toBe(405);
    expect((await post(body, { method: "PUT" })).status).toBe(405);
    expect((await post(body, { path: `${TERMINAL_OPEN_HTTP_PATH}/x` })).status).toBe(404);
    expect((await post(body, { path: `${TERMINAL_OPEN_HTTP_PATH}?a=1` })).status).toBe(404);
    expect((await post(body, { path: "/terminal/openx" })).status).toBe(418);
    // A page in any browser — a preview page too — sends Origin with a POST.
    expect((await post(body, { headers: { origin: `http://127.0.0.1:${port}` } })).status).toBe(403);
    expect((await post(body, { headers: { origin: "null" } })).status).toBe(403);
    expect((await post(body, { headers: { "sec-fetch-site": "same-origin" } })).status).toBe(403);
    expect(shown).toEqual([]);
  });

  it("limits the body size and how often one terminal asks", async () => {
    build({ maxBodyBytes: 256, rate: { max: 2, windowMs: 1000 } });
    const t = token();
    expect((await post(body(t, "url", `http://localhost/${"a".repeat(400)}`)).catch(() => ({ status: 413, body: "" }))).status).toBe(413);
    expect((await post(body(t, "url", `http://localhost/1`))).status).toBe(200);
    expect((await post(body(t, "url", `http://localhost/2`))).status).toBe(200);
    expect((await post(body(t, "url", `http://localhost/3`))).status).toBe(429);
    // Another terminal has its own allowance.
    expect((await post(body(token(), "url", `http://localhost/4`))).status).toBe(200);
    clock += 1001;
    expect((await post(body(t, "url", `http://localhost/5`))).status).toBe(200);
  });

  it("the engine's refusal reaches the terminal as one line; an unexpected failure says nothing of its cause", async () => {
    const t = token();
    fail = new EngineError("INVALID", "Gizli (noktayla başlayan) klasör ve dosyalar önizlenmez");
    const hidden = await post(body(t, "file", `/Users/ada/.ssh/a.html`));
    expect(hidden.status).toBe(409);
    expect(msg(hidden)).toBe("Gizli (noktayla başlayan) klasör ve dosyalar önizlenmez");
    fail = new EngineError("NOT_FOUND", "Dosya bulunamadı");
    expect((await post(body(t, "file", `/yok/a.html`))).status).toBe(404);
    fail = new Error("ECONNREFUSED 127.0.0.1:39211 /Users/ada/secret");
    const r = await post(body(t, "url", `http://localhost/`));
    expect(r.status).toBe(500);
    expect(msg(r)).not.toContain("secret");
  });

  it("never logs a credential or what was opened", async () => {
    const t = token();
    await post(body(t, "url", `http://localhost:3000/gizli-yol?belirtec=GIZLI`));
    await post(body(t, "file", `/Users/ada/gizli-klasor/index.html`));
    const dump = logger.dump();
    expect(dump).toContain("terminal open handled");
    expect(dump).not.toContain(t.key.toString("hex"));
    expect(dump).not.toContain("GIZLI");
    expect(dump).not.toContain("gizli-klasor");
  });
});

describe("wrappers/bin/open: betiğin kendisi", () => {
  /** The terminal's environment as the engine gives it (by default: no fallback to the desktop browser). */
  const engineEnv = (extra: Record<string, string> = {}): Record<string, string> => ({ ...service.prepare(local("p1"))!.env, PATH: "/usr/bin:/bin", ...extra });
  /** With `fallbackToSystemOpen` on: what the tests below about the real open's fallback run with. */
  const envOf = (extra: Record<string, string> = {}): Record<string, string> => engineEnv({ [OPEN_ENV.fallback]: "1", ...extra });

  it("by default a failed address/page is NOT handed to the engine Mac's desktop browser: one line, exit 1", async () => {
    expect(engineEnv()[OPEN_ENV.fallback]).toBe("0");
    const unreachable = await runShim(["https://example.com/x"], engineEnv({ [OPEN_ENV.endpoint]: "http://127.0.0.1:1/terminal/open", [OPEN_ENV.timeout]: "2" }));
    expect(unreachable.code).toBe(1);
    expect(unreachable.stderr).toBe(
      "kokpit: Kokpit tarayıcısında açılmadı (motora ulaşılamadı); masaüstü tarayıcısında da açılmadı (ayar: files.open.fallbackToSystemOpen).\n",
    );
    fail = new EngineError("INVALID", "Bu projede open Kokpit tarayıcısına yönlendirilmiyor");
    const refused = await runShim(["index.html"], engineEnv(), join(base, "site"));
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("(Bu projede open Kokpit tarayıcısına yönlendirilmiyor); masaüstü tarayıcısında da açılmadı");
    expect(passedOn()).toEqual([]);
  });

  it("a project whose open is not for Kokpit (openInBrowser off) still gets the real open: the user chose it", async () => {
    fail = new OpenDeclinedError("Bu projede open Kokpit tarayıcısına yönlendirilmiyor");
    const r = await runShim(["https://example.com/k"], engineEnv());
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("kokpit: Kokpit tarayıcısında açılmadı (Bu projede open Kokpit tarayıcısına yönlendirilmiyor); sistemin open komutu kullanılıyor.\n");
    expect(passedOn()).toEqual([["https://example.com/k"]]);
  });

  it("an impostor's unproven 'use the system open' answer does not open the desktop browser", async () => {
    const impostor = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(303, { "content-type": "text/plain" });
        res.end(`${"0".repeat(64)}\nkendi open'ını kullan\n`);
      });
    });
    await new Promise<void>((resolve) => impostor.listen(0, "127.0.0.1", () => resolve()));
    try {
      const at = (impostor.address() as AddressInfo).port;
      const r = await runShim(["https://example.com/s"], engineEnv({ [OPEN_ENV.endpoint]: `http://127.0.0.1:${at}${TERMINAL_OPEN_HTTP_PATH}` }));
      expect(r.code).toBe(1);
      expect(passedOn()).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => impostor.close(() => resolve()));
    }
  });

  it("other uses of open (options, folders, other files) still reach the real open without the fallback", async () => {
    await runShim(["-a", "TextEdit", "x.txt"], engineEnv());
    await runShim([join(base, "site", "not.txt")], engineEnv());
    expect(passedOn()).toEqual([["-a", "TextEdit", "x.txt"], [join(base, "site", "not.txt")]]);
  });

  it("the setting turns the old behaviour back on", () => {
    service.shutdown();
    build({ fallbackToSystemOpen: true });
    expect(engineEnv()[OPEN_ENV.fallback]).toBe("1");
  });

  it("the shim accepts only a 64-hex proof: with a broken HMAC tool, an empty reply line does not pass for one", async () => {
    const impostor = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("\nok\n");
      });
    });
    await new Promise<void>((resolve) => impostor.listen(0, "127.0.0.1", () => resolve()));
    try {
      const at = (impostor.address() as AddressInfo).port;
      const broken = join(base, "broken-shasum");
      writeFileSync(broken, "#!/bin/sh\ncat > /dev/null\nexit 1\n");
      chmodSync(broken, 0o755);
      const r = await runShim(["https://example.com/e"], envOf({ [OPEN_ENV.endpoint]: `http://127.0.0.1:${at}${TERMINAL_OPEN_HTTP_PATH}`, [OPEN_ENV.shasum]: broken }));
      expect(passedOn()).toEqual([["https://example.com/e"]]);
      expect(r.stderr).toContain("kokpit:");
    } finally {
      await new Promise<void>((resolve) => impostor.close(() => resolve()));
    }
  });

  it("an http(s) address goes to the engine; the real open is not started and nothing is printed", async () => {
    const r = await runShim(["https://example.com/a?b=1"], envOf());
    expect(r).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(shown.map((s) => [s.kind, s.target])).toEqual([["url", "https://example.com/a?b=1"]]);
    expect(passedOn()).toEqual([]);
    await runShim(["HTTP://localhost:5173"], envOf());
    expect(shown.at(-1)!.target).toBe("http://localhost:5173/");
  });

  it("an existing .html/.htm file goes to the engine as an absolute path — relative to where the program runs", async () => {
    await runShim(["index.html"], envOf(), join(base, "site"));
    await runShim(["./alt klasör/Sayfa.HTM"], envOf(), join(base, "site"));
    await runShim([join(base, "site", "index.html")], envOf(), "/");
    expect(shown.map((s) => [s.kind, s.target])).toEqual([
      ["file", join(base, "site", "index.html")],
      ["file", `${join(base, "site")}/./alt klasör/Sayfa.HTM`],
      ["file", join(base, "site", "index.html")],
    ]);
    expect(passedOn()).toEqual([]);
  });

  it.each([
    [["-a", "Safari", "https://example.com/"]],
    [["-R", "index.html"]],
    [["-e", "index.html"]],
    [["-n", "https://example.com/"]],
    [["-g", "https://example.com/"]],
    [["--", "index.html"]],
    [["-a"]],
    [["https://example.com/", "https://example.org/"]],
    [["index.html", "not.txt"]],
    [["not.txt"]],
    [["."]],
    [["yok.html"]],
    [["alt klasör"]],
    [["mailto:a@example.com"]],
    [["vscode://file/x"]],
    [["x-apple.systempreferences:com.apple.preference.security"]],
    [["file:///etc/hosts"]],
    [["ftp://example.com/a.html"]],
    [["http://"]],
    [[]],
  ])("%j is the real open's, with the arguments unchanged", async (args) => {
    const r = await runShim(args, envOf(), join(base, "site"));
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(passedOn()).toEqual([args]);
    expect(shown).toEqual([]);
  });

  it("without the terminal's Kokpit environment it is the real open", async () => {
    await runShim(["https://example.com/"], { [OPEN_ENV.real]: fakeOpen });
    await runShim(["https://example.com/"], { ...envOf(), [OPEN_ENV.ipad]: "" });
    expect(passedOn()).toEqual([["https://example.com/"], ["https://example.com/"]]);
    expect(shown).toEqual([]);
  });

  it("an engine that cannot be reached: one line, then the real open", async () => {
    const r = await runShim(["https://example.com/x"], envOf({ [OPEN_ENV.endpoint]: "http://127.0.0.1:1/terminal/open", [OPEN_ENV.timeout]: "2" }));
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("kokpit: Kokpit tarayıcısında açılmadı (motora ulaşılamadı); sistemin open komutu kullanılıyor.\n");
    expect(passedOn()).toEqual([["https://example.com/x"]]);
  });

  it("an engine that refuses: one line with the reason, then the real open", async () => {
    fail = new EngineError("INVALID", "Bu projede open Kokpit tarayıcısına yönlendirilmiyor");
    const r = await runShim(["index.html"], envOf(), join(base, "site"));
    expect(r.stderr).toBe("kokpit: Kokpit tarayıcısında açılmadı (Bu projede open Kokpit tarayıcısına yönlendirilmiyor); sistemin open komutu kullanılıyor.\n");
    expect(passedOn()).toEqual([["index.html"]]);
    // A credential the engine no longer knows (the engine restarted under a terminal that lived on).
    rmSync(opened);
    fail = undefined;
    const stale = await runShim(["https://example.com/"], envOf({ [OPEN_ENV.id]: randomUUID() }));
    expect(stale.stderr).toContain("izni geçersiz");
    expect(passedOn()).toEqual([["https://example.com/"]]);
  });

  it("no secret is on any command line the shim starts, and none is in what it sends", async () => {
    const env = envOf();
    const key = credOf(env).key.toString("hex");
    // Every tool the shim runs records its arguments; curl also records what it was given to send.
    const log = join(base, "tool-args.log");
    rmSync(log, { force: true });
    const wrap = (name: string, real: string): string => {
      const path = join(base, `rec-${name}`);
      writeFileSync(path, `#!/bin/sh\nprintf '${name} %s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`);
      chmodSync(path, 0o755);
      return path;
    };
    const sent = join(base, "curl-body.log");
    const curl = join(base, "rec-curl");
    writeFileSync(curl, `#!/bin/sh\nprintf 'curl %s\\n' "$*" >> '${log}'\ncat > '${sent}'\nprintf -- '-\\nok\\n\\n200'\n`);
    chmodSync(curl, 0o755);
    const r = await runShim(["https://example.com/"], {
      ...env,
      [OPEN_ENV.curl]: curl,
      [OPEN_ENV.xxd]: wrap("xxd", "/usr/bin/xxd"),
      [OPEN_ENV.shasum]: wrap("shasum", "/usr/bin/shasum"),
      [OPEN_ENV.od]: wrap("od", "/usr/bin/od"),
      [OPEN_ENV.date]: wrap("date", "/bin/date"),
    });
    const args = readFileSync(log, "utf8");
    expect(args).toContain(env[OPEN_ENV.endpoint]!);
    for (const secret of [key, env[OPEN_ENV.ipad]!, env[OPEN_ENV.opad]!]) expect(args).not.toContain(secret);
    const body = readFileSync(sent, "utf8");
    for (const secret of [key, env[OPEN_ENV.ipad]!, env[OPEN_ENV.opad]!]) expect(body).not.toContain(secret);
    // That fake engine could not prove its reply: the shim does not believe it and falls back to the real open.
    expect(r.stderr).toContain("doğrulanamadı");
    expect(passedOn()).toEqual([["https://example.com/"]]);
  });

  it("an impostor on the engine's port (answers 200 without the key's proof) cannot make the shim skip the real open", async () => {
    const impostor = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`${"0".repeat(64)}\nok\n`);
      });
    });
    await new Promise<void>((resolve) => impostor.listen(0, "127.0.0.1", () => resolve()));
    try {
      const at = (impostor.address() as AddressInfo).port;
      const r = await runShim(["https://example.com/i"], envOf({ [OPEN_ENV.endpoint]: `http://127.0.0.1:${at}${TERMINAL_OPEN_HTTP_PATH}` }));
      expect(r.stderr).toContain("motorun yanıtı doğrulanamadı");
      expect(passedOn()).toEqual([["https://example.com/i"]]);
    } finally {
      await new Promise<void>((resolve) => impostor.close(() => resolve()));
    }
  });
});

describe.skipIf(!existsSync("/bin/zsh"))("wrappers/zsh/.zshenv", () => {
  const ZSH_DIR = join(ENGINE_DIR, "wrappers", "zsh");
  /** A non-interactive zsh started the way a Kokpit terminal's is; the "user" is a temp HOME / ZDOTDIR. */
  const zsh = (env: Record<string, string>, script: string): string =>
    execFileSync("/bin/zsh", ["-c", script], { env: { PATH: "/usr/bin:/bin", ZDOTDIR: ZSH_DIR, ...env }, encoding: "utf8" });

  it("without a ZDOTDIR of the user's, ZDOTDIR is unset again and the home directory's .zshenv is read", () => {
    const userHome = join(base, "zsh-home");
    mkdirSync(userHome, { recursive: true });
    writeFileSync(join(userHome, ".zshenv"), "export EVDEN=okundu\n");
    const out = zsh({ HOME: userHome, [OPEN_ENV.userZdotdir]: "", [OPEN_ENV.shimDir]: "/x" }, `print -r -- "[\${ZDOTDIR-yok}] [$EVDEN] [\${KOKPIT_USER_ZDOTDIR-yok}]"`);
    expect(out.trim()).toBe("[yok] [okundu] [yok]");
  });

  it("with one, that is ZDOTDIR again and its .zshenv is read; a user without any .zshenv is fine too", () => {
    const userDir = join(base, "zsh-dot");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, ".zshenv"), "export OZEL=okundu\n");
    expect(zsh({ HOME: join(base, "bos-ev"), [OPEN_ENV.userZdotdir]: userDir }, `print -r -- "[$ZDOTDIR] [$OZEL]"`).trim()).toBe(`[${userDir}] [okundu]`);
    expect(zsh({ HOME: join(base, "bos-ev"), [OPEN_ENV.userZdotdir]: "" }, `print -r -- "[\${ZDOTDIR-yok}]"`).trim()).toBe("[yok]");
  });

  it("a shell that is not interactive gets no prompt hook and keeps its PATH", () => {
    const out = zsh({ HOME: join(base, "bos-ev"), [OPEN_ENV.userZdotdir]: "", [OPEN_ENV.shimDir]: SHIM.replace(/\/open$/, "") }, `print -r -- "[$precmd_functions] [$PATH]"`);
    expect(out.trim()).toBe("[] [/usr/bin:/bin]");
  });
});
