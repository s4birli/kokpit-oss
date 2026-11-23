import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import type { Project } from "@kokpit/shared";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { MemoryStore } from "../test/fakes/memory-store.ts";
import { createCardService } from "./cards.ts";
import { EngineError, type DataPaths, type EngineConfig, type Logger } from "./contracts.ts";

const SLUG_MAX = 40;
const SLUG_FALLBACK = "kart";
const PREFIX = "kokpit/";

beforeAll(() => {
  process.env.GIT_AUTHOR_NAME = "Test";
  process.env.GIT_AUTHOR_EMAIL = "test@example.invalid";
  process.env.GIT_COMMITTER_NAME = "Test";
  process.env.GIT_COMMITTER_EMAIL = "test@example.invalid";
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-cards-")));
  tmpDirs.push(d);
  return d;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function initRepo(branch = "main"): string {
  const repo = tmp();
  git(repo, "init", "-q", "-b", branch);
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

function head(cwd: string, rev = "HEAD"): string {
  return git(cwd, "rev-parse", rev).trim();
}

function branchExists(repo: string, branch: string): boolean {
  try {
    git(repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

function gitWorktrees(repo: string): string[] {
  return git(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length))
    .filter((p) => p !== repo)
    .sort();
}

interface Setup {
  repo: string;
  project: Project;
  paths: DataPaths;
  store: MemoryStore;
  warnings: string[];
  events: string[];
  svc: ReturnType<typeof createCardService>;
}

function setup(opts: { baseBranch?: string | null; repo?: string; repoBranch?: string } = {}): Setup {
  const repo = opts.repo ?? initRepo(opts.repoBranch);
  const dataDir = tmp();
  const project: Project = { id: "proj", name: "Proje", location: { kind: "local", path: repo } };
  const config: EngineConfig = {
    configPath: join(dataDir, "config.json"),
    port: 0,
    dataDir,
    bufferBytes: 1024,
    shell: "/bin/sh",
    shellArgs: [],
    branchPrefix: PREFIX,
    baseBranch: opts.baseBranch ?? null,
    authTimeoutMs: 1000,
    tailscaleRescanMs: 1000,
    listenLocalhost: true,
    listenTailscale: false,
    tailscaleCidrs: [],
    key: "k",
    projects: [],
  };
  const paths: DataPaths = {
    stateFile: join(dataDir, "state.json"),
    buffersDir: join(dataDir, "buffers"),
    worktreesDir: join(dataDir, "worktrees"),
    reposDir: join(dataDir, "repos"),
  };
  const store = new MemoryStore();
  store.upsertProject(project);
  const warnings: string[] = [];
  const events: string[] = [];
  const logger: Logger = { info() {}, warn: (m) => warnings.push(m), error() {} };
  const svc = createCardService({
    config,
    paths,
    store,
    logger,
    slugMaxLen: SLUG_MAX,
    slugFallback: SLUG_FALLBACK,
    onBeforeRemove: (cardId) => {
      const card = store.getCard(cardId);
      events.push(`before:${cardId}:${card && existsSync(card.worktreePath) ? "present" : "gone"}`);
    },
  });
  return { repo, project, paths, store, warnings, events, svc };
}

function assertInside(dir: string, p: string) {
  const rel = relative(dir, p);
  expect(rel).not.toBe("");
  expect(rel.startsWith("..")).toBe(false);
  expect(rel.split(sep)).toHaveLength(2);
}

async function engineError(p: Promise<unknown>): Promise<EngineError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(EngineError);
  return err as EngineError;
}

describe("cards.create", () => {
  it("creates worktree + branch from the default branch at the expected path", async () => {
    const s = setup();
    const card = await s.svc.create("proj", "Yeni Özellik");
    const expected = join(s.paths.worktreesDir, "proj", "yeni-ozellik");
    expect(card).toMatchObject({ projectId: "proj", name: "Yeni Özellik", branch: `${PREFIX}yeni-ozellik`, worktreePath: expected });
    expect(Number.isNaN(Date.parse(card.createdAt))).toBe(false);
    expect(existsSync(join(expected, "README.md"))).toBe(true);
    expect(head(s.repo, card.branch)).toBe(head(s.repo, "main"));
    expect(gitWorktrees(s.repo)).toEqual([expected]);
    expect(s.svc.list("proj")).toEqual([card]);
    expect(s.store.getCard(card.id)).toEqual(card);
  });

  it("uses the injected id and clock", async () => {
    const repo = initRepo();
    const base = setup({ repo });
    const fixed = new Date("2026-01-02T03:04:05.000Z");
    const svc = createCardService({
      config: { ...({} as EngineConfig), branchPrefix: PREFIX, baseBranch: null, projects: [] },
      paths: base.paths,
      store: base.store,
      logger: { info() {}, warn() {}, error() {} },
      slugMaxLen: SLUG_MAX,
      slugFallback: SLUG_FALLBACK,
      newId: () => "card-1",
      now: () => fixed,
    });
    const card = await svc.create("proj", "x");
    expect(card.id).toBe("card-1");
    expect(card.createdAt).toBe(fixed.toISOString());
  });

  it("starts from the repo's current branch when it is not main", async () => {
    const s = setup({ repoBranch: "trunk" });
    const card = await s.svc.create("proj", "a");
    expect(head(s.repo, card.branch)).toBe(head(s.repo, "trunk"));
  });

  it("honours a configured baseBranch", async () => {
    const repo = initRepo();
    git(repo, "checkout", "-q", "-b", "develop");
    writeFileSync(join(repo, "dev.txt"), "d\n");
    git(repo, "add", "dev.txt");
    git(repo, "commit", "-q", "-m", "dev");
    git(repo, "checkout", "-q", "main");
    const s = setup({ repo, baseBranch: "develop" });
    const card = await s.svc.create("proj", "feature");
    expect(head(s.repo, card.branch)).toBe(head(s.repo, "develop"));
    expect(existsSync(join(card.worktreePath, "dev.txt"))).toBe(true);
  });

  it("suffixes duplicate names", async () => {
    const s = setup();
    const a = await s.svc.create("proj", "Aynı");
    const b = await s.svc.create("proj", "aynı");
    const c = await s.svc.create("proj", "AYNI!");
    expect([a, b, c].map((x) => basename(x.worktreePath))).toEqual(["ayni", "ayni-2", "ayni-3"]);
    expect(c.branch).toBe(`${PREFIX}ayni-3`);
  });

  it("avoids branches that already exist in the repo", async () => {
    const s = setup();
    git(s.repo, "branch", `${PREFIX}taken`);
    const card = await s.svc.create("proj", "taken");
    expect(card.branch).toBe(`${PREFIX}taken-2`);
  });

  it("avoids a leftover directory at the target path", async () => {
    const s = setup();
    mkdirSync(join(s.paths.worktreesDir, "proj", "left"), { recursive: true });
    const card = await s.svc.create("proj", "left");
    expect(basename(card.worktreePath)).toBe("left-2");
  });

  it("gives concurrent creates with the same name distinct worktrees", async () => {
    const s = setup();
    const cards = await Promise.all(Array.from({ length: 5 }, () => s.svc.create("proj", "paralel")));
    const paths = cards.map((c) => c.worktreePath);
    expect(new Set(paths).size).toBe(5);
    expect(new Set(cards.map((c) => c.branch)).size).toBe(5);
    expect(new Set(cards.map((c) => c.id)).size).toBe(5);
    expect(gitWorktrees(s.repo)).toEqual([...paths].sort());
  });

  it.each([
    ["Türkçe ŞĞÜÖÇİı", "turkce-sguocii"],
    ["🚀🔥", SLUG_FALLBACK],
    ["fix 🚀 bug", "fix-bug"],
    ["../../etc/passwd", "etc-passwd"],
    ["-rf", "rf"],
    ["x".repeat(5000), "x".repeat(SLUG_MAX)],
    ["   \t  ", SLUG_FALLBACK],
    ["..", SLUG_FALLBACK],
  ])("makes a safe slug for %j", async (name, slug) => {
    const s = setup();
    const card = await s.svc.create("proj", name);
    expect(basename(card.worktreePath)).toBe(slug);
    expect(card.branch).toBe(`${PREFIX}${slug}`);
    assertInside(s.paths.worktreesDir, card.worktreePath);
    expect(existsSync(card.worktreePath)).toBe(true);
    expect(card.name).toBe(name);
  });

  it("rejects an unknown project", async () => {
    const s = setup();
    const err = await engineError(s.svc.create("nope", "x"));
    expect(err.code).toBe("NOT_FOUND");
    expect(s.store.listCards()).toEqual([]);
  });

  it("rejects a project id that would escape worktreesDir", async () => {
    const s = setup();
    s.store.upsertProject({ ...s.project, id: "../../escape" });
    const err = await engineError(s.svc.create("../../escape", "x"));
    expect(err.code).toBe("INVALID");
    expect(s.store.listCards()).toEqual([]);
    expect(gitWorktrees(s.repo)).toEqual([]);
  });

  it("leaves no record and no directory when git fails (bad base)", async () => {
    const s = setup({ baseBranch: "no-such-branch" });
    const err = await engineError(s.svc.create("proj", "x"));
    expect(err.code).toBe("GIT_FAILED");
    expect(err.message).toMatch(/no-such-branch/);
    expect(s.store.listCards()).toEqual([]);
    expect(existsSync(join(s.paths.worktreesDir, "proj", "x"))).toBe(false);
    expect(branchExists(s.repo, `${PREFIX}x`)).toBe(false);
  });

  it.each([
    ["an existing folder that is not a git repo", () => tmp()],
    ["a folder that no longer exists", () => join(tmp(), "yok")],
  ])("refuses %s with INVALID before touching anything", async (_n, repoPath) => {
    const s = setup({ repo: repoPath() });
    const err = await engineError(s.svc.create("proj", "x"));
    expect(err.code).toBe("INVALID");
    expect(err.message).toBe("Bu klasör bir git reposu değil; kart açılamaz.");
    expect(s.store.listCards()).toEqual([]);
    expect(existsSync(join(s.paths.worktreesDir, "proj", "x"))).toBe(false);
  });

  it("keeps working after a failed create", async () => {
    const s = setup();
    await Promise.allSettled([s.svc.create("nope", "x"), s.svc.create("proj", "ok")]);
    const card = await s.svc.create("proj", "ok");
    expect(basename(card.worktreePath)).toBe("ok-2");
  });
});

describe("project kinds", () => {
  it("creates cards in a github project's clone", async () => {
    const s = setup();
    s.store.upsertProject({ id: "gh", name: "GH", location: { kind: "github", url: "https://x/y", path: s.repo } });
    const card = await s.svc.create("gh", "klon");
    expect(card.projectId).toBe("gh");
    expect(gitWorktrees(s.repo)).toEqual([card.worktreePath]);
    await s.svc.delete(card.id);
    expect(gitWorktrees(s.repo)).toEqual([]);
  });

  it("refuses cards in ssh projects (INVALID)", async () => {
    const s = setup();
    s.store.upsertProject({ id: "uzak", name: "Uzak", location: { kind: "ssh", hostId: "oracle", path: "/srv" } });
    const err = await engineError(s.svc.create("uzak", "x"));
    expect(err.code).toBe("INVALID");
    expect(err.message).toContain("SSH projelerinde kart yok");
    expect(s.store.listCards()).toEqual([]);
  });


  it("delete reports NOT_FOUND when the card's project record is gone", async () => {
    const s = setup();
    const card = await s.svc.create("proj", "yetim");
    s.store.removeProject("proj");
    const err = await engineError(s.svc.delete(card.id));
    expect(err.code).toBe("NOT_FOUND");
  });
});

describe("cards.delete", () => {
  it("removes a clean worktree, keeps the branch, drops the record, hook first", async () => {
    const s = setup();
    const card = await s.svc.create("proj", "temiz");
    await s.svc.delete(card.id);
    expect(s.events).toEqual([`before:${card.id}:present`]);
    expect(existsSync(card.worktreePath)).toBe(false);
    expect(branchExists(s.repo, card.branch)).toBe(true);
    expect(s.store.getCard(card.id)).toBeUndefined();
    expect(gitWorktrees(s.repo)).toEqual([]);
  });

  it("rejects an unknown card", async () => {
    const s = setup();
    const err = await engineError(s.svc.delete("nope"));
    expect(err.code).toBe("NOT_FOUND");
  });

  const dirtyCases: [string, (wt: string) => void, string][] = [
    ["modified tracked file", (wt) => writeFileSync(join(wt, "README.md"), "changed\n"), "README.md"],
    [
      "staged file",
      (wt) => {
        writeFileSync(join(wt, "staged.txt"), "s\n");
        git(wt, "add", "staged.txt");
      },
      "staged.txt",
    ],
    ["untracked file", (wt) => writeFileSync(join(wt, "untracked.txt"), "u\n"), "untracked.txt"],
    [
      "nested untracked file",
      (wt) => {
        mkdirSync(join(wt, "a", "b"), { recursive: true });
        writeFileSync(join(wt, "a", "b", "deep.txt"), "u\n");
      },
      "a/b/deep.txt",
    ],
    ["deleted file", (wt) => unlinkSync(join(wt, "README.md")), "README.md"],
  ];

  it.each(dirtyCases)("refuses with DIRTY_WORKTREE for a %s", async (_label, dirty, file) => {
    const s = setup();
    const card = await s.svc.create("proj", "kirli");
    dirty(card.worktreePath);
    const before = readdirSync(card.worktreePath).sort();
    const err = await engineError(s.svc.delete(card.id));
    expect(err.code).toBe("DIRTY_WORKTREE");
    expect(err.message).toContain("Commit edilmemiş değişiklikler var:");
    expect(err.message).toContain(file);
    expect(s.events).toEqual([]);
    expect(readdirSync(card.worktreePath).sort()).toEqual(before);
    expect(s.store.getCard(card.id)).toEqual(card);
    expect(gitWorktrees(s.repo)).toEqual([card.worktreePath]);
  });

  it("lists at most 10 dirty paths and counts the rest", async () => {
    const s = setup();
    const card = await s.svc.create("proj", "cok");
    for (let i = 0; i < 13; i++) writeFileSync(join(card.worktreePath, `f${String(i).padStart(2, "0")}.txt`), "x");
    const err = await engineError(s.svc.delete(card.id));
    expect(err.message).toBe(
      `Commit edilmemiş değişiklikler var: ${Array.from({ length: 10 }, (_, i) => `f${String(i).padStart(2, "0")}.txt`).join(", ")} (+3 daha)`,
    );
  });

  it("drops the record with a warning when the worktree dir is missing", async () => {
    const s = setup();
    const card = await s.svc.create("proj", "kayip");
    rmSync(card.worktreePath, { recursive: true, force: true });
    await s.svc.delete(card.id);
    expect(s.store.getCard(card.id)).toBeUndefined();
    expect(s.warnings.length).toBe(1);
    expect(gitWorktrees(s.repo)).toEqual([]);
    expect(branchExists(s.repo, card.branch)).toBe(true);
  });

  it("serializes a double delete: second call gets NOT_FOUND", async () => {
    const s = setup();
    const card = await s.svc.create("proj", "iki");
    const [a, b] = await Promise.allSettled([s.svc.delete(card.id), s.svc.delete(card.id)]);
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("rejected");
    expect((b as PromiseRejectedResult).reason).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("monkey", () => {
  it("random create/delete sequences stay consistent with git worktree list", async () => {
    const s = setup();
    const alphabet = ["a", "b", "ş", "İ", " ", "-", ".", "/", "🚀", "ü", "Z", "9", "_"];
    const randName = () => {
      const len = 1 + Math.floor(Math.random() * 6);
      return Array.from({ length: len }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
    };
    for (let step = 0; step < 40; step++) {
      const cards = s.svc.list("proj");
      const r = Math.random();
      if (cards.length > 0 && r < 0.35) {
        const victim = cards[Math.floor(Math.random() * cards.length)]!;
        if (Math.random() < 0.3) writeFileSync(join(victim.worktreePath, "dirt.txt"), "x");
        const dirty = existsSync(join(victim.worktreePath, "dirt.txt"));
        const res = await s.svc.delete(victim.id).then(
          () => "ok",
          (e: EngineError) => e.code,
        );
        expect(res).toBe(dirty ? "DIRTY_WORKTREE" : "ok");
        if (dirty && Math.random() < 0.5) unlinkSync(join(victim.worktreePath, "dirt.txt"));
      } else {
        const batch = Array.from({ length: 1 + Math.floor(Math.random() * 3) }, randName);
        const created = await Promise.all(batch.map((n) => s.svc.create("proj", n)));
        for (const c of created) assertInside(s.paths.worktreesDir, c.worktreePath);
      }
      const now = s.svc.list("proj");
      expect(gitWorktrees(s.repo)).toEqual(now.map((c) => c.worktreePath).sort());
      expect(new Set(now.map((c) => c.branch)).size).toBe(now.length);
    }
  });
});
