// End-to-end for Claude kullanımı against the real engine: temp HOME with two account folders holding SYNTHETIC
// transcripts (test/fixtures/claude-usage.ts), a fake `claude` on PATH for the probe. The real `claude`, the user's
// ~/.claude* and credentials are never touched.
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeUsageResultSchema, type ClaudeAccount, type ClaudeUsageResult, type Project } from "@kokpit/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installFakeClaude, type FakeClaude } from "./fakes/fake-claude-agents-setup.ts";
import { appendTranscript, SECRET_SUBDIR, SECRET_TEXT, SECRET_TITLE, writeTranscript } from "./fixtures/claude-usage.ts";
import { Client, startEngine, stopEngine, type EngineProc } from "./harness.ts";

const KEY = randomBytes(32).toString("base64url");
const WAIT_MS = 15_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const REFRESH_MS = 1000;

let root: string;
let home: string;
let dataDir: string;
let engine: EngineProc | undefined;
let c: Client;
let fake: FakeClaude;
let work: ClaudeAccount;
let alfa: Project;
let benimTranscript: string;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const get = (params: Record<string, unknown> = {}) => c.req<ClaudeUsageResult>("claudeUsage.get", params);

async function until(ok: (r: ClaudeUsageResult) => boolean, params: Record<string, unknown> = {}): Promise<ClaudeUsageResult> {
  const start = Date.now();
  for (;;) {
    const r = await get(params);
    if (ok(r)) return r;
    if (Date.now() - start > WAIT_MS) throw new Error(`timeout; last: ${JSON.stringify(r)}`);
    await sleep(50);
  }
}

async function rejects(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    return e as { code: string; message: string };
  }
  throw new Error("expected the request to fail");
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-e2e-usage-")));
  home = join(root, "home");
  dataDir = join(root, "data");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(root, "alfa"));
  // A credentials file with a marker: it must never be opened, so the marker can never appear anywhere.
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: `${SECRET_TEXT}-TOKEN` } }));
  const now = Date.now();
  benimTranscript = writeTranscript(join(home, ".claude"), "-alfa/s1.jsonl", [
    { id: "b1", t: now - HOUR, cwd: join(root, "alfa"), input: 100, output: 2000, cacheWrite: 30_000, cacheRead: 400_000, blocks: 3 },
    { id: "b2", t: now - 2 * DAY, cwd: `/x/${SECRET_SUBDIR}/serbest`, model: "claude-haiku-5-5", input: 1, output: 2, cacheWrite: 3, cacheRead: 4 },
  ]);
  writeTranscript(join(home, ".claude-work"), "-beta/s1.jsonl", [{ id: "k1", t: now - 30 * 60_000, cwd: "/x/beta", input: 7, output: 70, cacheWrite: 700, cacheRead: 7000 }]);

  fake = installFakeClaude(root, []);
  const configPath = join(root, "engine.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      dataDir,
      port: 0,
      shell: "/bin/sh",
      shellArgs: [],
      listenTailscale: false,
      killGraceMs: 200,
      claudeUsage: { refreshIntervalMs: REFRESH_MS },
    }),
  );
  engine = await startEngine({
    KOKPIT_CONFIG: configPath,
    KOKPIT_KEY: KEY,
    KOKPIT_BG_AGENTS_POLL_MS: "0",
    HOME: home,
    PATH: `${fake.binDir}:${process.env.PATH ?? ""}`,
    ...fake.env,
  });
  c = await Client.connect(engine.port, KEY);
  work = (await c.req<{ account: ClaudeAccount }>("claudeAccounts.create", { name: "Work", configDir: "~/.claude-work" })).account;
  alfa = (await c.req<{ project: Project }>("projects.create", { name: "Alfa", location: { kind: "local", path: join(root, "alfa") } })).project;
});

afterAll(async () => {
  await c?.close();
  await stopEngine(engine);
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("claudeUsage over the wire", () => {
  it("the first answer comes at once (indexing), then claudeUsage.changed and the numbers", async () => {
    const first = await get();
    expect(ClaudeUsageResultSchema.safeParse(first).success).toBe(true);
    expect(first.accounts.map((a) => a.accountId)).toEqual(["benim", work.id]);
    const r = await until((x) => x.accounts.every((a) => !a.indexing && a.updatedAt !== undefined));
    expect(c.frames.some((f) => f.type === "event" && f.name === "claudeUsage.changed")).toBe(true);
    expect(ClaudeUsageResultSchema.safeParse(r).success).toBe(true);
    const [benim, k] = r.accounts;
    expect(benim!.windows.session.totals).toEqual({ messages: 1, input: 100, output: 2000, cacheWrite: 30_000, cacheRead: 400_000 });
    expect(benim!.windows.week.totals.messages).toBe(2);
    expect(benim!.windows.week.byModel.map((m) => m.family)).toEqual(["opus", "haiku"]);
    expect(benim!.windows.week.topProjects).toEqual([
      { projectId: alfa.id, name: "Alfa", messages: 1, input: 100, output: 2000, cacheWrite: 30_000, cacheRead: 400_000 },
      { name: "serbest", messages: 1, input: 1, output: 2, cacheWrite: 3, cacheRead: 4 },
    ]);
    expect(k!.windows.session.totals).toEqual({ messages: 1, input: 7, output: 70, cacheWrite: 700, cacheRead: 7000 });
    expect(r).toMatchObject({ sessionWindowHours: 5, longWindowDays: 7, refreshIntervalMs: REFRESH_MS, probeAvailable: true });
    expect(r.pricesAsOf).toBeUndefined();
    expect(benim!.plan).toBeUndefined();
  });

  it("one account can be asked for; an unknown one is NOT_FOUND", async () => {
    const r = await get({ accountId: work.id });
    expect(r.accounts.map((a) => a.name)).toEqual(["Work"]);
    expect((await rejects(get({ accountId: "yok" }))).code).toBe("NOT_FOUND");
  });

  it("new messages show up after a refresh", async () => {
    appendTranscript(benimTranscript, [{ id: "b3", t: Date.now() - 1000, cwd: join(root, "alfa"), output: 5 }], Date.now());
    const r = await until((x) => x.accounts[0]!.windows.session.totals.messages === 2, { refresh: true });
    expect(r.accounts[0]!.windows.session.totals.output).toBe(2005);
  });

  it("the probe runs the fake claude with the account's config dir and reports its quota figures", async () => {
    const resetsAt = Math.round((Date.now() + DAY) / 1000);
    fake.setRateLimits(join(home, ".claude-work"), { seven_day: { utilization: 0.59, resetsAt }, five_hour: { utilization: 0.08, resetsAt } });
    expect((await rejects(c.req("claudeUsage.probe", { accountId: work.id }))).code).toBe("INVALID"); // no confirm
    const r = await c.req<ClaudeUsageResult>("claudeUsage.probe", { accountId: work.id, confirm: true });
    expect(r.accounts[0]!.plan?.sevenDay).toMatchObject({ usedPercent: 59, source: "probe", resetsAt: new Date(resetsAt * 1000).toISOString() });
    expect(r.accounts[0]!.plan?.fiveHour?.usedPercent).toBeCloseTo(8, 6);
    const call = fake.calls().at(-1)!;
    expect(call.slice(0, 2)).toEqual(["-p", "ok"]);
    expect(call).toContain("--no-session-persistence");
    // The default account was not asked and has no figures; asking again at once is refused.
    expect((await get({ accountId: "benim" })).accounts[0]!.plan).toBeUndefined();
    expect((await rejects(c.req("claudeUsage.probe", { accountId: work.id, confirm: true }))).message).toMatch(/saniye sonra/);
    // The default account's claude reports nothing (not logged in): a clear failure, nothing stored.
    const err = await rejects(c.req("claudeUsage.probe", { accountId: "benim", confirm: true }));
    expect(err.code).toBe("CLAUDE_FAILED");
    expect(err.message).not.toContain("FAKE-PROBE-ANSWER");
  });

  it("nothing but numbers and names left the transcripts: wire, engine log and cache hold no text, title, deep path or token", async () => {
    const wire = JSON.stringify(await get());
    const log = engine!.logs();
    const cacheDir = join(dataDir, "claude-usage");
    const cache = readdirSync(cacheDir)
      .filter((f) => f.endsWith(".ndjson"))
      .map((f) => readFileSync(join(cacheDir, f), "utf8"))
      .join("\n");
    expect(cache.length).toBeGreaterThan(0);
    for (const secret of [SECRET_TEXT, SECRET_TITLE, "FAKE-PROBE-ANSWER"]) {
      expect(wire).not.toContain(secret);
      expect(log).not.toContain(secret);
      expect(cache).not.toContain(secret);
    }
    expect(wire).not.toContain(SECRET_SUBDIR);
    expect(log).not.toContain(SECRET_SUBDIR);
  });
});
