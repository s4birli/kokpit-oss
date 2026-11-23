// Kendini güncelleme: computes the identity of a build (Node only — not part of the package's main entry, which the
// renderer imports). Used by the app's build config, the app's dist script and the engine.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { BuildInfoSchema, makeBuildId, type BuildInfo } from "./app-update.ts";

const GIT_TIMEOUT_MS = 10_000;
const COMMIT_CHARS = 10;
const UNKNOWN_COMMIT = "unknown";
const DIRTY_SUFFIX = ".dirty";

export interface ComputeBuildInfoOptions {
  /** The package.json whose `version` the build carries; git is asked in its folder. */
  packageJsonPath: string;
  now?: Date;
  /** Runs git; injectable for tests. Throws when git fails. */
  git?: (args: string[], cwd: string) => string;
}

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });
}

/** Version from package.json, commit from git (with `.dirty` for uncommitted changes to tracked files), time = now. */
export function computeBuildInfo(o: ComputeBuildInfoOptions): BuildInfo {
  const git = o.git ?? runGit;
  const cwd = dirname(o.packageJsonPath);
  const { version } = JSON.parse(readFileSync(o.packageJsonPath, "utf8")) as { version?: unknown };
  if (typeof version !== "string" || version === "") throw new Error(`${o.packageJsonPath} has no version`);
  let commit = UNKNOWN_COMMIT;
  try {
    commit = git(["rev-parse", `--short=${COMMIT_CHARS}`, "HEAD"], cwd).trim() || UNKNOWN_COMMIT;
    if (commit !== UNKNOWN_COMMIT && git(["status", "--porcelain", "--untracked-files=no"], cwd).trim() !== "") commit += DIRTY_SUFFIX;
  } catch {
    // Not a git checkout (or no git): the build is still identified by version and time.
  }
  const builtAt = o.now ?? new Date();
  return BuildInfoSchema.parse({ buildId: makeBuildId(version, commit, builtAt), version, commit, builtAt: builtAt.toISOString() });
}

/** A build info file written at build/deploy time; undefined when missing or not valid. */
export function readBuildInfoFile(path: string): BuildInfo | undefined {
  try {
    const r = BuildInfoSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}
