import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  GitError,
  branchExists,
  clone,
  defaultBranch,
  isInsideWorkTree,
  statusPorcelain,
  worktreeAdd,
  worktreePrune,
  worktreeRemove,
} from "./git.ts";

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
  const d = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-git-")));
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

describe("defaultBranch", () => {
  it("falls back to the current branch without origin", async () => {
    expect(await defaultBranch(initRepo("trunk"))).toBe("trunk");
  });

  it("uses origin/HEAD when present", async () => {
    const upstream = initRepo("develop");
    const clone = tmp();
    execFileSync("git", ["clone", "-q", "--", upstream, clone]);
    git(clone, "checkout", "-q", "-b", "other");
    expect(await defaultBranch(clone)).toBe("develop");
  });

  it("errors outside a repo", async () => {
    await expect(defaultBranch(tmp())).rejects.toBeInstanceOf(GitError);
  });

  it("errors on detached HEAD without origin", async () => {
    const repo = initRepo();
    git(repo, "checkout", "-q", "--detach");
    await expect(defaultBranch(repo)).rejects.toBeInstanceOf(GitError);
  });
});

describe("isInsideWorkTree", () => {
  it("is true in a repo, false in a plain or missing folder, never throws", async () => {
    const repo = initRepo();
    expect(await isInsideWorkTree(repo)).toBe(true);
    expect(await isInsideWorkTree(tmp())).toBe(false);
    expect(await isInsideWorkTree(join(tmp(), "yok"))).toBe(false);
  });

  it("is false inside the .git directory itself", async () => {
    const repo = initRepo();
    expect(await isInsideWorkTree(join(repo, ".git"))).toBe(false);
  });
});

describe("branchExists", () => {
  it("reports existing and missing branches", async () => {
    const repo = initRepo();
    expect(await branchExists(repo, "main")).toBe(true);
    expect(await branchExists(repo, "nope")).toBe(false);
    expect(await branchExists(repo, "-rf")).toBe(false);
  });
});

describe("worktrees", () => {
  it("adds, lists clean status, removes and prunes", async () => {
    const repo = initRepo();
    const wt = join(tmp(), "wt");
    await worktreeAdd(repo, wt, "kokpit/x", "main");
    expect(existsSync(join(wt, "README.md"))).toBe(true);
    expect(await branchExists(repo, "kokpit/x")).toBe(true);
    expect(await statusPorcelain(wt)).toEqual([]);

    await worktreeRemove(repo, wt);
    await worktreePrune(repo);
    expect(existsSync(wt)).toBe(false);
    expect(await branchExists(repo, "kokpit/x")).toBe(true);
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(wt);
  });

  it("carries git's stderr on failure", async () => {
    const repo = initRepo();
    const wt = join(tmp(), "wt");
    const err = await worktreeAdd(repo, wt, "x", "no-such-base").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).stderr).toMatch(/no-such-base/);
    expect((err as GitError).message).toMatch(/no-such-base/);
    expect(existsSync(wt)).toBe(false);
  });

  it("refuses to remove a dirty worktree (no --force)", async () => {
    const repo = initRepo();
    const wt = join(tmp(), "wt");
    await worktreeAdd(repo, wt, "y", "main");
    writeFileSync(join(wt, "README.md"), "changed\n");
    await expect(worktreeRemove(repo, wt)).rejects.toBeInstanceOf(GitError);
    expect(existsSync(wt)).toBe(true);
  });
});

describe("statusPorcelain", () => {
  it("reports modified, staged, untracked (nested), deleted and renamed files", async () => {
    const repo = initRepo();
    writeFileSync(join(repo, "a.txt"), "a\n");
    writeFileSync(join(repo, "b.txt"), "b\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "more");

    writeFileSync(join(repo, "README.md"), "modified\n");
    writeFileSync(join(repo, "staged.txt"), "s\n");
    git(repo, "add", "staged.txt");
    execFileSync("mkdir", ["-p", join(repo, "dir", "sub")]);
    writeFileSync(join(repo, "dir", "sub", "new file.txt"), "u\n");
    unlinkSync(join(repo, "a.txt"));
    git(repo, "mv", "b.txt", "renamed.txt");

    const entries = await statusPorcelain(repo);
    const byPath = Object.fromEntries(entries.map((e) => [e.path, e]));
    expect(byPath["README.md"]?.status).toBe(" M");
    expect(byPath["staged.txt"]?.status).toBe("A ");
    expect(byPath["dir/sub/new file.txt"]?.status).toBe("??");
    expect(byPath["a.txt"]?.status).toBe(" D");
    expect(byPath["renamed.txt"]?.status).toBe("R ");
    expect(byPath["renamed.txt"]?.origPath).toBe("b.txt");
    expect(entries).toHaveLength(5);
  });
});

describe("clone", () => {
  const CLONE_TIMEOUT_MS = 60_000;

  it("clones a repository into dest", async () => {
    const src = initRepo();
    const dest = join(tmp(), "copy");
    await clone(src, dest, CLONE_TIMEOUT_MS);
    expect(existsSync(join(dest, "README.md"))).toBe(true);
    expect(git(dest, "rev-parse", "HEAD").trim()).toBe(git(src, "rev-parse", "HEAD").trim());
  });

  it("treats an option-looking url as a repository, never as a git option", async () => {
    const parent = tmp();
    const dest = join(parent, "copy");
    const err = await clone("--upload-pack=touch pwned", dest, CLONE_TIMEOUT_MS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect(existsSync(join(parent, "pwned"))).toBe(false);
    expect(existsSync(join(process.cwd(), "pwned"))).toBe(false);
  });

  it("throws GitError with git's stderr when the source does not exist", async () => {
    const dest = join(tmp(), "copy");
    const err = (await clone(join(tmp(), "nope"), dest, CLONE_TIMEOUT_MS).catch((e: unknown) => e)) as GitError;
    expect(err).toBeInstanceOf(GitError);
    expect(err.stderr).toMatch(/nope/);
  });

  it("fails into an existing non-empty dest", async () => {
    const src = initRepo();
    const dest = tmp();
    writeFileSync(join(dest, "x"), "x");
    await expect(clone(src, dest, CLONE_TIMEOUT_MS)).rejects.toBeInstanceOf(GitError);
  });

  it("gives up after the timeout", async () => {
    const src = initRepo();
    const dest = join(tmp(), "copy");
    const err = (await clone(src, dest, 1).catch((e: unknown) => e)) as GitError;
    expect(err).toBeInstanceOf(GitError);
    expect(err.message).toMatch(/zaman aşımı/);
  });
});
