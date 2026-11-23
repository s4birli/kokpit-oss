// Girişler: the login service over a FAKE `security` (never the real Keychain) and a fake page. Proven here: where
// the password goes on save and on fill, and every place it must not be — the state file, the log, errors, what the
// service returns, the tool's argv.
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeSecurity, type FakeSecurity } from "../test/fakes/fake-security-setup.ts";
import { LOGIN_FILL_FUNCTION, LOGIN_PROBE_FUNCTION } from "./browser-login-fill.ts";
import { EngineError, type Logger } from "./contracts.ts";
import { createKeychain, encodeSecret } from "./keychain.ts";
import { createLoginService, type LoginPage, type LoginService } from "./logins.ts";
import { LoginsConfigSchema, type LoginsConfig } from "./logins-config.ts";
import { createFileStore, type EngineStore } from "./store.ts";

const defaults = (JSON.parse(readFileSync(new URL("../config.defaults.json", import.meta.url), "utf8")) as { logins: LoginsConfig }).logins;
const SECRET = "çok-gizli parola Zx9!\"'";
const SECRET2 = "ikinci-gizli-Qw7#";
const USER = "ayse.kullanici@ornek.example";
const ORIGIN = "https://ornek.example";

interface LogLine {
  level: string;
  msg: string;
  fields?: Record<string, unknown>;
}

let root: string;
let stateFile: string;
let fake: FakeSecurity;
let config: LoginsConfig;
let store: EngineStore;
let logs: LogLine[];
let logger: Logger;
let page: FakePage;
let service: LoginService;
let clock: number;
let ids: number;
/** Projects with a running terminal that was handed the browser's CDP address (an agent could be attached). */
let agentProjects: Set<string>;

class FakePage implements LoginPage {
  origin = ORIGIN;
  answer: unknown = { status: "ok", filled: ["username", "password"] };
  running = true;
  /** What the probe returns instead of `{ origin }` (a page that answers nonsense). */
  probeAnswer: unknown = undefined;
  calls: { projectId: string; worldName: string; fn: string; args: unknown[] }[] = [];
  async callIsolated(projectId: string, call: { worldName: string; functionDeclaration: string; args: readonly unknown[] }): Promise<unknown> {
    if (!this.running) throw new EngineError("NOT_FOUND", "Tarayıcı açık değil");
    this.calls.push({ projectId, worldName: call.worldName, fn: call.functionDeclaration, args: [...call.args] });
    if (call.functionDeclaration === LOGIN_PROBE_FUNCTION) return this.probeAnswer ?? { origin: this.origin };
    return this.answer;
  }
  fills() {
    return this.calls.filter((c) => c.fn === LOGIN_FILL_FUNCTION);
  }
}

function make(over: Partial<LoginsConfig> = {}): LoginService {
  config = LoginsConfigSchema.parse({ ...defaults, securityPath: fake.path, env: fake.env, envPassthrough: [], timeoutMs: 5000, ...over });
  return createLoginService({
    config,
    store,
    keychain: createKeychain({ config, env: {} }),
    page,
    logger,
    agentsPresent: (projectId) => agentProjects.has(projectId),
    now: () => new Date(clock),
    newId: () => `id-${++ids}`,
  });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-logins-")));
  stateFile = join(root, "state.json");
  fake = installFakeSecurity(root);
  logs = [];
  const line = (level: string) => (msg: string, fields?: Record<string, unknown>) => void logs.push({ level, msg, ...(fields ? { fields } : {}) });
  logger = { info: line("info"), warn: line("warn"), error: line("error") };
  store = createFileStore(stateFile, logger);
  page = new FakePage();
  agentProjects = new Set();
  // The user already said yes to the agent risk in these projects (the tests about that risk take it back).
  store.setLoginRiskAccepted("p1", true);
  store.setLoginRiskAccepted("p2", true);
  clock = Date.parse("2026-03-04T05:06:07.000Z");
  ids = 0;
  service = make();
});
afterEach(async () => {
  await service.idle();
  rmSync(root, { recursive: true, force: true });
});

/** Saves a login the way the app does: with the site's page open in the project's browser. */
const save = (over: Record<string, unknown> = {}) => {
  page.origin = typeof over.origin === "string" ? over.origin : ORIGIN;
  return saveAsIs(over);
};
/** Saves without touching what the (fake) browser shows. */
const saveAsIs = (over: Record<string, unknown> = {}) =>
  service.save({ projectId: "p1", origin: ORIGIN, username: USER, password: SECRET, ...over } as Parameters<LoginService["save"]>[0]);

async function errorOf(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(EngineError);
    return { code: (e as EngineError).code, message: (e as Error).message };
  }
  return { code: "(no error)", message: "" };
}

/** Everything that could leak, as text. */
const everywhere = (extra: unknown[] = []) =>
  JSON.stringify({ logs, state: existsSync(stateFile) ? readFileSync(stateFile, "utf8") : "", runs: fake.runLog(), extra });
const secretForms = (secret: string) => [secret, JSON.stringify(secret).slice(1, -1), encodeSecret(secret, config), Buffer.from(secret, "utf8").toString("base64"), Buffer.from(secret, "utf8").toString("hex")];
function expectNoSecret(text: string, secret = SECRET): void {
  for (const form of secretForms(secret)) expect(text).not.toContain(form);
}

describe("logins.save / list", () => {
  it("stores the password in the Keychain and only metadata in the state", async () => {
    const login = await save({ label: "İş hesabı" });
    expect(login).toEqual({ id: "id-1", projectId: "p1", origin: ORIGIN, username: USER, label: "İş hesabı", createdAt: "2026-03-04T05:06:07.000Z", updatedAt: "2026-03-04T05:06:07.000Z" });
    expect(service.list("p1")).toEqual([login]);
    expect(fake.items()).toEqual({ "dev.kokpit.login.p1\nid-1": encodeSecret(SECRET, config) });
    expect(JSON.parse(readFileSync(stateFile, "utf8")).logins).toEqual([login]);
  });

  it("the password is nowhere but the Keychain: not in the result, the state file, the log or the tool's argv", async () => {
    const login = await save();
    const listed = service.list("p1");
    const text = everywhere([login, listed]);
    expectNoSecret(text);
    expect(text).not.toMatch(/"password"/);
  });

  it("the username is personal data: it is in the state, never in the log", async () => {
    await save();
    await service.fill("p1", "id-1");
    await service.delete("id-1");
    expect(JSON.stringify(logs)).not.toContain(USER);
    expect(JSON.stringify(logs)).not.toContain("ornek.example");
    expect(logs.filter((l) => l.level === "info").map((l) => l.msg)).toEqual(["login saved", "login filled", "login deleted"]);
    expect(logs[0]!.fields).toEqual({ projectId: "p1", loginId: "id-1", created: true });
  });

  it("saving the same site and username again replaces the password and keeps the id", async () => {
    const first = await save({ label: "eski" });
    clock += 60_000;
    const second = await save({ password: SECRET2 });
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBe("2026-03-04T05:07:07.000Z");
    expect(second.label).toBe("eski");
    expect(service.list("p1")).toHaveLength(1);
    expect(fake.items()).toEqual({ "dev.kokpit.login.p1\nid-1": encodeSecret(SECRET2, config) });
  });

  it("another username, site or project is another login", async () => {
    await save();
    await save({ username: "baska" });
    await save({ origin: "https://www.ornek.example" });
    await save({ projectId: "p2" });
    expect(service.list("p1").map((l) => l.id)).toEqual(["id-1", "id-2", "id-3"]);
    expect(service.list("p2").map((l) => l.id)).toEqual(["id-4"]);
    expect(Object.keys(fake.items())).toHaveLength(4);
  });

  it("refuses a password over the byte cap without storing anything, and says the cap — not the password", async () => {
    service = make({ maxSecretBytes: 32 });
    const big = "ş".repeat(17);
    const err = await errorOf(save({ password: big }));
    expect(err.code).toBe("INVALID");
    expect(err.message).toContain("32");
    expect(err.message).not.toContain("şş");
    expect(service.list("p1")).toEqual([]);
    expect(fake.runs()).toHaveLength(0);
  });

  it("refuses more logins than the project may have", async () => {
    service = make({ maxPerProject: 2 });
    await save();
    await save({ username: "iki" });
    expect((await errorOf(save({ username: "üç" }))).code).toBe("INVALID");
    await save({ password: SECRET2 }); // replacing one is still fine
    await save({ projectId: "p2", username: "üç" });
    expect(service.list("p1")).toHaveLength(2);
  });

  it("a login is saved only for the site that is OPEN in the project's browser right now", async () => {
    page.origin = "https://kotu.example";
    const err = await errorOf(saveAsIs());
    expect(err.code).toBe("INVALID");
    expect(err.message).toContain(ORIGIN);
    expect(err.message).toContain("https://kotu.example");
    expectNoSecret(err.message);
    expect(service.list("p1")).toEqual([]);
    expect(fake.runs()).toHaveLength(0);
    expect(page.calls.map((c) => c.fn)).toEqual([LOGIN_PROBE_FUNCTION]);
    expect(page.calls[0]!.args).toEqual([]);
  });

  it.each(["http://ornek.example", "https://www.ornek.example", "https://ornek.example:8443", "null", ""])("save: the open page %j is not the site being saved", async (open) => {
    page.origin = open;
    expect((await errorOf(saveAsIs())).code).toBe("INVALID");
    expect(fake.runs()).toHaveLength(0);
  });

  it("a closed browser, a page that does not answer, or an engine without a browser: nothing is saved", async () => {
    page.running = false;
    expect((await errorOf(saveAsIs())).code).toBe("NOT_FOUND");
    page.running = true;
    page.probeAnswer = { origin: 5 };
    expect((await errorOf(saveAsIs())).code).toBe("INVALID");
    service = createLoginService({ config, store, keychain: createKeychain({ config, env: {} }), page: undefined, logger });
    expect((await errorOf(saveAsIs())).code).toBe("INVALID");
    expect(fake.runs()).toHaveLength(0);
    expect(store.listLogins()).toEqual([]);
  });

  it("refuses a project id that cannot name a Keychain item", async () => {
    const err = await errorOf(save({ projectId: "proje bir" }));
    expect(err.code).toBe("INVALID");
    expect(fake.runs()).toHaveLength(0);
  });

  it.each([
    ["locked", /kilitli|onay/],
    ["denied", /reddedildi/],
    ["canceled", /reddedildi/],
    ["nokeychain", /kullanılamıyor/],
    ["slow", /yanıt vermedi/],
    ["echo-error", /başarısız/],
  ] as const)("Keychain %s: a clear Turkish message, nothing stored, no secret in it", async (mode, text) => {
    fake.mode(mode);
    // Only the timeout case needs a short limit; with it on every case a slow process start (loaded machine)
    // turned the other answers into "no answer" as well.
    service = make(mode === "slow" ? { timeoutMs: 400, confirmTimeoutMs: 400 } : {});
    const err = await errorOf(save());
    expect(err.code).toBe("KEYCHAIN_FAILED");
    expect(err.message).toMatch(text);
    expectNoSecret(err.message);
    expect(service.list("p1")).toEqual([]);
    expectNoSecret(everywhere());
  });

  it("an approval that waits on the engine Mac's screen: the message says where to look and to try again", async () => {
    fake.mode("locked");
    const err = await errorOf(save());
    expect(err.message).toMatch(/ekranında/);
    expect(err.message).toMatch(/ekranında/);
    expect(err.message).toMatch(/yeniden deneyin/);
  });
});

describe("logins.fill", () => {
  beforeEach(async () => {
    await save();
    fake.clearRuns();
    page.calls.length = 0;
  });

  it("probes the page first, then reads the secret and hands it to the page as call ARGUMENTS only", async () => {
    expect(await service.fill("p1", "id-1")).toEqual(["username", "password"]);
    expect(page.calls.map((c) => c.fn)).toEqual([LOGIN_PROBE_FUNCTION, LOGIN_FILL_FUNCTION]);
    expect(page.calls[0]!.args).toEqual([]);
    expect(page.calls[1]).toMatchObject({ projectId: "p1", worldName: config.fillWorldName, args: [ORIGIN, USER, SECRET, config.fillFrameDepth] });
    expect(LOGIN_FILL_FUNCTION).not.toContain(SECRET);
    expect(fake.runs().map((r) => r.argv[0])).toEqual(["find-generic-password"]);
  });

  it("returns field names only; nothing about the fill carries the secret", async () => {
    const filled = await service.fill("p1", "id-1");
    expectNoSecret(everywhere([filled]));
  });

  it("another site: refused naming both, and the Keychain is not even asked", async () => {
    page.origin = "https://ornek.example.kotu.example";
    const err = await errorOf(service.fill("p1", "id-1"));
    expect(err.code).toBe("INVALID");
    expect(err.message).toContain(ORIGIN);
    expect(err.message).toContain("https://ornek.example.kotu.example");
    expect(fake.runs()).toHaveLength(0);
    expect(page.fills()).toHaveLength(0);
  });

  it.each(["http://ornek.example", "https://www.ornek.example", "https://ornek.example:8443", "https://ORNEK.example", "https://ornek.example/", "null", ""])(
    "exact origin only: %j is another site",
    async (origin) => {
      page.origin = origin;
      expect((await errorOf(service.fill("p1", "id-1"))).code).toBe("INVALID");
      expect(page.fills()).toHaveLength(0);
      expect(fake.runs()).toHaveLength(0);
    },
  );

  it("a page that changed between the probe and the fill is still refused (the fill function checks again)", async () => {
    page.answer = { status: "origin", origin: "https://kotu.example" };
    const err = await errorOf(service.fill("p1", "id-1"));
    expect(err.message).toContain("https://kotu.example");
    expect(err.message).toContain(ORIGIN);
    expectNoSecret(err.message);
  });

  it("a page origin that is not an origin is not echoed into the message", async () => {
    page.answer = { status: "origin", origin: "<script>alert(1)</script>" };
    const err = await errorOf(service.fill("p1", "id-1"));
    expect(err.message).not.toContain("<script>");
  });

  it.each([
    [{ status: "nofields" }, /bulunamadı/],
    [{ status: "ambiguous" }, /birden çok parola alanı/],
    [{ status: "ok", filled: [] }, /doldurulamadı/],
    [{ status: "ok", filled: ["username", "password"], value: SECRET }, null],
    [{ status: "tuhaf" }, /yanıt vermedi/],
    [null, /yanıt vermedi/],
    ["ok", /yanıt vermedi/],
    [{ status: "ok", filled: ["parola"] }, /yanıt vermedi/],
  ] as const)("page answer %j", async (answer, text) => {
    page.answer = answer;
    if (text === null) {
      expect(await service.fill("p1", "id-1")).toEqual(["username", "password"]);
      return;
    }
    const err = await errorOf(service.fill("p1", "id-1"));
    expect(err.code).toBe("INVALID");
    expect(err.message).toMatch(text);
    expectNoSecret(err.message);
  });

  it("reports only what was filled", async () => {
    page.answer = { status: "ok", filled: ["password"] };
    expect(await service.fill("p1", "id-1")).toEqual(["password"]);
    page.answer = { status: "ok", filled: ["password", "username", "password"] };
    expect((await errorOf(service.fill("p1", "id-1"))).code).toBe("INVALID"); // more names than fields: not an answer
  });

  it("a login is never offered or filled in another project", async () => {
    await save({ projectId: "p2", username: "p2-kullanıcısı" });
    expect(service.list("p2").map((l) => l.id)).toEqual(["id-2"]);
    expect(service.list("p1").map((l) => l.id)).toEqual(["id-1"]);
    expect((await errorOf(service.fill("p2", "id-1"))).code).toBe("NOT_FOUND");
    expect((await errorOf(service.fill("p1", "id-2"))).code).toBe("NOT_FOUND");
    expect((await errorOf(service.fill("p1", "yok"))).code).toBe("NOT_FOUND");
    expect(page.fills()).toHaveLength(0);
  });

  it("a closed browser: nothing is read from the Keychain", async () => {
    page.running = false;
    expect((await errorOf(service.fill("p1", "id-1"))).code).toBe("NOT_FOUND");
    expect(fake.runs()).toHaveLength(0);
  });

  it("no browser on this engine", async () => {
    service = createLoginService({ config, store, keychain: createKeychain({ config, env: {} }), page: undefined, logger });
    expect((await errorOf(service.fill("p1", "id-1"))).code).toBe("INVALID");
  });

  it.each([
    ["locked", /kilitli|onay/],
    ["denied", /reddedildi/],
    ["slow", /yanıt vermedi/],
    ["garbage", /yeniden kaydedin/],
  ] as const)("Keychain %s while filling: clear message, the page is not touched", async (mode, text) => {
    fake.mode(mode);
    service = make(mode === "slow" ? { timeoutMs: 400, confirmTimeoutMs: 400 } : {});
    const err = await errorOf(service.fill("p1", "id-1"));
    expect(err.code).toBe("KEYCHAIN_FAILED");
    expect(err.message).toMatch(text);
    expect(page.fills()).toHaveLength(0);
  });

  it("the Keychain item was removed by hand: says so", async () => {
    await createKeychain({ config, env: {} }).delete({ service: "dev.kokpit.login.p1", account: "id-1" });
    const err = await errorOf(service.fill("p1", "id-1"));
    expect(err.code).toBe("KEYCHAIN_FAILED");
    expect(err.message).toMatch(/yeniden kaydedin/);
  });

  it("rate limit: at most fillRateMax attempts per project and window, failed ones included", async () => {
    service = make({ fillRateMax: 3, fillRateWindowMs: 10_000 });
    await service.fill("p1", "id-1");
    page.origin = "https://kotu.example";
    await errorOf(service.fill("p1", "id-1"));
    page.origin = ORIGIN;
    await service.fill("p1", "id-1");
    const before = page.calls.length;
    const err = await errorOf(service.fill("p1", "id-1"));
    expect(err.code).toBe("RATE_LIMITED");
    expect(page.calls.length).toBe(before);
    // another project has its own budget
    await save({ projectId: "p2" });
    await service.fill("p2", "id-2");
    clock += 10_001;
    expect(await service.fill("p1", "id-1")).toEqual(["username", "password"]);
  });
});

describe("logins.fill: ajan riski — motor zorlar, arayüz değil", () => {
  beforeEach(async () => {
    await save();
    fake.clearRuns();
    page.calls.length = 0;
    store.setLoginRiskAccepted("p1", false);
  });

  it("without the project's acceptance a fill is refused with its own code; nothing is read, the page is not touched", async () => {
    const err = await errorOf(service.fill("p1", "id-1"));
    expect(err.code).toBe("LOGIN_RISK_UNACCEPTED");
    expect(err.message).toMatch(/ajanlar da sürebiliyor/);
    expect(fake.runs()).toHaveLength(0);
    expect(page.calls).toHaveLength(0);
    // Saying "yes" in the request alone is not the remembered acceptance.
    expect((await errorOf(service.fill("p1", "id-1", { confirmAgentRisk: true }))).code).toBe("LOGIN_RISK_UNACCEPTED");
  });

  it("the acceptance is per project, survives a restart and can be taken back", async () => {
    expect(await service.policy("p1")).toEqual({ keychainAccess: config.keychainAccess, agentRiskAccepted: false, agentsPresent: false });
    expect((await service.setRisk("p1", true)).agentRiskAccepted).toBe(true);
    expect(await service.fill("p1", "id-1")).toEqual(["username", "password"]);
    service = make();
    expect((await service.policy("p1")).agentRiskAccepted).toBe(true);
    expect(await service.fill("p1", "id-1")).toEqual(["username", "password"]);
    expect((await service.setRisk("p1", false)).agentRiskAccepted).toBe(false);
    expect((await errorOf(service.fill("p1", "id-1"))).code).toBe("LOGIN_RISK_UNACCEPTED");
    expect((await service.policy("p2")).agentRiskAccepted).toBe(true);
    expect(logs.filter((l) => /agent risk/.test(l.msg)).map((l) => l.fields)).toEqual([
      { projectId: "p1", accepted: true },
      { projectId: "p1", accepted: false },
    ]);
  });

  it("while a terminal that knows the browser's CDP address runs, every fill needs a fresh confirmation", async () => {
    await service.setRisk("p1", true);
    agentProjects.add("p1");
    expect((await service.policy("p1")).agentsPresent).toBe(true);
    const err = await errorOf(service.fill("p1", "id-1"));
    expect(err.code).toBe("LOGIN_RISK_UNACCEPTED");
    expect(err.message).toMatch(/Şu anda bu projede çalışan ajan/);
    expect(fake.runs()).toHaveLength(0);
    expect(await service.fill("p1", "id-1", { confirmAgentRisk: true })).toEqual(["username", "password"]);
    expect((await errorOf(service.fill("p1", "id-1"))).code).toBe("LOGIN_RISK_UNACCEPTED"); // not remembered
    agentProjects.clear();
    expect(await service.fill("p1", "id-1")).toEqual(["username", "password"]);
  });

  it("there is no 'no agents around' shortcut: the first fill needs the acceptance even in a project where nothing runs", async () => {
    agentProjects.clear();
    expect((await service.policy("p1")).agentsPresent).toBe(false);
    expect((await errorOf(service.fill("p1", "id-1"))).code).toBe("LOGIN_RISK_UNACCEPTED");
    expect(fake.runs()).toHaveLength(0);
  });

  it("when the engine cannot tell whether agents run, it assumes they do", async () => {
    await service.setRisk("p1", true);
    service = createLoginService({
      config,
      store,
      keychain: createKeychain({ config, env: {} }),
      page,
      logger,
      agentsPresent: async () => {
        throw new Error("bilinmiyor");
      },
    });
    expect((await service.policy("p1")).agentsPresent).toBe(true);
    expect((await errorOf(service.fill("p1", "id-1"))).code).toBe("LOGIN_RISK_UNACCEPTED");
    expect(await service.fill("p1", "id-1", { confirmAgentRisk: true })).toEqual(["username", "password"]);
  });

  it("deleting the project forgets the acceptance", async () => {
    await service.setRisk("p1", true);
    service.forgetProject("p1");
    await service.idle();
    expect(store.isLoginRiskAccepted("p1")).toBe(false);
  });
});

describe("logins.fill: Anahtar Zinciri onayı — tek istek, reddedilince bekleme", () => {
  beforeEach(async () => {
    await save();
    fake.clearRuns();
    page.calls.length = 0;
  });

  it("a second fill of the same login while the first waits for the dialog is refused at once: one dialog, not two", async () => {
    service = make({ confirmTimeoutMs: 8000 });
    fake.mode("allow-after:1200");
    const first = service.fill("p1", "id-1");
    await new Promise((r) => setTimeout(r, 100));
    const second = await errorOf(service.fill("p1", "id-1"));
    expect(second.code).toBe("KEYCHAIN_FAILED");
    expect(second.message).toMatch(/onayı bekleniyor/);
    expect(second.message).toMatch(/ekranında/);
    expect(await first).toEqual(["username", "password"]);
    expect(fake.commands().filter((c) => c[0] === "find-generic-password")).toHaveLength(1);
  });

  it.each(["canceled", "slow"] as const)("after %s the same login is not read again during the cool-down — no dialog spam", async (mode) => {
    service = make({ confirmTimeoutMs: 600, denyCooldownMs: 30_000, fillRateMax: 100 });
    fake.mode(mode);
    expect((await errorOf(service.fill("p1", "id-1"))).code).toBe("KEYCHAIN_FAILED");
    fake.mode("ok");
    fake.clearRuns();
    for (let i = 0; i < 3; i++) {
      const err = await errorOf(service.fill("p1", "id-1"));
      expect(err.code).toBe("KEYCHAIN_FAILED");
      expect(err.message).toMatch(/saniye sonra/);
    }
    expect(fake.runs()).toHaveLength(0);
    clock += 30_001;
    expect(await service.fill("p1", "id-1")).toEqual(["username", "password"]);
  });

  it("another login is not held back by that cool-down", async () => {
    await save({ username: "iki" });
    service = make({ confirmTimeoutMs: 600, denyCooldownMs: 30_000 });
    fake.mode("canceled");
    await errorOf(service.fill("p1", "id-1"));
    fake.mode("ok");
    expect(await service.fill("p1", "id-2")).toEqual(["username", "password"]);
  });

  it("nobody answered the dialog: the message says an approval was awaited and where", async () => {
    service = make({ confirmTimeoutMs: 600 });
    fake.mode("slow");
    const err = await errorOf(service.fill("p1", "id-1"));
    expect(err.message).toMatch(/onay/);
    expect(err.message).toMatch(/ekranında/);
  });
});

describe("logins.delete / project deletion", () => {
  it("delete removes the Keychain item and the metadata", async () => {
    await save();
    await service.delete("id-1");
    expect(service.list("p1")).toEqual([]);
    expect(fake.items()).toEqual({});
    expect((await errorOf(service.delete("id-1"))).code).toBe("NOT_FOUND");
  });

  it("an item already gone from the Keychain still deletes the login", async () => {
    await save();
    await createKeychain({ config, env: {} }).delete({ service: "dev.kokpit.login.p1", account: "id-1" });
    await service.delete("id-1");
    expect(service.list("p1")).toEqual([]);
  });

  it("a Keychain that refuses keeps the login (so the user can retry) and says why", async () => {
    await save();
    fake.mode("locked", "delete-generic-password");
    const err = await errorOf(service.delete("id-1"));
    expect(err.code).toBe("KEYCHAIN_FAILED");
    expect(service.list("p1")).toHaveLength(1);
    fake.mode("ok");
    await service.delete("id-1");
    expect(fake.items()).toEqual({});
  });

  it("deleting a project deletes its Keychain items and forgets its logins at once; other projects are untouched", async () => {
    await save();
    await save({ username: "iki" });
    await save({ projectId: "p2" });
    service.forgetProject("p1");
    expect(service.list("p1")).toEqual([]); // synchronously
    await service.idle();
    expect(Object.keys(fake.items())).toEqual(["dev.kokpit.login.p2\nid-3"]);
    expect(service.list("p2")).toHaveLength(1);
    expect(store.listLoginOrphans()).toEqual([]);
  });

  it("items that cannot be deleted now are remembered and deleted after the next Keychain operation that works", async () => {
    await save();
    await save({ username: "iki" });
    fake.mode("locked", "delete-generic-password");
    service.forgetProject("p1");
    await service.idle();
    expect(service.list("p1")).toEqual([]);
    expect(store.listLoginOrphans()).toEqual([
      { service: "dev.kokpit.login.p1", account: "id-1" },
      { service: "dev.kokpit.login.p1", account: "id-2" },
    ]);
    expect(Object.keys(fake.items())).toHaveLength(2);
    expect(logs.some((l) => l.level === "warn" && /keychain item/.test(l.msg))).toBe(true);
    // The engine restarts; the Keychain works again; the user saves something.
    fake.mode("ok");
    service = make();
    await save({ projectId: "p2" });
    await service.idle();
    expect(store.listLoginOrphans()).toEqual([]);
    expect(Object.keys(fake.items())).toEqual(["dev.kokpit.login.p2\nid-3"]);
  });

  it("forgetting a project without logins runs nothing", async () => {
    service.forgetProject("p9");
    await service.idle();
    expect(fake.runs()).toHaveLength(0);
  });
});

describe("monkey", () => {
  it("random passwords: stored, filled as given, never in the state or the log", async () => {
    for (let i = 0; i < 8; i++) {
      let secret = "";
      const n = 1 + Math.floor(Math.random() * 40);
      for (let j = 0; j < n; j++) {
        const cp = 0x20 + Math.floor(Math.random() * 0x2fff);
        secret += String.fromCodePoint(cp);
      }
      const login = await save({ username: `u${i}`, password: secret });
      await service.fill("p1", login.id);
      expect(page.fills().at(-1)!.args[2]).toBe(secret);
      if (secret.length >= 6) expect(JSON.stringify(logs) + readFileSync(stateFile, "utf8")).not.toContain(secret);
    }
  });

  it("concurrent saves of one login end with one item and one record", async () => {
    await Promise.all([save({ password: "bir-parola" }), save({ password: "iki-parola" }), save({ password: "üç-parola" })]);
    expect(service.list("p1")).toHaveLength(1);
    expect(Object.keys(fake.items())).toHaveLength(1);
    expect(fake.items()["dev.kokpit.login.p1\nid-1"]).toBe(encodeSecret("üç-parola", config));
  });
});
