// İş C (Adım 8) — Claude envanteri: the skills, agents and slash commands Claude Code would see for a project.
//
// Three sources, each with its own root:
//   project  <project folder>/<configDirName>/{skills/*/SKILL.md, agents/*.md, commands/**/*.md}
//   user     <configDir>/{same layout}            configDir = configDirFor(project) (İş H: the project's account)
//   plugin   <configDir>/plugins/**/skills/*/SKILL.md (bounded depth; plugin name from .claude-plugin/plugin.json)
// Only markdown files matching those layouts are ever opened (plus plugin manifests, for their name). Every path is
// resolved to its real path and must stay inside its root (or a shared root, see `sharedRoots`); names starting
// with "." and ignored names are skipped, so credentials and settings next to these folders are never touched.
// Frontmatter is parsed by a tiny reader that extracts two top-level strings; nothing is evaluated.
import { closeSync, constants, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ClaudeInventoryItem, ClaudeInventoryResult, ClaudeItemKind, ClaudeItemSource, FileReadResult, Project } from "@kokpit/shared";
import { engineError } from "./contracts.ts";
import { decodeText, FILES_MAX_READ_BYTES } from "./files.ts";
import { isWithin, loadDefaultsFile, PathSegment } from "./fs-safety.ts";

export const CLAUDE_INVENTORY_DEFAULTS_PATH = fileURLToPath(new URL("../claude-inventory.defaults.json", import.meta.url));

// Claude Code's on-disk layout (a format, not a setting).
const SKILLS = "skills";
const AGENTS = "agents";
const COMMANDS = "commands";
const PLUGINS = "plugins";
const SKILL_FILE = "SKILL.md";
const CLAUDE_MD = "CLAUDE.md";
const MD_EXT = ".md";
const PLUGIN_MANIFEST = [".claude-plugin", "plugin.json"] as const;
const PLUGIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const count = (max: number) => z.number().int().min(1).max(max);

export const ClaudeInventoryConfigSchema = z
  .object({
    /** Folder name of Claude's config: in a project and (default account) in HOME. */
    configDirName: PathSegment,
    /** Names never entered nor listed, at any depth (besides every name starting with "."). */
    ignoreNames: z.array(PathSegment).max(100),
    /** Items returned; the rest is reported as `truncated`. */
    maxItems: count(100_000),
    /** Directory entries looked at per inventory, all sources together. */
    maxScanEntries: count(1_000_000),
    /** Head of each markdown file read for its frontmatter. */
    maxFrontmatterBytes: count(1024 * 1024),
    maxManifestBytes: count(1024 * 1024),
    /** Bytes of a file returned for preview. */
    maxReadBytes: count(FILES_MAX_READ_BYTES),
    maxNameChars: count(10_000),
    maxDescriptionChars: count(100_000),
    /** Folder levels below commands/ (a/b/x.md is 3). */
    commandsMaxDepth: count(32),
    /** Folder levels from plugins/ down to a `skills` folder. */
    pluginMaxDepth: count(32),
  })
  .strict();
export type ClaudeInventoryConfig = z.infer<typeof ClaudeInventoryConfigSchema>;

/** The `claudeInventory` key of engine.json: any subset of the defaults. */
export const ClaudeInventoryConfigOverrideSchema = ClaudeInventoryConfigSchema.partial().strict();
export type ClaudeInventoryConfigOverride = z.infer<typeof ClaudeInventoryConfigOverrideSchema>;

export function loadClaudeInventoryConfig(
  overrides: ClaudeInventoryConfigOverride,
  path: string = CLAUDE_INVENTORY_DEFAULTS_PATH,
): ClaudeInventoryConfig {
  return loadDefaultsFile(ClaudeInventoryConfigSchema, overrides, path, "claudeInventory");
}

/** Default account resolver: every project uses `<HOME>/<configDirName>`. İş H replaces it with the project's account. */
export function defaultConfigDirFor(homeDir: string, configDirName: string): (project: Project) => string {
  const dir = join(homeDir, configDirName);
  return () => dir;
}

// ---------- frontmatter ----------

export interface FrontmatterCaps {
  maxNameChars: number;
  maxDescriptionChars: number;
}

/**
 * `name` and `description` from a leading `---` YAML block. Only top-level plain, quoted and block (`|`, `>`) string
 * scalars are understood; anything else (mappings, lists, tags, anchors) is ignored. Never throws.
 */
export function parseFrontmatter(text: string, caps: FrontmatterCaps): { name?: string; description?: string } {
  const lines = (text.startsWith("﻿") ? text.slice(1) : text).split(/\r?\n/);
  if (lines.length < 2 || lines[0]!.trimEnd() !== "---") return {};
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i]!.trimEnd();
    if (l === "---" || l === "...") {
      end = i;
      break;
    }
  }
  if (end < 0) return {};
  const body = lines.slice(1, end);
  const out: { name?: string; description?: string } = {};
  for (let i = 0; i < body.length; i++) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:(?:[ \t]+(.*))?$/.exec(body[i]!);
    if (!m) continue;
    const cont: string[] = [];
    while (i + 1 < body.length && (body[i + 1]!.trim() === "" || /^[ \t]/.test(body[i + 1]!))) cont.push(body[++i]!);
    const key = m[1];
    if ((key !== "name" && key !== "description") || out[key] !== undefined) continue;
    const raw = scalar((m[2] ?? "").trim(), cont);
    if (raw === undefined) continue;
    const clean = sanitize(raw, key === "name" ? caps.maxNameChars : caps.maxDescriptionChars, key === "name");
    if (clean !== "") out[key] = clean;
  }
  return out;
}

function scalar(rest: string, cont: string[]): string | undefined {
  if (/^[|>][+-]?[0-9]?[+-]?([ \t]+#.*)?$/.test(rest)) {
    const filled = cont.filter((l) => l.trim() !== "");
    const indent = Math.min(...filled.map((l) => /^[ \t]*/.exec(l)![0].length));
    const block = cont.map((l) => l.slice(Math.min(indent, l.length)).trimEnd());
    while (block.length > 0 && block[block.length - 1] === "") block.pop();
    return rest.startsWith("|") ? block.join("\n") : block.filter((l) => l !== "").join(" ");
  }
  const joined = [rest, ...cont.map((l) => l.trim()).filter((l) => l !== "")].join(" ");
  if (rest.startsWith('"')) return doubleQuoted(joined);
  if (rest.startsWith("'")) return singleQuoted(joined);
  if (rest === "" ? cont.some((l) => /^[ \t]+(-[ \t]|[^ \t:]+:([ \t]|$))/.test(l)) : /^[[{!&*@`|>%]/.test(rest)) return undefined;
  return joined.replace(/(^|[ \t])#.*$/, "").trim();
}

function doubleQuoted(s: string): string | undefined {
  const ESC: Record<string, string> = { n: "\n", t: "\t", '"': '"', "\\": "\\", "/": "/", " ": " ", "0": "" };
  let out = "";
  for (let i = 1; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"') return out;
    if (c === "\\") {
      const e = s[++i];
      if (e === undefined) return undefined;
      out += ESC[e] ?? e;
    } else out += c;
  }
  return undefined;
}

function singleQuoted(s: string): string | undefined {
  let out = "";
  for (let i = 1; i < s.length; i++) {
    const c = s[i]!;
    if (c === "'") {
      if (s[i + 1] === "'") {
        out += "'";
        i++;
      } else return out;
    } else out += c;
  }
  return undefined;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

function sanitize(s: string, max: number, oneLine: boolean): string {
  let v = s.replace(CONTROL, "");
  v = oneLine ? v.replace(/\s+/g, " ") : v.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).join("\n");
  v = v.trim();
  return v.length > max ? v.slice(0, Math.max(0, max - 1)) + "…" : v;
}

// ---------- service ----------

/** What a request is about. `projectRoot` null = no project folder on this machine (SSH, not cloned, …). */
export interface InventoryTarget {
  project: Project;
  projectRoot: string | null;
  /** Shown to the user when the project part is missing. */
  note?: string;
}

export interface ClaudeInventoryService {
  inventory(target: InventoryTarget): ClaudeInventoryResult;
  /** Throws EngineError: INVALID (bad id, leaves its root, not markdown), NOT_FOUND (missing). */
  read(target: InventoryTarget, id: string): FileReadResult;
}

export interface ClaudeInventoryDeps {
  config: ClaudeInventoryConfig;
  /** Shown as `~` in display paths. */
  homeDir: string;
  /** The project's Claude config dir (İş H: its account's; default `<HOME>/.claude`). */
  configDirFor(project: Project): string;
  /**
   * Folders outside a project's config dir that its user-level items may link into (İş H "share skills with the
   * default account" symlinks). Default: none.
   */
  sharedRoots?(project: Project): string[];
}

interface Root {
  source: ClaudeItemSource;
  /** Real path. */
  real: string;
  /** Prefix of display paths. */
  display: string;
  /** Real paths, besides `real`, that entries may resolve into. */
  also: string[];
}

interface Found {
  real: string;
  dir: boolean;
  file: boolean;
}

const KIND_ORDER: Record<ClaudeItemKind, number> = { skill: 0, agent: 1, command: 2 };
const SOURCE_ORDER: Record<ClaudeItemSource, number> = { project: 0, user: 1, plugin: 2 };
const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

const BAD_ID = "engine.claudeInventory.badId";
const OUTSIDE = "engine.claudeInventory.outside";
const MISSING = "engine.claudeInventory.missing";
const NOT_MD = "engine.claudeInventory.notMarkdown";
const NO_PROJECT = "engine.claudeInventory.noProjectDir";

function realDir(path: string): string | null {
  try {
    const real = realpathSync(path);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

const isMd = (name: string): boolean => name.toLowerCase().endsWith(MD_EXT);
const stem = (name: string): string => name.slice(0, -MD_EXT.length);

export function createClaudeInventory(deps: ClaudeInventoryDeps): ClaudeInventoryService {
  const cfg = deps.config;
  const fold = (s: string): string => s.normalize("NFC").toLowerCase();
  const ignored = new Set(cfg.ignoreNames.map(fold));
  const skipName = (name: string): boolean => name.startsWith(".") || ignored.has(fold(name));
  const caps = { maxNameChars: cfg.maxNameChars, maxDescriptionChars: cfg.maxDescriptionChars };

  function tilde(path: string): string {
    const home = deps.homeDir.endsWith(sep) ? deps.homeDir.slice(0, -1) : deps.homeDir;
    if (path === home) return "~";
    return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
  }

  const inside = (root: Root, real: string): boolean => isWithin(root.real, real) || root.also.some((r) => isWithin(r, real));

  /** `name` in `dirReal`, resolved, inside the root, a dir or regular file. */
  function child(root: Root, dirReal: string, name: string): Found | null {
    try {
      const real = realpathSync(join(dirReal, name));
      if (!inside(root, real)) return null;
      const st = statSync(real);
      return { real, dir: st.isDirectory(), file: st.isFile() };
    } catch {
      return null;
    }
  }

  // ---- roots ----

  function projectRoot(t: InventoryTarget): { root: Root | null; base: string | null } {
    const base = t.projectRoot === null ? null : realDir(t.projectRoot);
    if (base === null) return { root: null, base: null };
    const real = realDir(join(base, cfg.configDirName));
    if (real === null || !isWithin(base, real)) return { root: null, base };
    return { root: { source: "project", real, display: cfg.configDirName, also: [] }, base };
  }

  function userRoot(t: InventoryTarget): { root: Root | null; dir: string } {
    const dir = deps.configDirFor(t.project);
    const real = realDir(dir);
    if (real === null) return { root: null, dir };
    const also = (deps.sharedRoots?.(t.project) ?? []).map(realDir).filter((r): r is string => r !== null);
    return { root: { source: "user", real, display: tilde(dir), also }, dir };
  }

  function pluginRoot(user: Root, dir: string): Root | null {
    const real = realDir(join(user.real, PLUGINS));
    if (real === null || !isWithin(user.real, real)) return null;
    return { source: "plugin", real, display: `${tilde(dir)}/${PLUGINS}`, also: [] };
  }

  // ---- reading ----

  /** Opens a regular file (never following a link swapped in, never blocking on a FIFO) and reads its head. */
  function head(real: string, max: number): { bytes: Buffer; size: number } {
    let fd: number;
    try {
      fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
      throw engineError("NOT_FOUND", MISSING);
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw engineError("INVALID", NOT_MD);
      const buf = Buffer.alloc(Math.min(st.size, max));
      let got = 0;
      while (got < buf.length) {
        const n = readSync(fd, buf, got, buf.length - got, got);
        if (n === 0) break;
        got += n;
      }
      return { bytes: buf.subarray(0, got), size: st.size };
    } finally {
      closeSync(fd);
    }
  }

  function frontmatter(real: string): { name?: string; description?: string } {
    try {
      return parseFrontmatter(head(real, cfg.maxFrontmatterBytes).bytes.toString("utf8"), caps);
    } catch {
      return {};
    }
  }

  function pluginName(root: Root, parentReal: string, fallback: string): string {
    const found = child(root, join(parentReal, PLUGIN_MANIFEST[0]), PLUGIN_MANIFEST[1]);
    if (found?.file) {
      try {
        const parsed: unknown = JSON.parse(head(found.real, cfg.maxManifestBytes).bytes.toString("utf8"));
        const name = (parsed as { name?: unknown } | null)?.name;
        if (typeof name === "string" && PLUGIN_NAME_RE.test(name)) return name;
      } catch {
        /* fallback */
      }
    }
    return fallback;
  }

  // ---- scanning ----

  function scan(t: InventoryTarget): ClaudeInventoryResult {
    const items: ClaudeInventoryItem[] = [];
    let scanned = 0;
    let truncated = false;
    const visited = new Set<string>();

    function names(dirReal: string): string[] {
      let list: string[];
      try {
        list = readdirSync(dirReal);
      } catch {
        return [];
      }
      list = list.filter((n) => !skipName(n)).sort((a, b) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0));
      const room = cfg.maxScanEntries - scanned;
      if (list.length > room) {
        truncated = true;
        list = list.slice(0, Math.max(0, room));
      }
      scanned += list.length;
      return list;
    }

    function add(root: Root, kind: ClaudeItemKind, rel: string[], real: string, fallback: string, prefix = ""): boolean {
      if (items.length >= cfg.maxItems) {
        truncated = true;
        return false;
      }
      const fm = frontmatter(real);
      const base = fm.name ?? sanitize(fallback, cfg.maxNameChars, true);
      const relPath = rel.join("/");
      items.push({
        kind,
        name: prefix + base,
        ...(fm.description !== undefined ? { description: fm.description } : {}),
        source: root.source,
        path: `${root.display}/${relPath}`,
        id: `${root.source}:${relPath}`,
      });
      return true;
    }

    function skillsIn(root: Root, dirReal: string, rel: string[], prefix = "", seen?: Set<string>): void {
      for (const name of names(dirReal)) {
        const d = child(root, dirReal, name);
        if (!d?.dir) continue;
        const f = child(root, d.real, SKILL_FILE);
        if (!f?.file || !isMd(f.real)) continue;
        if (seen) {
          const key = prefix + (frontmatter(f.real).name ?? name);
          if (seen.has(key)) continue;
          seen.add(key);
        }
        if (!add(root, "skill", [...rel, name, SKILL_FILE], f.real, name, prefix)) return;
      }
    }

    function agentsIn(root: Root, dirReal: string): void {
      for (const name of names(dirReal)) {
        if (!isMd(name)) continue;
        const f = child(root, dirReal, name);
        if (!f?.file || !isMd(f.real)) continue;
        if (!add(root, "agent", [AGENTS, name], f.real, stem(name))) return;
      }
    }

    function commandsIn(root: Root, dirReal: string, sub: string[]): void {
      if (visited.has(dirReal)) return;
      visited.add(dirReal);
      for (const name of names(dirReal)) {
        const c = child(root, dirReal, name);
        if (!c) continue;
        const depth = sub.length + 1;
        if (c.dir && depth < cfg.commandsMaxDepth) commandsIn(root, c.real, [...sub, name]);
        else if (c.file && isMd(name) && isMd(c.real)) {
          if (!add(root, "command", [COMMANDS, ...sub, name], c.real, [...sub, stem(name)].join(":"))) return;
        }
      }
    }

    function level(root: Root): void {
      const s = child(root, root.real, SKILLS);
      if (s?.dir) skillsIn(root, s.real, [SKILLS]);
      const a = child(root, root.real, AGENTS);
      if (a?.dir) agentsIn(root, a.real);
      const c = child(root, root.real, COMMANDS);
      if (c?.dir) commandsIn(root, c.real, []);
    }

    function plugins(root: Root): void {
      const seen = new Set<string>();
      const queue: { real: string; rel: string[] }[] = [{ real: root.real, rel: [] }];
      visited.add(root.real);
      while (queue.length > 0 && !truncated) {
        const { real, rel } = queue.shift()!;
        for (const name of names(real)) {
          const c = child(root, real, name);
          if (!c?.dir || visited.has(c.real)) continue;
          visited.add(c.real);
          const relN = [...rel, name];
          if (name === SKILLS && rel.length > 0) {
            skillsIn(root, c.real, relN, `${pluginName(root, real, rel[rel.length - 1]!)}:`, seen);
          } else if (relN.length < cfg.pluginMaxDepth) {
            queue.push({ real: c.real, rel: relN });
          }
        }
      }
    }

    const fileIn = (dirReal: string, name: string): boolean => {
      try {
        const real = realpathSync(join(dirReal, name));
        return isWithin(dirReal, real) && statSync(real).isFile();
      } catch {
        return false;
      }
    };

    const proj = projectRoot(t);
    if (proj.root) level(proj.root);
    const user = userRoot(t);
    if (user.root) {
      level(user.root);
      const pr = pluginRoot(user.root, user.dir);
      if (pr) plugins(pr);
    }

    items.sort(
      (a, b) =>
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] ||
        collator.compare(a.name, b.name) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    return {
      items,
      truncated,
      claudeMd: {
        ...(proj.base !== null ? { project: fileIn(proj.base, CLAUDE_MD) } : {}),
        user: user.root !== null && fileIn(user.root.real, CLAUDE_MD),
      },
      ...(t.note !== undefined ? { note: t.note } : {}),
    };
  }

  // ---- read by id ----

  /** True when `segs` (below the source's root) is a layout this inventory lists. */
  function allowed(source: ClaudeItemSource, segs: string[]): boolean {
    const last = segs[segs.length - 1] ?? "";
    if (!isMd(last)) return false;
    if (source === "plugin") {
      const n = segs.length;
      return n >= 4 && segs[n - 3] === SKILLS && last === SKILL_FILE && n - 2 <= cfg.pluginMaxDepth;
    }
    switch (segs[0]) {
      case SKILLS:
        return segs.length === 3 && last === SKILL_FILE;
      case AGENTS:
        return segs.length === 2;
      case COMMANDS:
        return segs.length >= 2 && segs.length - 1 <= cfg.commandsMaxDepth;
      default:
        return false;
    }
  }

  function read(t: InventoryTarget, id: string): FileReadResult {
    const m = /^(project|user|plugin):(.+)$/s.exec(id);
    if (!m) throw engineError("INVALID", BAD_ID);
    const source = m[1] as ClaudeItemSource;
    const segs = m[2]!.split("/");
    for (const s of segs) {
      if (s === "" || s === ".." || s === "." || s.includes("\\") || s.includes("\0") || s.length > 255) {
        throw engineError("INVALID", s === ".." ? OUTSIDE : BAD_ID);
      }
      if (skipName(s)) throw engineError("INVALID", BAD_ID);
    }
    if (!allowed(source, segs)) throw engineError("INVALID", BAD_ID);

    let root: Root | null;
    if (source === "project") {
      if (t.projectRoot === null) throw engineError("INVALID", NO_PROJECT);
      root = projectRoot(t).root;
    } else {
      const user = userRoot(t);
      root = source === "user" || !user.root ? user.root : pluginRoot(user.root, user.dir);
    }
    if (!root) throw engineError("NOT_FOUND", MISSING);

    let real: string;
    try {
      real = realpathSync(join(root.real, ...segs));
    } catch {
      throw engineError("NOT_FOUND", MISSING);
    }
    if (!inside(root, real)) throw engineError("INVALID", OUTSIDE);
    let regular = false;
    try {
      regular = statSync(real).isFile();
    } catch {
      throw engineError("NOT_FOUND", MISSING);
    }
    if (!regular || !isMd(real)) throw engineError("INVALID", NOT_MD);

    const { bytes, size } = head(real, cfg.maxReadBytes);
    const truncated = size > bytes.length;
    const text = decodeText(bytes, truncated);
    return text === null ? { binary: true, size, truncated: false } : { text, size, truncated };
  }

  return { inventory: scan, read };
}
