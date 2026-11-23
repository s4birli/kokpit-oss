// ToolService: the CLI tools a terminal can start with (Claude, Codex, …).
// Defaults come from tools.defaults.json and are seeded into the store once per
// seed step; afterwards the store is the only source, so user edits and deletions stick.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ToolSchema, type ParamsOf, type Tool, type ToolStatus } from "@kokpit/shared";
import { engineError, type EngineConfig, type Logger, type StateStore, type ToolService } from "./contracts.ts";
import { expandPlaceholders, PLACEHOLDER, quoteShellArg } from "./launch.ts";
import { slugify } from "./slug.ts";

/**
 * Adım 9 İş K: `{{name}}`s in a tool `command` that are not shipped files but values the engine makes for one
 * launch. Allowed only in tools marked `needsScreenControl` (the engine fills them for no other tool).
 */
export const LAUNCH_PLACEHOLDERS: readonly string[] = [];

export const TOOL_DEFAULTS_PATH = fileURLToPath(new URL("../tools.defaults.json", import.meta.url));

/** Seed key in StateStore: default tools were copied into the store. */
const SEED_KEY = "default-tools";
/** Seed key: defaults added after the first step were inserted (only ids missing from the store). */
const SEED_KEY_MISSING = "default-tools-2";
/** Seed key: builtin commands seeded with an absolute engine file path were turned back into `{{name}}`. */
const SEED_KEY_PLACEHOLDERS = "default-tools-placeholders";
/** Fields whose `{{name}}` placeholders the engine expands when it uses them (launch, check). */
const PLACEHOLDER_FIELDS = ["command", "checkCommand"] as const;
/** İş A seed key: default waitingPatterns were copied onto builtin tools that had none. */
const SEED_KEY_WAITING = "default-tools-waiting-patterns";
/** `-l -c`: login shell (PATH from profile) but never `-i`, so interactive-only aliases are not loaded. */
const CHECK_SHELL_FLAG = "-lc";
const CHECK_KILL_SIGNAL = "SIGKILL";

const SeedStepSchema = z.object({ key: z.string().min(1), toolIds: z.array(z.string().min(1)) }).strict();

const ToolDefaultsSchema = z
  .object({
    checkTimeoutMs: z.number().int().positive(),
    idMaxLen: z.number().int().positive(),
    idFallback: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    /** Initial global default tool (settings), applied once. Must be one of `tools`. */
    defaultToolId: z.string().min(1),
    tools: z.array(ToolSchema.omit({ builtin: true }).strict()),
    /** İş A: waiting patterns for terminals without a tool (or whose tool has none). */
    genericWaitingPatterns: z.array(z.string().min(1)).default([]),
    /**
     * Files shipped with the engine that `command`/`checkCommand` reference as `{{name}}`: name → path relative
     * to this file's directory. Stored as the placeholder; expanded to the shell-quoted absolute path of the
     * running engine's copy when the command is used (launch, check), so it survives a moved or removed checkout.
     */
    files: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/), z.string().min(1)).default({}),
    /** Seed steps after the first two: each inserts only its own tools, once, and only when missing. */
    laterSteps: z.array(SeedStepSchema).default([]),
    /**
     * Waiting-pattern backfills after the first one: each copies the default patterns onto its builtin tools
     * that have none, once (for tools whose defaults gained patterns after they were seeded).
     */
    waitingPatternSteps: z.array(SeedStepSchema).default([]),
  })
  .strict()
  .refine((d) => d.tools.some((t) => t.id === d.defaultToolId), "defaultToolId must be one of tools")
  .refine(
    (d) => d.laterSteps.every((s) => s.toolIds.every((id) => d.tools.some((t) => t.id === id))),
    "laterSteps toolIds must be among tools",
  )
  .refine(
    (d) => d.waitingPatternSteps.every((s) => s.toolIds.every((id) => d.tools.some((t) => t.id === id))),
    "waitingPatternSteps toolIds must be among tools",
  );
export type ToolDefaults = z.infer<typeof ToolDefaultsSchema>;

/** Defaults plus `fileArgs`: placeholder name → shell-quoted absolute path of the file in this engine. */
export type LoadedToolDefaults = ToolDefaults & { fileArgs: Record<string, string> };

export function loadToolDefaults(path: string = TOOL_DEFAULTS_PATH): LoadedToolDefaults {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`cannot read tool defaults ${path}: ${(err as Error).message}`);
  }
  const r = ToolDefaultsSchema.safeParse(raw);
  if (!r.success) throw new Error(`invalid tool defaults ${path}: ${r.error.issues[0]?.message ?? "invalid"}`);
  const fileArgs: Record<string, string> = {};
  for (const [name, rel] of Object.entries(r.data.files)) {
    const abs = resolve(dirname(path), rel);
    if (!existsSync(abs)) throw new Error(`tool defaults ${path}: file ${rel} (${abs}) not found`);
    fileArgs[name] = quoteShellArg(abs);
  }
  for (const t of r.data.tools) {
    for (const m of (t.installCommand ?? "").matchAll(PLACEHOLDER)) {
      throw new Error(`tool defaults ${path}: placeholder {{${m[1]}}} is not expanded in installCommand`);
    }
    for (const field of PLACEHOLDER_FIELDS) {
      for (const m of (t[field] ?? "").matchAll(PLACEHOLDER)) {
        if (Object.hasOwn(fileArgs, m[1]!)) continue;
        if (field !== "command" || !LAUNCH_PLACEHOLDERS.includes(m[1]!)) throw new Error(`tool defaults ${path}: unknown placeholder {{${m[1]}}}`);
      }
    }
  }
  return { ...r.data, fileArgs };
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** One shell word as quoteShellArg writes it: '…', where a quote inside appears as '\''. */
const QUOTED_PATH_BODY = String.raw`'(?:[^']|'\\'')*/`;

/**
 * Matches `template` with each `{{name}}` replaced by some quoted absolute path ending in that file's relative
 * path: what seeding wrote before commands kept their placeholders. null when there is nothing to match.
 */
function stalePathPattern(template: string, files: Record<string, string>): RegExp | null {
  const parts = template.split(PLACEHOLDER);
  if (parts.length === 1) return null;
  let src = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) src += escapeRe(parts[i]!);
    else {
      const rel = files[parts[i]!];
      if (rel === undefined) return null;
      src += `${QUOTED_PATH_BODY}${escapeRe(rel)}'`;
    }
  }
  return new RegExp(`^${src}$`);
}

export type CheckRunner = (shell: string, args: string[], timeoutMs: number) => Promise<{ code: number | null }>;

export interface ToolServiceDeps {
  config: EngineConfig;
  store: StateStore;
  logger: Logger;
  /** How many projects use the tool as their default (delete is refused while > 0). */
  projectsUsingTool: (toolId: string) => number;
  /** True when the tool is the global default in settings (delete is refused). */
  isGlobalDefault: (toolId: string) => boolean;
  defaults: Tool[];
  checkTimeoutMs: number;
  /** Slug limits for ids of user-created tools. */
  idMaxLen: number;
  idFallback: string;
  /** Seed steps after step 2 (tools.defaults.json `laterSteps`). */
  laterSteps?: ToolDefaults["laterSteps"];
  /** tools.defaults.json `files` (name → relative path), to recognise old seeded absolute paths. */
  files?: Record<string, string>;
  /** `{{name}}` → shell-quoted absolute path, expanded in checkCommand. */
  fileArgs?: Record<string, string>;
  /** Waiting-pattern backfills after the first (tools.defaults.json `waitingPatternSteps`). */
  waitingPatternSteps?: ToolDefaults["waitingPatternSteps"];
  run?: CheckRunner;
}

/** Exit code of `shell args`; null when it could not run or was killed (timeout). */
export const execCheck: CheckRunner = (shell, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(shell, args, { timeout: timeoutMs, killSignal: CHECK_KILL_SIGNAL }, (err) => {
      if (!err) return resolve({ code: 0 });
      const code = (err as { code?: unknown }).code;
      resolve({ code: typeof code === "number" && !(err as { killed?: boolean }).killed ? code : null });
    });
  });

export function createToolService(deps: ToolServiceDeps): ToolService {
  const { config, store, logger, checkTimeoutMs } = deps;
  const run = deps.run ?? execCheck;

  function require(toolId: string): Tool {
    const t = store.getTool(toolId);
    if (!t) throw engineError("NOT_FOUND", "engine.tools.notFound");
    return t;
  }

  function uniqueId(name: string): string {
    const base = slugify(name, deps.idMaxLen, deps.idFallback);
    if (!store.getTool(base)) return base;
    for (let n = 2; ; n++) {
      const id = `${base}-${n}`;
      if (!store.getTool(id)) return id;
    }
  }

  async function checkOne(t: Tool): Promise<ToolStatus> {
    if (t.checkCommand === undefined) return { toolId: t.id, installed: null };
    try {
      const command = expandPlaceholders(t.checkCommand, deps.fileArgs ?? {});
      const { code } = await run(config.shell, [CHECK_SHELL_FLAG, command], checkTimeoutMs);
      return { toolId: t.id, installed: code === 0 };
    } catch (err) {
      logger.warn("tool check failed", { toolId: t.id, error: String(err) });
      return { toolId: t.id, installed: false };
    }
  }

  /**
   * Copies the default waiting patterns onto builtin tools (all, or only `toolIds`) that have none, once per `key`.
   * İş A: stores seeded before waiting patterns existed; later steps: defaults that gained patterns afterwards.
   */
  function seedWaitingPatterns(key: string, toolIds?: string[]): void {
    if (store.isSeeded(key)) return;
    for (const d of deps.defaults) {
      if (toolIds !== undefined && !toolIds.includes(d.id)) continue;
      const t = store.getTool(d.id);
      if (!t?.builtin || t.waitingPatterns !== undefined || d.waitingPatterns === undefined) continue;
      store.upsertTool({ ...t, waitingPatterns: [...d.waitingPatterns] });
    }
    store.markSeeded(key);
  }

  /** Builtin commands seeded with an absolute engine file path get their placeholder back, once, if otherwise unchanged. */
  function migrateFilePaths(): void {
    if (store.isSeeded(SEED_KEY_PLACEHOLDERS)) return;
    for (const d of deps.defaults) {
      const t = store.getTool(d.id);
      if (!t?.builtin) continue;
      const next: Tool = { ...t };
      for (const field of PLACEHOLDER_FIELDS) {
        const template = d[field];
        const stored = t[field];
        if (template === undefined || stored === undefined) continue;
        if (stalePathPattern(template, deps.files ?? {})?.test(stored)) next[field] = template;
      }
      if (PLACEHOLDER_FIELDS.some((f) => next[f] !== t[f])) {
        store.upsertTool(next);
        logger.info("tool file path migrated to placeholder", { toolId: t.id });
      }
    }
    store.markSeeded(SEED_KEY_PLACEHOLDERS);
  }

  return {
    init(): void {
      if (!store.isSeeded(SEED_KEY)) {
        for (const t of deps.defaults) store.upsertTool({ ...t, builtin: true });
        store.markSeeded(SEED_KEY);
      } else if (!store.isSeeded(SEED_KEY_MISSING)) {
        const added = deps.defaults.filter((t) => !store.getTool(t.id));
        for (const t of added) store.upsertTool({ ...t, builtin: true });
        if (added.length > 0) logger.info("default tools added", { toolIds: added.map((t) => t.id) });
      }
      store.markSeeded(SEED_KEY_MISSING);
      seedWaitingPatterns(SEED_KEY_WAITING);
      for (const step of deps.waitingPatternSteps ?? []) seedWaitingPatterns(step.key, step.toolIds);
      migrateFilePaths();
      // Fresh installs and step 2 above already inserted every default; these only fill in what is missing.
      for (const step of deps.laterSteps ?? []) {
        if (store.isSeeded(step.key)) continue;
        const added = deps.defaults.filter((t) => step.toolIds.includes(t.id) && !store.getTool(t.id));
        for (const t of added) store.upsertTool({ ...t, builtin: true });
        if (added.length > 0) logger.info("default tools added", { step: step.key, toolIds: added.map((t) => t.id) });
        store.markSeeded(step.key);
      }
    },

    list(): Tool[] {
      return store.listTools();
    },

    get(toolId: string): Tool | undefined {
      return store.getTool(toolId);
    },

    create(input: ParamsOf<"tools.create">): Tool {
      const tool: Tool = {
        id: uniqueId(input.name),
        name: input.name,
        command: input.command,
        ...(input.installCommand !== undefined ? { installCommand: input.installCommand } : {}),
        ...(input.checkCommand !== undefined ? { checkCommand: input.checkCommand } : {}),
        ...(input.waitingPatterns !== undefined ? { waitingPatterns: [...input.waitingPatterns] } : {}),
      };
      store.upsertTool(tool);
      logger.info("tool created", { toolId: tool.id });
      return tool;
    },

    update(input: ParamsOf<"tools.update">): Tool {
      const next: Tool = { ...require(input.toolId) };
      if (input.name !== undefined) next.name = input.name;
      if (input.command !== undefined) next.command = input.command;
      for (const key of ["installCommand", "checkCommand"] as const) {
        const v = input[key];
        if (v === null) delete next[key];
        else if (v !== undefined) next[key] = v;
      }
      if (input.waitingPatterns === null) delete next.waitingPatterns;
      else if (input.waitingPatterns !== undefined) next.waitingPatterns = [...input.waitingPatterns];
      store.upsertTool(next);
      logger.info("tool updated", { toolId: next.id });
      return next;
    },

    delete(toolId: string): void {
      require(toolId);
      if (deps.isGlobalDefault(toolId)) {
        throw engineError("INVALID", "engine.tools.globalDefault");
      }
      const n = deps.projectsUsingTool(toolId);
      if (n > 0) throw engineError("INVALID", "engine.tools.projectDefault", { count: n });
      store.removeTool(toolId);
      logger.info("tool deleted", { toolId });
    },

    check(): Promise<ToolStatus[]> {
      return Promise.all(store.listTools().map(checkOne));
    },
  };
}
