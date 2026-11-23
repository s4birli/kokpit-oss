// Claude kullanımı — the transcript reader, its windows, cache, isolation and privacy. Fixture dirs only
// (test/fixtures/claude-usage.ts builds synthetic transcripts); the real ~/.claude* is never read.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeUsageResultSchema, type Card, type ClaudeUsageAccount, type Project } from "@kokpit/shared";
import type { AccountDir } from "./claude-accounts.ts";
import {
  createClaudeUsageService,
  extractUsage,
  folderName,
  loadClaudeUsageConfig,
  modelFamily,
  parseProbeOutput,
  type ClaudeUsageConfig,
  type ClaudeUsageService,
  type UsageRunner,
} from "./claude-usage.ts";
import { EngineError, type Logger } from "./contracts.ts";
import {
  appendTranscript,
  assistantLines,
  SECRET_SUBDIR,
  SECRET_TEXT,
  SECRET_TITLE,
  touch,
  writeTranscript,
  type FixtureMessage,
} from "../test/fixtures/claude-usage.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const MIDNIGHT = Date.parse("2026-11-18T00:00:00.000Z");
const STATUSLINE = fileURLToPath(new URL("../wrappers/claude-kullanim-durum-satiri.mjs", import.meta.url));

let root: string;
let benim: string;
let work: string;
let dataDir: string;
let logs: string[];
let services: ClaudeUsageService[];

const logger: Logger = {
  info: (m, e) => logs.push(`${m} ${JSON.stringify(e ?? {})}`),
  warn: (m, e) => logs.push(`${m} ${JSON.stringify(e ?? {})}`),
  error: (m, e) => logs.push(`${m} ${JSON.stringify(e ?? {})}`),
  debug: (m, e) => logs.push(`${m} ${JSON.stringify(e ?? {})}`),
};

const accounts = (): AccountDir[] => [
  { accountId: "benim", name: "Benim", configDir: benim, isDefault: true },
  { accountId: "work", name: "Work", configDir: work, isDefault: false },
];

interface Opts {
  config?: Partial<ClaudeUsageConfig>;
  now?: () => number;
  projects?: Project[];
  cards?: Card[];
  run?: UsageRunner;
  uid?: number;
  accounts?: () => AccountDir[];
}

function service(o: Opts = {}): ClaudeUsageService {
  const svc = createClaudeUsageService({
    config: loadClaudeUsageConfig(o.config ?? {}),
    dataDir,
    logger,
    accounts: o.accounts ?? accounts,
    projects: () => o.projects ?? [],
    cards: () => o.cards ?? [],
    claudeBinary: "claude",
    now: o.now ?? (() => NOW),
    startOfDay: () => MIDNIGHT,
    ...(o.run ? { run: o.run } : {}),
    ...(o.uid !== undefined ? { uid: o.uid } : {}),
  });
  services.push(svc);
  return svc;
}

/** Runs a pass and returns the account's view. */
async function read(svc: ClaudeUsageService, accountId = "benim"): Promise<ClaudeUsageAccount> {
  await svc.refresh();
  const r = svc.get({ accountId });
  expect(ClaudeUsageResultSchema.safeParse(r).success).toBe(true);
  return r.accounts[0]!;
}

const msg = (id: string, agoMs: number, extra: Partial<FixtureMessage> = {}): FixtureMessage => ({
  id,
  t: NOW - agoMs,
  input: 10,
  output: 100,
  cacheWrite: 1000,
  cacheRead: 10_000,
  ...extra,
});

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-usage-")));
  benim = join(root, "home", ".claude");
  work = join(root, "home", ".claude-work");
  dataDir = join(root, "data");
  for (const d of [benim, work, dataDir]) mkdirSync(d, { recursive: true });
  logs = [];
  services = [];
});

afterEach(async () => {
  for (const s of services) await s.dispose();
  rmSync(root, { recursive: true, force: true });
});

describe("pure helpers", () => {
  it("modelFamily strips the vendor prefix, versions and dates", () => {
    expect(modelFamily("claude-opus-5-5", "claude-")).toBe("opus");
    expect(modelFamily("claude-haiku-4-5-20251001", "claude-")).toBe("haiku");
    expect(modelFamily("claude-3-5-sonnet-20241022", "claude-")).toBe("sonnet");
    expect(modelFamily("claude-fable-5-2[1m]", "claude-")).toBe("fable");
    expect(modelFamily("gpt-9", "claude-")).toBe("gpt");
    expect(modelFamily("12345", "claude-")).toBe("12345");
  });

  it("folderName keeps only the last folder, and the repo's name for a Claude worktree", () => {
    const markers = ["/.claude/worktrees/"];
    expect(folderName("/Users/x/work/kokpit", markers)).toBe("kokpit");
    expect(folderName("/Users/x/work/kokpit/", markers)).toBe("kokpit");
    expect(folderName("/Users/x/work/kokpit/.claude/worktrees/agent-1", markers)).toBe("kokpit");
    expect(folderName("/", markers)).toBeUndefined();
    expect(folderName("", markers)).toBeUndefined();
  });

  it("extractUsage returns numbers, ids, model, time and cwd — and nothing else", () => {
    const [line] = assistantLines(msg("m1", HOUR, { cwd: "/w/alfa", model: "claude-sonnet-5" }));
    const u = extractUsage(line!, ["<synthetic>"]);
    expect(u).toEqual({ id: "m1", requestId: "req-m1", t: NOW - HOUR, model: "claude-sonnet-5", cwd: "/w/alfa", input: 10, output: 100, cacheWrite: 1000, cacheRead: 10_000 });
    expect(JSON.stringify(u)).not.toContain(SECRET_TEXT);
    expect(JSON.stringify(u)).not.toContain(SECRET_TITLE);
  });

  it("extractUsage refuses everything that is not a well-formed assistant usage line", () => {
    const base = JSON.parse(assistantLines(msg("m1", HOUR))[0]!) as Record<string, unknown> & { message: Record<string, unknown> };
    const bad: unknown[] = [
      { ...base, type: "user" },
      { ...base, timestamp: "dün" },
      { ...base, message: { ...base.message, usage: undefined } },
      { ...base, message: { ...base.message, usage: "çok" } },
      { ...base, message: { ...base.message, model: "<synthetic>" } },
      { ...base, message: { ...base.message, model: 5 } },
      { ...base, message: { ...base.message, id: undefined }, uuid: undefined },
      [1, 2, 3],
      null,
      "metin",
    ];
    for (const b of bad) expect(extractUsage(JSON.stringify(b), ["<synthetic>"])).toBeUndefined();
    for (const t of ["", "{", "{\"type\":\"assistant\"", "\u0000\u0001"]) expect(extractUsage(t, [])).toBeUndefined();
    // Negative, fractional, huge and non-numeric counts become 0 / are clamped; the line still counts as a message.
    const odd = { ...base, message: { ...base.message, usage: { input_tokens: -5, output_tokens: 1.9, cache_creation_input_tokens: "9", cache_read_input_tokens: 1e300 } } };
    expect(extractUsage(JSON.stringify(odd), [])).toMatchObject({ input: 0, output: 1, cacheWrite: 0, cacheRead: Number.MAX_SAFE_INTEGER });
  });

  it("parseProbeOutput reads only rate-limit events", () => {
    const out = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: SECRET_TEXT }] } }),
      "bozuk satır {",
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed",
          resetsAt: 1795042800,
          rateLimitType: "seven_day",
          unifiedWindows: { seven_day: { utilization: 0.59, resetsAt: 1795042800, status: "allowed" }, five_hour: { utilization: 0.125, resetsAt: 1795000000 } },
        },
      }),
    ].join("\n");
    expect(parseProbeOutput(out, 100)).toEqual({
      sevenDay: { usedPercent: 59, resetsAt: 1795042800_000 },
      fiveHour: { usedPercent: 12.5, resetsAt: 1795000000_000 },
    });
    expect(parseProbeOutput("", 100)).toEqual({});
    expect(parseProbeOutput(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { seven_day: { utilization: "x" } } } }), 100)).toEqual({});
  });
});

describe("counting", () => {
  it("sums the four token kinds and counts messages per window", async () => {
    writeTranscript(benim, "-w-alfa/s1.jsonl", [msg("a", HOUR), msg("b", 2 * HOUR), msg("c", 30 * HOUR)]);
    const a = await read(service());
    expect(a.windows.session.totals).toEqual({ messages: 2, input: 20, output: 200, cacheWrite: 2000, cacheRead: 20_000 });
    expect(a.windows.week.totals).toEqual({ messages: 3, input: 30, output: 300, cacheWrite: 3000, cacheRead: 30_000 });
    expect(a.updatedAt).toBe(new Date(NOW).toISOString());
    expect(a.indexing).toBe(false);
    expect(a.error).toBeUndefined();
  });

  it("counts a message once although Claude Code writes one line per content block", async () => {
    writeTranscript(benim, "-w-alfa/s1.jsonl", [msg("a", HOUR, { blocks: 3 }), msg("b", HOUR, { blocks: 5 })]);
    const a = await read(service());
    expect(a.windows.session.totals).toEqual({ messages: 2, input: 20, output: 200, cacheWrite: 2000, cacheRead: 20_000 });
  });

  it("takes the largest figures when streamed lines of one message disagree", async () => {
    writeTranscript(benim, "-w-alfa/s1.jsonl", [msg("a", HOUR, { output: 3 }), msg("a", HOUR, { output: 250 }), msg("a", HOUR, { output: 40 })]);
    expect((await read(service())).windows.session.totals).toMatchObject({ messages: 1, output: 250, input: 10 });
  });

  it("does not double count history copied into a resumed or forked session's file", async () => {
    const history = [msg("a", 3 * HOUR), msg("b", 2 * HOUR)];
    writeTranscript(benim, "-w-alfa/s1.jsonl", history);
    writeTranscript(benim, "-w-alfa/s2-resumed.jsonl", [...history, msg("c", HOUR)]);
    writeTranscript(benim, "-w-alfa/s2-resumed/subagents/agent-x.jsonl", [msg("d", HOUR)]);
    expect((await read(service())).windows.session.totals.messages).toBe(4);
  });

  it("the same message id under another request id is another request; a line without request id still counts once", async () => {
    writeTranscript(benim, "-w-alfa/s1.jsonl", [
      msg("a", HOUR, { requestId: "r1" }),
      msg("a", HOUR, { requestId: "r2" }),
      msg("n", HOUR, { requestId: null, blocks: 2 }),
    ]);
    expect((await read(service())).windows.session.totals.messages).toBe(3);
  });

  it("groups by model family, largest first, and skips synthetic messages", async () => {
    writeTranscript(benim, "-w-alfa/s1.jsonl", [
      msg("a", HOUR, { model: "claude-opus-5-5" }),
      msg("b", HOUR, { model: "claude-opus-4-8" }),
      msg("c", HOUR, { model: "claude-haiku-5-5", cacheRead: 5 }),
      msg("d", HOUR, { model: "<synthetic>" }),
    ]);
    const w = (await read(service())).windows.session;
    expect(w.byModel.map((m) => [m.family, m.messages])).toEqual([
      ["opus", 2],
      ["haiku", 1],
    ]);
    expect(w.totals.messages).toBe(3);
  });

  it("tolerates malformed lines, blank lines and a file without a final newline", async () => {
    const file = writeTranscript(benim, "-w-alfa/s1.jsonl", [msg("a", HOUR)], { raw: ["{bozuk", "", "null", "[]", "\u0000\u0000", '{"type":"assistant","message":{"usage":'] });
    // A last line still being written (no newline) is not counted yet …
    writeFileSync(file, readFileSync(file, "utf8") + assistantLines(msg("b", HOUR))[0]!);
    touch(file, NOW - HOUR);
    const svc = service();
    expect((await read(svc)).windows.session.totals.messages).toBe(1);
    // … and is counted once its newline arrives.
    writeFileSync(file, `${readFileSync(file, "utf8")}\n`);
    touch(file, NOW - HOUR + 1000);
    expect((await read(svc)).windows.session.totals.messages).toBe(2);
  });

  it("skips a line longer than maxLineBytes without buffering it, keeps counting after it and says the result is partial", async () => {
    const big = JSON.stringify({ type: "assistant", pad: "x".repeat(300_000), ...JSON.parse(assistantLines(msg("big", HOUR))[0]!) });
    writeTranscript(benim, "-w-alfa/s1.jsonl", [msg("a", HOUR)], { raw: [big, ...assistantLines(msg("b", HOUR))] });
    const a = await read(service({ config: { maxLineBytes: 65_536, readChunkBytes: 4096 } }));
    expect(a.windows.session.totals.messages).toBe(2);
    expect(a.partial).toBe(true);
  });

  it("reads lines that span many read chunks", async () => {
    writeTranscript(benim, "-w-alfa/s1.jsonl", Array.from({ length: 200 }, (_, i) => msg(`m${i}`, HOUR, { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 })));
    const a = await read(service({ config: { readChunkBytes: 1024 } }));
    expect(a.windows.session.totals).toEqual({ messages: 200, input: 200, output: 200, cacheWrite: 200, cacheRead: 200 });
  });

  it("an account whose folder has no transcripts yet reads as zero, without error", async () => {
    const a = await read(service(), "work");
    expect(a.windows.week.totals).toEqual({ messages: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
    expect(a.error).toBeUndefined();
    expect(a.updatedAt).toBeDefined();
  });

  it("an unknown account is NOT_FOUND", () => {
    expect(() => service().get({ accountId: "yok" })).toThrowError(EngineError);
  });
});

describe("time windows (fake clock)", () => {
  it("5 hours and 7 days are rolling and inclusive at the boundary; today starts at local midnight", async () => {
    writeTranscript(benim, "-w-alfa/s1.jsonl", [
      msg("s-in", 5 * HOUR),
      msg("s-out", 5 * HOUR + 1),
      msg("t-in", NOW - MIDNIGHT),
      msg("t-out", NOW - MIDNIGHT + 1),
      msg("w-in", 7 * DAY),
      msg("w-out", 7 * DAY + 1),
      msg("future", -1),
    ]);
    const a = await read(service());
    expect(a.windows.session.totals.messages).toBe(1);
    expect(a.windows.today.totals.messages).toBe(3); // s-in, s-out, t-in
    expect(a.windows.week.totals.messages).toBe(5); // all but w-out and the future one
  });

  it("windows move with the clock without re-reading anything", async () => {
    let now = NOW;
    writeTranscript(benim, "-w-alfa/s1.jsonl", [msg("a", HOUR), msg("b", 4 * HOUR)]);
    const svc = service({ now: () => now });
    expect((await read(svc)).windows.session.totals.messages).toBe(2);
    const bytes = svc.stats().bytesRead;
    now = NOW + 2 * HOUR;
    expect(svc.get({ accountId: "benim" }).accounts[0]!.windows.session.totals.messages).toBe(1);
    now = NOW + 8 * DAY;
    expect((await read(svc)).windows.week.totals.messages).toBe(0);
    expect(svc.stats().bytesRead).toBe(bytes);
  });

  it("honours the configured window lengths", async () => {
    writeTranscript(benim, "-w-alfa/s1.jsonl", [msg("a", HOUR), msg("b", 2 * HOUR), msg("c", 3 * DAY)]);
    const svc = service({ config: { sessionWindowHours: 1, longWindowDays: 2 } });
    const a = await read(svc);
    expect(a.windows.session.totals.messages).toBe(1);
    expect(a.windows.week.totals.messages).toBe(2);
    expect(svc.get({})).toMatchObject({ sessionWindowHours: 1, longWindowDays: 2 });
  });
});

describe("accounts are isolated", () => {
  it("each account's numbers come only from its own config dir", async () => {
    writeTranscript(benim, "-w-alfa/s1.jsonl", [msg("a", HOUR), msg("b", HOUR)]);
    writeTranscript(work, "-w-beta/s1.jsonl", [msg("k", HOUR, { output: 7 })]);
    const svc = service();
    await svc.refresh();
    const all = svc.get({}).accounts;
    expect(all.map((a) => [a.accountId, a.name, a.isDefault ?? false, a.windows.session.totals.messages])).toEqual([
      ["benim", "Benim", true, 2],
      ["work", "Work", false, 1],
    ]);
    expect(all[1]!.windows.session.totals.output).toBe(7);
  });

  it("the same message id in two accounts counts in both (no cross-account dedupe)", async () => {
    writeTranscript(benim, "-w-alfa/s1.jsonl", [msg("same", HOUR)]);
    writeTranscript(work, "-w-alfa/s1.jsonl", [msg("same", HOUR)]);
    const svc = service();
    await svc.refresh();
    expect(svc.get({}).accounts.map((a) => a.windows.session.totals.messages)).toEqual([1, 1]);
  });

  it("shared-skills symlinks into the default account do not leak its transcripts", async () => {
    writeTranscript(benim, "-w-alfa/s1.jsonl", [msg("a", HOUR)]);
    mkdirSync(join(benim, "skills"));
    symlinkSync(join(benim, "skills"), join(work, "skills"), "dir");
    expect((await read(service(), "work")).windows.week.totals.messages).toBe(0);
  });

  it("follows no symlink out of the config dir: linked project folders, linked files and a linked projects folder are ignored", async () => {
    const outside = join(root, "outside");
    writeTranscript(outside, "-w-x/s1.jsonl", [msg("o1", HOUR)]);
    writeTranscript(benim, "-w-alfa/s1.jsonl", [msg("a", HOUR)]);
    symlinkSync(join(outside, "projects", "-w-x"), join(benim, "projects", "-linked-dir"), "dir");
    symlinkSync(join(outside, "projects", "-w-x", "s1.jsonl"), join(benim, "projects", "-w-alfa", "linked.jsonl"), "file");
    expect((await read(service())).windows.session.totals.messages).toBe(1);

    // work's whole projects folder is a link to somewhere else: nothing is read, and the user is told.
    symlinkSync(join(outside, "projects"), join(work, "projects"), "dir");
    const k = await read(service(), "work");
    expect(k.windows.week.totals.messages).toBe(0);
    expect(k.error).toMatch(/sembolik bağ/);
  });

  it("ignores files that are not owned by the engine's user", async () => {
    writeTranscript(benim, "-w-alfa/s1.jsonl", [msg("a", HOUR)]);
    const svc = service({ uid: (process.getuid?.() ?? 0) + 1 });
    expect((await read(svc)).windows.week.totals.messages).toBe(0);
    expect(svc.stats().bytesRead).toBe(0);
  });

  it("two accounts on one folder share one reading", async () => {
    writeTranscript(benim, "-w-alfa/s1.jsonl", [msg("a", HOUR)]);
    const svc = service({
      accounts: () => [
        { accountId: "benim", name: "Benim", configDir: benim, isDefault: true },
        { accountId: "ikiz", name: "İkiz", configDir: benim, isDefault: false },
      ],
    });
    await svc.refresh();
    expect(svc.get({}).accounts.map((a) => a.windows.week.totals.messages)).toEqual([1, 1]);
    expect(svc.stats().filesRead).toBe(1);
  });
});

describe("projects", () => {
  const project = (id: string, name: string, path: string): Project => ({ id, name, location: { kind: "local", path } });

  it("maps a session's folder to the Kokpit project (or card worktree) holding it; others show their folder name only", async () => {
    const alfa = join(root, "work", "alfa");
    const cardTree = join(root, "data", "worktrees", "kart-1");
    writeTranscript(benim, "-a/s1.jsonl", [
      msg("p1", HOUR, { cwd: alfa }),
      msg("p2", HOUR, { cwd: join(alfa, "packages", SECRET_SUBDIR) }),
      msg("p3", HOUR, { cwd: join(alfa, ".claude", "worktrees", "agent-9") }),
      msg("c1", HOUR, { cwd: cardTree, output: 5 }),
      msg("u1", HOUR, { cwd: `/somewhere/${SECRET_SUBDIR}/serbest`, output: 1 }),
      msg("u2", HOUR, { cwd: "/somewhere/else/serbest/.claude/worktrees/w1", output: 1 }),
      msg("u3", HOUR, { cwd: "", output: 2, input: 0, cacheWrite: 0, cacheRead: 0 }),
    ]);
    const svc = service({
      projects: [project("alfa", "Alfa / iş", alfa), project("beta", "Beta", join(root, "work", "beta"))],
      cards: [{ id: "kart-1", projectId: "beta", name: "K", branch: "b", worktreePath: cardTree, createdAt: new Date(NOW).toISOString() }],
    });
    const top = (await read(svc)).windows.session.topProjects;
    expect(top.map((p) => [p.projectId, p.name, p.messages])).toEqual([
      ["alfa", "Alfa - iş", 3],
      [undefined, "serbest", 2],
      ["beta", "Beta", 1],
      [undefined, "Bilinmeyen klasör", 1],
    ]);
    expect(JSON.stringify(svc.get({}))).not.toContain(SECRET_SUBDIR);
  });

  it("returns only the top projects, largest first", async () => {
    writeTranscript(
      benim,
      "-a/s1.jsonl",
      Array.from({ length: 9 }, (_, i) => msg(`m${i}`, HOUR, { cwd: `/w/proje-${i}`, output: i * 1000 })),
    );
    const top = (await read(service({ config: { topProjects: 3 } }))).windows.week.topProjects;
    expect(top.map((p) => p.name)).toEqual(["proje-8", "proje-7", "proje-6"]);
  });
});

describe("incremental reading and the cache", () => {
  it("reads only appended bytes on the next pass", async () => {
    const file = writeTranscript(benim, "-a/s1.jsonl", Array.from({ length: 50 }, (_, i) => msg(`m${i}`, HOUR)), { mtime: NOW - HOUR });
    const svc = service();
    expect((await read(svc)).windows.session.totals.messages).toBe(50);
    const first = svc.stats().bytesRead;
    await svc.refresh();
    expect(svc.stats().bytesRead).toBe(first); // unchanged file: not opened
    const before = readFileSync(file).length;
    appendTranscript(file, [msg("new", 60_000)], NOW - 60_000);
    expect((await read(svc)).windows.session.totals.messages).toBe(51);
    expect(svc.stats().bytesRead - first).toBe(readFileSync(file).length - before);
  });

  it("never opens files last modified before the long window", async () => {
    writeTranscript(benim, "-a/old.jsonl", [msg("old", 30 * DAY)]);
    writeTranscript(benim, "-a/new.jsonl", [msg("new", HOUR)]);
    const svc = service();
    expect((await read(svc)).windows.week.totals.messages).toBe(1);
    expect(svc.stats().filesRead).toBe(1);
  });

  it("a restarted engine continues from the cache under the data dir (private, no message text)", async () => {
    const file = writeTranscript(benim, "-a/s1.jsonl", [msg("a", HOUR), msg("b", 2 * HOUR)], { mtime: NOW - HOUR });
    const one = service();
    await read(one);
    await one.dispose();

    const cacheDir = join(dataDir, "claude-usage");
    const cacheFiles = readdirSync(cacheDir).filter((f) => f.endsWith(".ndjson"));
    expect(cacheFiles.length).toBeGreaterThan(0);
    for (const f of cacheFiles) {
      const text = readFileSync(join(cacheDir, f), "utf8");
      expect(text).not.toContain(SECRET_TEXT);
      expect(text).not.toContain(SECRET_TITLE);
      expect(text).not.toContain("req-a"); // ids are stored hashed
      expect(execFileSync("/usr/bin/stat", ["-f", "%Lp", join(cacheDir, f)], { encoding: "utf8" }).trim()).toBe("600");
    }

    const two = service();
    expect((await read(two)).windows.session.totals.messages).toBe(2);
    expect(two.stats().bytesRead).toBe(0);
    appendTranscript(file, [msg("c", 60_000)], NOW - 60_000);
    expect((await read(two)).windows.session.totals.messages).toBe(3);
  });

  it("a rewritten (shorter) transcript invalidates what was counted from it", async () => {
    const file = writeTranscript(benim, "-a/s1.jsonl", [msg("a", HOUR), msg("b", HOUR), msg("c", HOUR)], { mtime: NOW - HOUR });
    writeTranscript(benim, "-a/s2.jsonl", [msg("z", HOUR)]);
    const svc = service();
    expect((await read(svc)).windows.session.totals.messages).toBe(4);
    writeFileSync(file, `${assistantLines(msg("a", HOUR))[0]!}\n`);
    touch(file, NOW - 1000);
    expect((await read(svc)).windows.session.totals.messages).toBe(2);
    expect(svc.stats().rebuilds).toBe(1);
  });

  it("a deleted recent transcript is no longer counted; a truncated one neither", async () => {
    const a = writeTranscript(benim, "-a/s1.jsonl", [msg("a", HOUR)]);
    const b = writeTranscript(benim, "-a/s2.jsonl", [msg("b", HOUR), msg("b2", HOUR)]);
    const svc = service();
    expect((await read(svc)).windows.session.totals.messages).toBe(3);
    rmSync(a);
    expect((await read(svc)).windows.session.totals.messages).toBe(2);
    truncateSync(b, 0);
    touch(b, NOW - 500);
    expect((await read(svc)).windows.session.totals.messages).toBe(0);
  });

  it("a damaged or foreign cache file is ignored and rebuilt", async () => {
    writeTranscript(benim, "-a/s1.jsonl", [msg("a", HOUR)]);
    const one = service();
    await read(one);
    await one.dispose();
    const cacheDir = join(dataDir, "claude-usage");
    for (const f of readdirSync(cacheDir).filter((x) => x.endsWith(".ndjson"))) writeFileSync(join(cacheDir, f), `{"v":999}\n{bozuk\n`);
    const two = service();
    expect((await read(two)).windows.session.totals.messages).toBe(1);
    expect(two.stats().bytesRead).toBeGreaterThan(0);
  });

  it("a cache written for other window lengths is not reused", async () => {
    writeTranscript(benim, "-a/s1.jsonl", [msg("a", HOUR), msg("old", 10 * DAY)], { mtime: NOW - HOUR });
    const one = service();
    expect((await read(one)).windows.week.totals.messages).toBe(1);
    await one.dispose();
    const two = service({ config: { longWindowDays: 14 } });
    expect((await read(two)).windows.week.totals.messages).toBe(2);
  });

  it("keeps at most maxMessages and reports the result as partial", async () => {
    writeTranscript(benim, "-a/s1.jsonl", Array.from({ length: 30 }, (_, i) => msg(`m${i}`, HOUR)));
    const a = await read(service({ config: { maxMessages: 10 } }));
    expect(a.windows.week.totals.messages).toBe(10);
    expect(a.partial).toBe(true);
  });

  it("stops a pass at maxPassBytes and continues where it stopped on the next one", async () => {
    for (let f = 0; f < 4; f++) writeTranscript(benim, `-a/s${f}.jsonl`, Array.from({ length: 20 }, (_, i) => msg(`f${f}m${i}`, HOUR)), { noise: false });
    const svc = service({ config: { maxPassBytes: 20_000, readChunkBytes: 4096 } });
    const first = await read(svc);
    expect(first.windows.week.totals.messages).toBeLessThan(80);
    expect(first.partial).toBe(true);
    let last = first;
    for (let i = 0; i < 20 && last.windows.week.totals.messages < 80; i++) last = await read(svc);
    expect(last.windows.week.totals.messages).toBe(80);
    expect(last.partial).toBeUndefined();
  });
});

describe("never blocks, never leaks", () => {
  it("answers at once while a pass runs and announces the result", async () => {
    writeTranscript(benim, "-a/s1.jsonl", [msg("a", HOUR)]);
    const svc = service();
    let changes = 0;
    svc.onChange(() => changes++);
    const early = svc.get({});
    expect(early.accounts.every((a) => a.indexing && a.updatedAt === undefined)).toBe(true);
    await svc.refresh();
    expect(changes).toBeGreaterThan(0);
    const late = svc.get({});
    expect(late.accounts[0]).toMatchObject({ indexing: false });
    expect(late.accounts[0]!.windows.session.totals.messages).toBe(1);
  });

  it("a second get inside the refresh interval starts no new pass; refresh:true and an elapsed interval do", async () => {
    let now = NOW;
    writeTranscript(benim, "-a/s1.jsonl", [msg("a", HOUR)]);
    const svc = service({ now: () => now, config: { refreshIntervalMs: 60_000 } });
    svc.get({});
    await svc.idle();
    expect(svc.stats().passes).toBe(1);
    svc.get({});
    await svc.idle();
    expect(svc.stats().passes).toBe(1);
    svc.get({ refresh: true });
    await svc.idle();
    expect(svc.stats().passes).toBe(2);
    now += 60_000;
    svc.get({});
    await svc.idle();
    expect(svc.stats().passes).toBe(3);
  });

  it("indexes a large transcript set in slices: the event loop keeps turning", async () => {
    // ~60 MB: 12 files × 5 000 messages with ~1 KB of text each, plus one 20 MB single line.
    const pad = "y".repeat(900);
    for (let f = 0; f < 12; f++) {
      const lines: string[] = [];
      for (let i = 0; i < 5000; i++) {
        const o = JSON.parse(assistantLines(msg(`f${f}m${i}`, HOUR, { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 }))[0]!) as { message: { content: unknown } };
        o.message.content = [{ type: "text", text: pad }];
        lines.push(JSON.stringify(o));
      }
      writeTranscript(benim, `-big/s${f}.jsonl`, [], { raw: lines, noise: false, mtime: NOW - HOUR });
    }
    writeTranscript(benim, "-big/huge-line.jsonl", [msg("after-huge", HOUR)], { raw: [JSON.stringify({ type: "user", blob: "z".repeat(20 * 1024 * 1024) })], mtime: NOW - HOUR });

    const svc = service();
    let maxGap = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const t = performance.now();
      maxGap = Math.max(maxGap, t - last);
      last = t;
    }, 1);
    const started = performance.now();
    await svc.refresh();
    const tookMs = performance.now() - started;
    clearInterval(timer);

    const a = svc.get({ accountId: "benim" }).accounts[0]!;
    expect(a.windows.session.totals.messages).toBe(60_001);
    const second = performance.now();
    await svc.refresh();
    const againMs = performance.now() - second;
    // eslint-disable-next-line no-console
    console.log(`[claude-usage perf] ${(svc.stats().bytesRead / 1e6).toFixed(0)} MB, 60 001 messages: first pass ${tookMs.toFixed(0)} ms, longest event-loop gap ${maxGap.toFixed(0)} ms, unchanged pass ${againMs.toFixed(1)} ms`);
    expect(maxGap).toBeLessThan(250);
  }, 120_000);

  it("no message text, session title, deep path or config dir appears in results or logs", async () => {
    writeTranscript(benim, "-a/s1.jsonl", [msg("a", HOUR, { cwd: `/w/${SECRET_SUBDIR}/proje` })], { raw: ["{bozuk " + SECRET_TEXT] });
    writeTranscript(work, "-a/s1.jsonl", [msg("k", HOUR)]);
    const svc = service();
    await svc.refresh();
    const out = JSON.stringify(svc.get({})) + logs.join("\n");
    for (const s of [SECRET_TEXT, SECRET_TITLE, SECRET_SUBDIR, benim, work, "req-a"]) expect(out).not.toContain(s);
    expect(out).toContain("proje");
  });
});

describe("estimated cost", () => {
  const prices = { asOf: "2026-11-01", perMillionUsd: { opus: { input: 10, output: 50, cacheWrite: 20, cacheRead: 1 } } };

  it("ships no price table: no cost and no price date by default", async () => {
    writeTranscript(benim, "-a/s1.jsonl", [msg("a", HOUR)]);
    const svc = service();
    const a = await read(svc);
    expect(a.windows.week.estimatedCostUsd).toBeUndefined();
    expect(svc.get({}).pricesAsOf).toBeUndefined();
  });

  it("with a dated price table, estimates the API-equivalent cost per window", async () => {
    writeTranscript(benim, "-a/s1.jsonl", [msg("a", HOUR, { input: 1_000_000, output: 2_000_000, cacheWrite: 500_000, cacheRead: 4_000_000 })]);
    const svc = service({ config: { prices } });
    const a = await read(svc);
    expect(a.windows.session.estimatedCostUsd).toBeCloseTo(10 + 100 + 10 + 4, 6);
    expect(svc.get({}).pricesAsOf).toBe("2026-11-01");
  });

  it("gives no cost for a window that used a model the table does not price", async () => {
    writeTranscript(benim, "-a/s1.jsonl", [msg("a", HOUR), msg("b", 10 * HOUR, { model: "claude-yeni-9" })]);
    const a = await read(service({ config: { prices } }));
    expect(a.windows.session.estimatedCostUsd).toBeDefined();
    expect(a.windows.week.estimatedCostUsd).toBeUndefined();
  });
});

describe("plan limits as Claude Code reports them", () => {
  const snapshot = (dir: string, body: unknown) => writeFileSync(join(dir, "kokpit-kullanim.json"), typeof body === "string" ? body : JSON.stringify(body));
  const SEC = (ms: number) => Math.round(ms / 1000);

  it("has no plan figures without a source — and reads no credentials file looking for one", async () => {
    writeFileSync(join(benim, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: SECRET_TEXT } }));
    const a = await read(service());
    expect(a.plan).toBeUndefined();
    expect(JSON.stringify(a) + logs.join("")).not.toContain(SECRET_TEXT);
  });

  it("reads the status line snapshot: percentages, reset times, when it was captured", async () => {
    snapshot(benim, {
      capturedAt: NOW - 120_000,
      rate_limits: { five_hour: { used_percentage: 23.5, resets_at: SEC(NOW + HOUR) }, seven_day: { used_percentage: 41.2, resets_at: SEC(NOW + 3 * DAY) } },
    });
    const a = await read(service());
    expect(a.plan).toEqual({
      fiveHour: { usedPercent: 23.5, resetsAt: new Date(NOW + HOUR).toISOString(), capturedAt: new Date(NOW - 120_000).toISOString(), source: "statusline" },
      sevenDay: { usedPercent: 41.2, resetsAt: new Date(NOW + 3 * DAY).toISOString(), capturedAt: new Date(NOW - 120_000).toISOString(), source: "statusline" },
    });
    expect((await read(service(), "work")).plan).toBeUndefined();
  });

  it("drops a window whose reset time has passed, as Claude Code does", async () => {
    snapshot(benim, {
      capturedAt: NOW - 6 * HOUR,
      rate_limits: { five_hour: { used_percentage: 90, resets_at: SEC(NOW - HOUR) }, seven_day: { used_percentage: 41, resets_at: SEC(NOW + DAY) } },
    });
    const a = await read(service());
    expect(a.plan?.fiveHour).toBeUndefined();
    expect(a.plan?.sevenDay?.usedPercent).toBe(41);
  });

  it("ignores a snapshot that is garbage, too large, from the future or a symlink", async () => {
    for (const body of ["{bozuk", JSON.stringify({ capturedAt: "dün", rate_limits: {} }), JSON.stringify({ capturedAt: NOW + DAY, rate_limits: { five_hour: { used_percentage: 5, resets_at: SEC(NOW + 2 * DAY) } } }), "x".repeat(200_000)]) {
      snapshot(benim, body);
      expect((await read(service())).plan).toBeUndefined();
    }
    rmSync(join(benim, "kokpit-kullanim.json"));
    const elsewhere = join(root, "elsewhere.json");
    writeFileSync(elsewhere, JSON.stringify({ capturedAt: NOW, rate_limits: { five_hour: { used_percentage: 5, resets_at: SEC(NOW + HOUR) } } }));
    symlinkSync(elsewhere, join(benim, "kokpit-kullanim.json"));
    expect((await read(service())).plan).toBeUndefined();
  });

  describe("the status line helper", () => {
    const input = (extra: object = {}) =>
      JSON.stringify({
        session_id: "s",
        transcript_path: `/x/${SECRET_SUBDIR}/t.jsonl`,
        cwd: `/x/${SECRET_SUBDIR}`,
        model: { display_name: "Opus" },
        rate_limits: { five_hour: { used_percentage: 12, resets_at: SEC(NOW + HOUR) }, seven_day: { used_percentage: 34.5, resets_at: SEC(NOW + DAY), extra: SECRET_TEXT } },
        ...extra,
      });
    const run = (args: string[], stdin: string, dir = benim) =>
      execFileSync(process.execPath, [STATUSLINE, ...args], { input: stdin, encoding: "utf8", env: { ...process.env, CLAUDE_CONFIG_DIR: dir } });

    it("stores only the rate-limit numbers in the account's folder and the engine reads them", async () => {
      expect(run(["--out", "kokpit-kullanim.json"], input())).toBe("");
      const file = join(benim, "kokpit-kullanim.json");
      const stored = JSON.parse(readFileSync(file, "utf8")) as { capturedAt: number; rate_limits: unknown };
      expect(stored.rate_limits).toEqual({ five_hour: { used_percentage: 12, resets_at: SEC(NOW + HOUR) }, seven_day: { used_percentage: 34.5, resets_at: SEC(NOW + DAY) } });
      expect(Object.keys(stored).sort()).toEqual(["capturedAt", "rate_limits"]);
      expect(readFileSync(file, "utf8")).not.toContain(SECRET_SUBDIR);
      expect(execFileSync("/usr/bin/stat", ["-f", "%Lp", file], { encoding: "utf8" }).trim()).toBe("600");
      touch(file, NOW);
      writeFileSync(file, JSON.stringify({ ...stored, capturedAt: NOW - 1000 }));
      expect((await read(service())).plan?.sevenDay).toMatchObject({ usedPercent: 34.5, source: "statusline" });
    });

    it("passes the same input on to the user's own status line command and prints its output", () => {
      const inner = join(root, "inner.sh");
      writeFileSync(inner, '#!/bin/sh\nprintf "kendi satırım: %s" "$(cat | wc -c | tr -d " ")"\n', { mode: 0o755 });
      const stdin = input();
      expect(run(["--out", "kokpit-kullanim.json", "--", "/bin/sh", inner], stdin)).toBe(`kendi satırım: ${Buffer.byteLength(stdin)}`);
      expect(existsSync(join(benim, "kokpit-kullanim.json"))).toBe(true);
    });

    it("keeps the previous snapshot when the input has no rate limits, and never fails on bad input", () => {
      run(["--out", "kokpit-kullanim.json"], input());
      const before = readFileSync(join(benim, "kokpit-kullanim.json"), "utf8");
      expect(run(["--out", "kokpit-kullanim.json"], JSON.stringify({ model: {} }))).toBe("");
      expect(run(["--out", "kokpit-kullanim.json"], "{bozuk")).toBe("");
      expect(readFileSync(join(benim, "kokpit-kullanim.json"), "utf8")).toBe(before);
      // A file name that tries to leave the folder is refused; nothing is written anywhere.
      expect(run(["--out", "../kacak.json"], input(), work)).toBe("");
      expect(existsSync(join(root, "home", "kacak.json"))).toBe(false);
      expect(run([], input(), work)).toBe("");
      expect(readdirSync(work)).toEqual([]);
    });
  });

  describe("asking Claude Code (probe)", () => {
    const event = (windows: object) => `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: SECRET_TEXT }] } })}\n${JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: windows } })}\n`;
    const calls: { file: string; args: string[]; env: NodeJS.ProcessEnv | undefined; cwd: string | undefined }[] = [];
    const runner =
      (stdout: string, error?: "ENOENT" | "TIMEOUT"): UsageRunner =>
      async (file, args, opts) => {
        calls.push({ file, args, env: opts.env, cwd: opts.cwd });
        return { stdout, stderr: SECRET_TEXT, code: error ? null : 0, ...(error ? { error } : {}) };
      };
    beforeEach(() => {
      calls.length = 0;
    });

    it("runs one non-interactive claude request with the account's config dir and stores what it reports", async () => {
      const svc = service({ run: runner(event({ seven_day: { utilization: 0.59, resetsAt: SEC(NOW + DAY) } })) });
      const r = await svc.probe("work");
      expect(r.accounts).toHaveLength(1);
      expect(r.accounts[0]!.plan).toEqual({
        sevenDay: { usedPercent: 59, resetsAt: new Date(NOW + DAY).toISOString(), capturedAt: new Date(NOW).toISOString(), source: "probe" },
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.file).toBe("claude");
      expect(calls[0]!.args).toEqual(loadClaudeUsageConfig({}).probe.args);
      expect(calls[0]!.args).toContain("-p");
      expect(calls[0]!.args).toContain("--no-session-persistence");
      expect(calls[0]!.env?.CLAUDE_CONFIG_DIR).toBe(work);
      expect(calls[0]!.cwd?.startsWith(dataDir)).toBe(true);
      expect(JSON.stringify(r) + logs.join("")).not.toContain(SECRET_TEXT);
    });

    it("gives the default account no CLAUDE_CONFIG_DIR, even when the engine inherited one", async () => {
      process.env.CLAUDE_CONFIG_DIR = "/inherited";
      try {
        const svc = service({ run: runner(event({ five_hour: { utilization: 0.1, resetsAt: SEC(NOW + HOUR) } })) });
        await svc.probe("benim");
        expect(calls[0]!.env && "CLAUDE_CONFIG_DIR" in calls[0]!.env).toBe(false);
      } finally {
        delete process.env.CLAUDE_CONFIG_DIR;
      }
    });

    it("survives a restart and yields to a newer status line snapshot per window", async () => {
      const one = service({ run: runner(event({ five_hour: { utilization: 0.5, resetsAt: SEC(NOW + HOUR) }, seven_day: { utilization: 0.2, resetsAt: SEC(NOW + DAY) } })) });
      await one.probe("benim");
      await one.dispose();
      snapshot(benim, { capturedAt: NOW + 60_000, rate_limits: { five_hour: { used_percentage: 77, resets_at: SEC(NOW + HOUR) } } });
      const two = service({ now: () => NOW + 120_000 });
      await two.refresh();
      const plan = two.get({ accountId: "benim" }).accounts[0]!.plan;
      expect(plan?.fiveHour).toMatchObject({ usedPercent: 77, source: "statusline" });
      expect(plan?.sevenDay).toMatchObject({ usedPercent: 20, source: "probe" });
    });

    it("refuses to ask again inside the minimum interval, when disabled, and for an unknown account", async () => {
      let now = NOW;
      const svc = service({ now: () => now, run: runner(event({ seven_day: { utilization: 0.1, resetsAt: SEC(NOW + DAY) } })) });
      await svc.probe("benim");
      await expect(svc.probe("benim")).rejects.toMatchObject({ code: "INVALID" });
      await svc.probe("work"); // per account
      now += loadClaudeUsageConfig({}).probe.minIntervalMs;
      await svc.probe("benim");
      expect(calls).toHaveLength(3);
      await expect(svc.probe("yok")).rejects.toMatchObject({ code: "NOT_FOUND" });
      const off = service({ config: { probe: { ...loadClaudeUsageConfig({}).probe, enabled: false } }, run: runner("") });
      await expect(off.probe("benim")).rejects.toMatchObject({ code: "INVALID" });
      expect(off.get({}).probeAvailable).toBe(false);
      expect(calls).toHaveLength(3);
    });

    it("explains failures in Turkish without echoing claude's output", async () => {
      await expect(service({ run: runner("", "ENOENT") }).probe("benim")).rejects.toMatchObject({ code: "CLAUDE_FAILED", message: expect.stringMatching(/bulunamadı/) });
      await expect(service({ run: runner("", "TIMEOUT") }).probe("benim")).rejects.toMatchObject({ code: "CLAUDE_FAILED", message: expect.stringMatching(/yanıt vermedi/) });
      const none = service({ run: runner(`${JSON.stringify({ type: "result", result: SECRET_TEXT })}\n`) });
      const err = await none.probe("benim").catch((e: unknown) => e as EngineError);
      expect(err).toMatchObject({ code: "CLAUDE_FAILED" });
      expect((err as EngineError).message).not.toContain(SECRET_TEXT);
    });
  });
});

describe("config", () => {
  it("defaults load; overrides are validated", () => {
    const c = loadClaudeUsageConfig({});
    expect(c.sessionWindowHours).toBe(5);
    expect(c.longWindowDays).toBe(7);
    expect(c.prices).toEqual({ asOf: null, perMillionUsd: {} });
    expect(() => loadClaudeUsageConfig({ tickBudgetMs: 0 })).toThrow(/claudeUsage/);
    expect(() => loadClaudeUsageConfig({ projectsDirName: "../x" })).toThrow(/claudeUsage/);
    expect(() => loadClaudeUsageConfig({ prices: { asOf: null, perMillionUsd: { opus: { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 } } } })).toThrow(/asOf/);
  });
});
