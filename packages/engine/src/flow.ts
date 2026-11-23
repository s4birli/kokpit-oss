// İş W — Akış: the project's Mermaid flow diagrams (`<root>/<dir>/*.mmd`, dir from flow.defaults.json).
//
// Read-only, one folder level. The flow folder is reached segment by segment with lstat, so neither it nor any
// folder on the way may be a symlink, and its real path must lie strictly inside the root's real path. Only regular
// files (never symlinks) whose name is a flow id are listed or read; reads open with O_NOFOLLOW and are size-capped.
// The diagram text is never interpreted here: the app renders it with Mermaid in strict mode.
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { isFlowId, type FlowEntry } from "@kokpit/shared";
import { engineError } from "./contracts.ts";
import { FILES_MAX_READ_BYTES } from "./files.ts";
import { isStrictlyInside, loadDefaultsFile, PathSegment } from "./fs-safety.ts";
import { expandPlaceholders, PLACEHOLDER } from "./launch.ts";

export const FLOW_DEFAULTS_PATH = fileURLToPath(new URL("../flow.defaults.json", import.meta.url));

/** Relative folder: 1–10 plain segments joined by `/`. */
const RelDir = z
  .string()
  .min(1)
  .max(1000)
  .refine((s) => {
    const parts = s.split("/");
    return parts.length <= 10 && parts.every((p) => PathSegment.safeParse(p).success);
  }, "proje içinde göreli bir klasör olmalı");

const posInt = z.number().int().positive();

export const FlowConfigSchema = z
  .object({
    /** Folder under the project root that holds the `.mmd` files. */
    dir: RelDir,
    /** Flows listed; the rest is reported as `truncated`. */
    maxFiles: z.number().int().min(1).max(10_000),
    /** Largest flow file that is read (must fit one protocol frame). */
    maxBytes: z.number().int().min(1).max(FILES_MAX_READ_BYTES),
    /** Bytes read from the start of each file to find its `%% title:` line. */
    titleScanBytes: z.number().int().min(16).max(64 * 1024),
    titleMaxChars: posInt.max(1000),
    /** Typed into a project terminal by "Akışı çiz / güncelle"; `{{name}}` = an engine file (tools.defaults.json). */
    updateCommand: z.string().trim().min(1).max(1000),
  })
  .strict();
export type FlowConfig = z.infer<typeof FlowConfigSchema>;

/** The `flow` key of engine.json: any subset of the defaults. */
export const FlowConfigOverrideSchema = FlowConfigSchema.partial().strict();
export type FlowConfigOverride = z.infer<typeof FlowConfigOverrideSchema>;

/**
 * Defaults + overrides, with `{{name}}` in `updateCommand` replaced by `fileArgs` (shell-quoted absolute paths of
 * engine files). An unknown placeholder is a config error, never typed into a terminal.
 */
export function loadFlowConfig(
  overrides: FlowConfigOverride,
  fileArgs: Record<string, string>,
  path: string = FLOW_DEFAULTS_PATH,
): FlowConfig {
  const cfg = loadDefaultsFile(FlowConfigSchema, overrides, path, "flow");
  for (const m of cfg.updateCommand.matchAll(PLACEHOLDER)) {
    if (!Object.hasOwn(fileArgs, m[1]!)) throw new Error(`invalid flow config: updateCommand: unknown placeholder {{${m[1]}}}`);
  }
  return { ...cfg, updateCommand: expandPlaceholders(cfg.updateCommand, fileArgs) };
}

export interface FlowService {
  readonly dir: string;
  readonly updateCommand: string;
  /** Throws EngineError NOT_FOUND when the root itself is missing. A missing flow folder = no flows. */
  list(root: string): { flows: FlowEntry[]; truncated: boolean };
  /** Throws EngineError: INVALID (bad id, too large), NOT_FOUND (missing, symlink, not a file). */
  read(root: string, id: string): { text: string };
}

const TITLE_RE = /^%%\s*title\s*:\s*(.*)$/i;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

export function createFlowService(deps: { config: FlowConfig }): FlowService {
  const cfg = deps.config;
  const segments = cfg.dir.split("/");

  function realRoot(root: string): string {
    try {
      const real = realpathSync(root);
      if (statSync(real).isDirectory()) return real;
    } catch {
      /* below */
    }
    throw engineError("NOT_FOUND", "engine.files.rootMissing");
  }

  /** The flow folder's path when every step is a real (non-symlink) folder inside the root; else null. */
  function flowDir(root: string): string | null {
    const rootReal = realRoot(root);
    let dir = rootReal;
    for (const s of segments) {
      dir = join(dir, s);
      try {
        const st = lstatSync(dir);
        if (!st.isDirectory() || st.isSymbolicLink()) return null;
      } catch {
        return null;
      }
    }
    try {
      return isStrictlyInside(rootReal, realpathSync(dir)) ? dir : null;
    } catch {
      return null;
    }
  }

  /** Title from the first line (`%% title: …`), cleaned and capped; undefined when absent or empty. */
  function titleOf(file: string): string | undefined {
    let fd: number | undefined;
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const buf = Buffer.alloc(cfg.titleScanBytes);
      const n = readSync(fd, buf, 0, buf.length, 0);
      const first = buf.subarray(0, n).toString("utf8").replace(/^﻿/, "").split(/\r?\n/, 1)[0] ?? "";
      const m = TITLE_RE.exec(first);
      if (!m) return undefined;
      const title = [...m[1]!.replace(CONTROL_RE, "").trim()].slice(0, cfg.titleMaxChars).join("").trim();
      return title === "" ? undefined : title;
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  return {
    dir: cfg.dir,
    updateCommand: cfg.updateCommand,

    list(root) {
      const dir = flowDir(root);
      if (!dir) return { flows: [], truncated: false };
      let dirents;
      try {
        dirents = readdirSync(dir, { withFileTypes: true });
      } catch {
        return { flows: [], truncated: false };
      }
      const found: { id: string; full: string; mtimeMs: number }[] = [];
      for (const d of dirents) {
        if (!d.isFile() || !isFlowId(d.name)) continue;
        const full = join(dir, d.name);
        try {
          const st = lstatSync(full);
          if (st.isFile()) found.push({ id: d.name, full, mtimeMs: st.mtimeMs });
        } catch {
          /* vanished */
        }
      }
      found.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const shown = found.slice(0, cfg.maxFiles);
      const flows = shown.map((f): FlowEntry => {
        const title = titleOf(f.full);
        return {
          id: f.id,
          file: `${cfg.dir}/${f.id}`,
          ...(title !== undefined ? { title } : {}),
          modifiedAt: new Date(f.mtimeMs).toISOString(),
        };
      });
      return { flows, truncated: found.length > shown.length };
    },

    read(root, id) {
      if (!isFlowId(id)) throw engineError("INVALID", "engine.flow.badName");
      const dir = flowDir(root);
      if (!dir) throw engineError("NOT_FOUND", "engine.flow.noFolder");
      const full = join(dir, id);
      let fd: number;
      try {
        // O_NOFOLLOW: a symlink in place of the file fails here instead of being followed.
        fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch {
        throw engineError("NOT_FOUND", "engine.flow.notFound");
      }
      try {
        const st = fstatSync(fd);
        if (!st.isFile()) throw engineError("NOT_FOUND", "engine.flow.notFound");
        if (st.size > cfg.maxBytes) throw engineError("INVALID", "engine.flow.tooLarge");
        const buf = Buffer.alloc(st.size);
        let off = 0;
        while (off < buf.length) {
          const n = readSync(fd, buf, off, buf.length - off, off);
          if (n === 0) break;
          off += n;
        }
        return { text: buf.subarray(0, off).toString("utf8") };
      } finally {
        closeSync(fd);
      }
    },
  };
}
