// Adım 9 İş A: background Claude sessions (`claude agents`, `claude --bg`) run under the shared, long-lived
// `claude daemon`, which does not carry a Kokpit terminal's environment — so their Playwright MCP never saw
// PLAYWRIGHT_MCP_CDP_ENDPOINT and launched its own Chrome. Claude Code does apply the `env` block of the project's
// settings file (`<project>/.claude/settings.local.json`, also found from subfolders and git worktrees of the
// project) to every session started there, daemon-spawned ones included, and to the MCP servers they start.
// The engine therefore writes the same variables a project terminal gets into that file.
//
// It manages ONLY the keys it wrote (remembered in the state file with their values): everything else in the file
// is preserved, a key the user changed afterwards is no longer touched on removal, and nothing is written through
// a symlink that leaves the project folder.
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { projectGitPath, type Project } from "@kokpit/shared";
import type { ClaudeSettingsStore, Logger, ManagedClaudeSettings } from "./contracts.ts";
import { isStrictlyInside, PRIVATE_FILE_MODE } from "./fs-safety.ts";
import { writeAtomic } from "./store.ts";

const ENV_KEY = "env";
const DEFAULT_INDENT = "  ";

type Json = Record<string, unknown>;
type Skipped = { status: "skipped"; reason: string };

export type ApplyResult =
  | { status: "written" | "unchanged"; file: string; createdFile: boolean; createdDir: boolean }
  | Skipped;
export type RemoveResult = { status: "removed" | "unchanged" } | Skipped;

export interface ApplyInput {
  /** The project folder on this machine. */
  projectDir: string;
  /** Settings file inside it, as path segments (`browser.claudeSettingsPath`). */
  path: readonly string[];
  /** `env` entries to set. */
  env: Readonly<Record<string, string>>;
  /** Entries written earlier: those not in `env` any more are removed while they still hold that value. */
  previous?: Readonly<Record<string, string>>;
}

const skipped = (reason: string): Skipped => ({ status: "skipped", reason });
const isPlainObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

interface Target {
  /** Real path of the file to write (it may not exist yet). */
  file: string;
  exists: boolean;
  /** Folders to create first, outermost first. */
  missingDirs: string[];
}

/**
 * Where `path` inside `projectDir` really is. Existing parts are resolved through symlinks and must stay inside
 * the project's real folder; missing parts are plain names below the last real folder.
 */
export function resolveSettingsTarget(projectDir: string, path: readonly string[]): Target | Skipped {
  let realProject: string;
  try {
    realProject = realpathSync(projectDir);
    if (!statSync(realProject).isDirectory()) return skipped("project folder is not a directory");
  } catch {
    return skipped("project folder does not exist");
  }
  const dirs = path.slice(0, -1);
  const name = path[path.length - 1];
  if (name === undefined) return skipped("no settings file name");

  let cur = realProject;
  const missingDirs: string[] = [];
  for (const seg of dirs) {
    const next = join(cur, seg);
    if (missingDirs.length > 0 || lstatOrNull(next) === null) {
      missingDirs.push(next);
      cur = next;
      continue;
    }
    let real: string;
    try {
      real = realpathSync(next);
    } catch {
      return skipped(`${next} is a broken link`);
    }
    if (!isStrictlyInside(realProject, real)) return skipped(`${next} leads outside the project folder`);
    if (!statSync(real).isDirectory()) return skipped(`${next} is not a folder`);
    cur = real;
  }

  const file = join(cur, name);
  if (missingDirs.length > 0 || lstatOrNull(file) === null) return { file, exists: false, missingDirs };
  let real: string;
  try {
    real = realpathSync(file);
  } catch {
    return skipped(`${file} is a broken link`);
  }
  if (!isStrictlyInside(realProject, real)) return skipped(`${file} leads outside the project folder`);
  if (!statSync(real).isFile()) return skipped(`${file} is not a file`);
  return { file: real, exists: true, missingDirs };
}

interface Loaded {
  json: Json;
  env: Record<string, unknown>;
  text: string;
  mode: number;
}

function load(file: string): Loaded | Skipped {
  let text: string;
  let mode: number;
  try {
    text = readFileSync(file, "utf8");
    mode = statSync(file).mode & 0o777;
  } catch (err) {
    return skipped(`cannot read ${file}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return skipped(`${file} is not valid JSON`);
  }
  if (!isPlainObject(json)) return skipped(`${file} does not hold a JSON object`);
  const env = json[ENV_KEY];
  if (env !== undefined && !isPlainObject(env)) return skipped(`"${ENV_KEY}" in ${file} is not an object`);
  return { json, env: env ?? {}, text, mode };
}

/** The file's own formatting: indentation of its first indented line, and its line ending. */
function serialize(json: Json, like: string | null): string {
  const indent = (like !== null ? /\n([ \t]+)\S/.exec(like)?.[1] : undefined) ?? DEFAULT_INDENT;
  const out = JSON.stringify(json, null, indent) + "\n";
  return like?.includes("\r\n") ? out.replace(/\n/g, "\r\n") : out;
}

/** `json` with its env block replaced (same position; appended when new; dropped when empty). */
function withEnv(json: Json, env: Record<string, unknown>): Json {
  const { [ENV_KEY]: _old, ...rest } = json;
  if (Object.keys(env).length === 0) return rest;
  return ENV_KEY in json ? Object.fromEntries(Object.entries(json).map(([k, v]) => [k, k === ENV_KEY ? env : v])) : { ...rest, [ENV_KEY]: env };
}

/** Sets `env` entries in the project's settings file, preserving everything else. Never throws. */
export function applyManagedEnv(input: ApplyInput): ApplyResult {
  const target = resolveSettingsTarget(input.projectDir, input.path);
  if ("status" in target) return target;
  try {
    let loaded: Loaded | null = null;
    if (target.exists) {
      const l = load(target.file);
      if ("status" in l) return l;
      loaded = l;
    }
    const env: Record<string, unknown> = { ...(loaded?.env ?? {}) };
    let changed = false;
    for (const [k, v] of Object.entries(input.previous ?? {})) {
      if (!(k in input.env) && env[k] === v) {
        delete env[k];
        changed = true;
      }
    }
    for (const [k, v] of Object.entries(input.env)) {
      if (env[k] === v) continue;
      env[k] = v;
      changed = true;
    }
    const base = { file: target.file, createdFile: !target.exists, createdDir: target.missingDirs.length > 0 };
    if (!changed && target.exists) return { status: "unchanged", ...base };
    for (const dir of target.missingDirs) mkdirSync(dir);
    writeAtomic(target.file, serialize(withEnv(loaded?.json ?? {}, env), loaded?.text ?? null), loaded?.mode ?? PRIVATE_FILE_MODE);
    return { status: "written", ...base };
  } catch (err) {
    return skipped(`cannot write ${target.file}: ${(err as Error).message}`);
  }
}

/**
 * Takes the entries the engine wrote out of the file again — only those that still hold the written value. A file
 * (and folder) the engine created is deleted once nothing else is in it. Never throws.
 */
export function removeManagedEnv(record: ManagedClaudeSettings): RemoveResult {
  const { file } = record;
  const st = lstatOrNull(file);
  if (st === null) return { status: "unchanged" };
  try {
    // The recorded path was real when written; anything that is a link now is not ours to follow.
    if (!st.isFile() || realpathSync(file) !== file) return skipped(`${file} is no longer a plain file at its recorded place`);
    const loaded = load(file);
    if ("status" in loaded) return loaded;
    const env = { ...loaded.env };
    let changed = false;
    for (const [k, v] of Object.entries(record.env)) {
      if (env[k] !== v) continue;
      delete env[k];
      changed = true;
    }
    if (!changed) return { status: "unchanged" };
    const next = withEnv(loaded.json, env);
    if (Object.keys(next).length === 0 && record.createdFile) {
      unlinkSync(file);
      if (record.createdDir) {
        try {
          rmdirSync(dirname(file));
        } catch {
          /* something else lives there now */
        }
      }
    } else {
      writeAtomic(file, serialize(next, loaded.text), loaded.mode);
    }
    return { status: "removed" };
  } catch (err) {
    return skipped(`cannot update ${file}: ${(err as Error).message}`);
  }
}

// ---------- service ----------

export interface ClaudeBrowserSettingsDeps {
  /** `browser.claudeSettingsPath`. */
  path: readonly string[];
  store: ClaudeSettingsStore;
  logger: Logger;
  getProject(projectId: string): Project | undefined;
  /** What a terminal of the project gets for its browser (`browserTerminalEnv`); {} = this project gets none. */
  envFor(project: Project): Record<string, string>;
  /** Whether the project's Chrome is up. */
  isRunning(projectId: string): boolean;
  /** Folders that are Claude's own (account config dirs): a settings file landing there is not a project's. */
  protectedDirs(): string[];
}

export interface ClaudeBrowserSettings {
  /**
   * Brings the project's settings file in line with the project: written when its browser has started (now or
   * earlier), cleaned when the project is gone, moved, not local, or has `claudeBrowserEnv: false`. Never throws.
   */
  sync(projectId: string, opts?: { started?: boolean }): void;
  /** The project is being deleted: its keys are taken out of the file. Never throws. */
  forget(projectId: string): void;
  /** Engine start: every project the engine wrote for earlier (stale port or folder, option changed meanwhile). */
  syncAll(): void;
}

const sameEnv = (a: Record<string, string>, b: Record<string, string>) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);

/** Real path of `path`; for a path that does not exist (yet), its name below the real path of its parent. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(canonical(parent), basename(path));
  }
}

export function createClaudeBrowserSettings(deps: ClaudeBrowserSettingsDeps): ClaudeBrowserSettings {
  const { store, logger } = deps;

  function clean(projectId: string, record: ManagedClaudeSettings): void {
    const r = removeManagedEnv(record);
    if (r.status === "skipped") logger.warn("Claude ayar dosyasındaki tarayıcı anahtarları silinemedi", { projectId, reason: r.reason });
    else if (r.status === "removed") logger.info("Claude ayar dosyasından tarayıcı anahtarları silindi", { projectId, file: record.file });
    store.setManagedClaudeSettings(projectId, undefined);
  }

  function isProtected(file: string): boolean {
    const dir = canonical(dirname(file));
    return deps.protectedDirs().some((p) => canonical(p) === dir);
  }

  function run(projectId: string, started: boolean): void {
    const project = deps.getProject(projectId);
    const record = store.getManagedClaudeSettings(projectId);
    const dir = project ? projectGitPath(project) : null;
    const env = project && dir !== null && project.claudeBrowserEnv !== false ? deps.envFor(project) : {};
    const wanted = Object.keys(env).length > 0 && (started || record !== undefined || deps.isRunning(projectId));
    if (!project || dir === null || !wanted) {
      if (record) clean(projectId, record);
      return;
    }

    const target = resolveSettingsTarget(dir, deps.path);
    const refusal = "status" in target ? target.reason : isProtected(target.file) ? "the folder is Claude's own config dir" : null;
    if (refusal !== null) {
      logger.warn("Claude ayar dosyasına tarayıcı adresi yazılmadı", { projectId, reason: refusal });
      if (record) clean(projectId, record);
      return;
    }
    const file = (target as { file: string }).file;
    // The project moved: the old folder gets its keys taken out, the new one starts fresh.
    const same = record !== undefined && record.file === file ? record : undefined;
    if (record && !same) clean(projectId, record);

    const r = applyManagedEnv({ projectDir: dir, path: deps.path, env, ...(same ? { previous: same.env } : {}) });
    if (r.status === "skipped") {
      logger.warn("Claude ayar dosyasına tarayıcı adresi yazılmadı", { projectId, reason: r.reason });
      if (same) store.setManagedClaudeSettings(projectId, undefined);
      return;
    }
    const createdFile = r.createdFile || same?.createdFile === true;
    const createdDir = r.createdDir || same?.createdDir === true;
    const next: ManagedClaudeSettings = { file: r.file, env: { ...env }, ...(createdFile ? { createdFile } : {}), ...(createdDir ? { createdDir } : {}) };
    const recordChanged = !same || !sameEnv(same.env, next.env) || same.createdFile !== next.createdFile || same.createdDir !== next.createdDir;
    if (recordChanged) store.setManagedClaudeSettings(projectId, next);
    if (r.status === "written") logger.info("Claude ayar dosyasına tarayıcı adresi yazıldı", { projectId, file: r.file });
  }

  function sync(projectId: string, opts: { started?: boolean } = {}): void {
    try {
      run(projectId, opts.started === true);
    } catch (err) {
      logger.warn("Claude ayar dosyası eşitlenemedi", { projectId, err: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    sync,
    forget: (projectId) => {
      try {
        const record = store.getManagedClaudeSettings(projectId);
        if (record) clean(projectId, record);
      } catch (err) {
        logger.warn("Claude ayar dosyası temizlenemedi", { projectId, err: err instanceof Error ? err.message : String(err) });
      }
    },
    syncAll: () => {
      for (const projectId of Object.keys(store.listManagedClaudeSettings())) sync(projectId);
    },
  };
}
