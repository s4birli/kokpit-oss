// Thin wrapper over the git CLI. Always execFile (never a shell); paths go after
// `--` wherever git accepts it. Failures throw GitError carrying git's stderr.
import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { st } from "@kokpit/shared/i18n";

export class GitError extends Error {
  readonly args: readonly string[];
  readonly stderr: string;
  readonly exitCode: number | null;
  constructor(args: readonly string[], stderr: string, exitCode: number | null) {
    super(stderr.trim() || `git ${args[0] ?? ""} failed (exit ${exitCode ?? "?"})`);
    this.name = "GitError";
    this.args = args;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

interface RunResult {
  stdout: string;
  stderr: string;
}

interface RunOptions {
  /** Kill git (SIGTERM) after this long; 0/undefined = no limit. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

function run(cwd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8", maxBuffer: Infinity, timeout: opts.timeoutMs ?? 0, env: opts.env ?? process.env },
      (err, stdout, stderr) => {
        if (err) {
          if (err.killed && opts.timeoutMs) {
            reject(new GitError(args, st("engine.git.timeout", { command: args[0] ?? "", ms: opts.timeoutMs }), null));
            return;
          }
          const code = typeof err.code === "number" ? err.code : null;
          reject(new GitError(args, stderr || err.message, code));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

/**
 * `git clone -- <url> <dest>`. Never prompts for credentials (a daemon has no terminal), so a private
 * repo without configured auth fails fast instead of hanging until the timeout. Leaves cleanup of a
 * partial `dest` to the caller.
 */
export async function clone(url: string, dest: string, timeoutMs: number): Promise<void> {
  await run(dirname(dest), ["clone", "--", url, dest], {
    timeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

export async function defaultBranch(repo: string): Promise<string> {
  const remotePrefix = "origin/";
  try {
    const { stdout } = await run(repo, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    const ref = stdout.trim();
    if (ref.startsWith(remotePrefix) && ref.length > remotePrefix.length) return ref.slice(remotePrefix.length);
  } catch {
    // no origin/HEAD: fall through to the current branch
  }
  const args = ["rev-parse", "--abbrev-ref", "HEAD"];
  const { stdout } = await run(repo, args);
  const branch = stdout.trim();
  if (branch === "" || branch === "HEAD") {
    throw new GitError(args, st("engine.git.noDefaultBranch"), null);
  }
  return branch;
}

/** `git rev-parse --is-inside-work-tree` in `path`; false for a non-repo, a missing folder or a .git dir. */
export async function isInsideWorkTree(path: string): Promise<boolean> {
  try {
    const { stdout } = await run(path, ["rev-parse", "--is-inside-work-tree"]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await run(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch (err) {
    if (err instanceof GitError && err.exitCode === 1) return false;
    throw err;
  }
}

export async function worktreeAdd(repo: string, path: string, newBranch: string, base: string): Promise<void> {
  await run(repo, ["worktree", "add", "-b", newBranch, "--", path, base]);
}

/** Refuses (GitError) when the worktree is dirty: never --force. */
export async function worktreeRemove(repo: string, path: string): Promise<void> {
  await run(repo, ["worktree", "remove", "--", path]);
}

export async function worktreePrune(repo: string): Promise<void> {
  await run(repo, ["worktree", "prune"]);
}

export interface StatusEntry {
  /** Two-letter XY code from porcelain v1, e.g. " M", "A ", "??", "R ". */
  status: string;
  path: string;
  /** Source path for renames/copies. */
  origPath?: string;
}

/** Every change in the worktree, untracked files included (individually, -uall). */
export async function statusPorcelain(path: string): Promise<StatusEntry[]> {
  const { stdout } = await run(path, ["status", "--porcelain=v1", "-uall", "-z"]);
  const tokens = stdout.split("\0");
  const entries: StatusEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    if (token === "") continue;
    const status = token.slice(0, 2);
    const entry: StatusEntry = { status, path: token.slice(3) };
    if (status.includes("R") || status.includes("C")) {
      i++;
      entry.origPath = tokens[i] ?? "";
    }
    entries.push(entry);
  }
  return entries;
}
