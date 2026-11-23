// İş M: the user's web sites (Ayarlar › Siteler) as one JSON file in userData, next to ui-state.json. Main is the
// authority: the Git menu and the web views read this list, the renderer only sends a whole new list to validate.
//
// New defaults reach an existing install once: the file records the ids of the defaults it has already been offered
// (`seededDefaults`). On load, a default that is not in that record is appended and recorded — so a default the
// user deleted never comes back and one the user edited is never overwritten. A file from before the record existed
// has seen exactly the config's `defaultsSeededBeforeMarker`.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { checkSites, isSiteId, parseSites, webConfig, type SiteRules, type WebSite } from "../renderer/engine/web-ipc.ts";
import { WebError } from "./web-policy.ts";

const FILE_VERSION = 1;
const FILE_MODE = 0o600;

export interface WebSitesFile {
  /** The saved list (with defaults it has not been offered yet), or the defaults when nothing (valid) is saved. */
  load(): Promise<WebSite[]>;
  /** Throws WebError (user-facing) for an invalid list. Returns the normalized list. */
  save(input: unknown): Promise<WebSite[]>;
}

export interface WebSitesFileOptions {
  filePath: string;
  defaults: readonly WebSite[];
  /** Default ids a file without `seededDefaults` has already seen (config `defaultsSeededBeforeMarker`). */
  seededBeforeMarker: readonly string[];
  rules?: SiteRules;
}

/**
 * Adds the defaults `seeded` does not name to `sites` (at the end, in config order). A default whose id or address
 * is already in the list is only recorded: the user's entry wins. Nothing is added past the site limit.
 */
export function mergeNewDefaults(
  sites: readonly WebSite[],
  defaults: readonly WebSite[],
  seeded: readonly string[],
  rules: Pick<SiteRules, "limits"> = webConfig,
): { sites: WebSite[]; seeded: string[]; changed: boolean } {
  const out = [...sites];
  const seen = new Set(seeded);
  for (const d of defaults) {
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    if (out.length >= rules.limits.maxSites || out.some((s) => s.id === d.id || s.url === d.url)) continue;
    out.push({ ...d });
  }
  return { sites: out, seeded: [...seen], changed: seen.size !== new Set(seeded).size };
}

export function createWebSitesFile({ filePath, defaults, seededBeforeMarker, rules = webConfig }: WebSitesFileOptions): WebSitesFile {
  /** Default ids the file has been offered; null until the file was read. */
  let seeded: string[] | null = null;

  /** The file's sites and its record of seen defaults; null when nothing valid is saved. */
  async function read(): Promise<{ sites: WebSite[]; seeded: string[] } | null> {
    try {
      const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
      if (raw === null || typeof raw !== "object") return null;
      const r = raw as Record<string, unknown>;
      if (r.version !== FILE_VERSION || !Array.isArray(r.sites)) return null;
      const marker = Array.isArray(r.seededDefaults) ? r.seededDefaults.filter((id): id is string => isSiteId(id, rules)) : [...seededBeforeMarker];
      return { sites: parseSites(r.sites, rules), seeded: marker };
    } catch {
      return null;
    }
  }

  async function write(sites: readonly WebSite[], seededDefaults: readonly string[]): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: FILE_VERSION, sites, seededDefaults }, null, 2), { mode: FILE_MODE });
    await rename(tmp, filePath);
  }

  const withDefaultIds = (ids: readonly string[]): string[] => [...new Set([...ids, ...defaults.map((d) => d.id)])];

  return {
    async load() {
      const saved = await read();
      if (!saved) {
        // Nothing saved: the defaults themselves. The record is written with the first save.
        seeded = withDefaultIds([]);
        return defaults.map((d) => ({ ...d }));
      }
      const merged = mergeNewDefaults(saved.sites, defaults, saved.seeded, rules);
      seeded = merged.seeded;
      if (merged.changed) {
        // Best effort: when the disk refuses, the same merge simply happens again at the next start.
        await write(merged.sites, merged.seeded).catch(() => {});
      }
      return merged.sites;
    },

    async save(input) {
      const check = checkSites(input, rules);
      if (!check.ok) throw new WebError(check.errors.join(" "));
      // Every current default counts as offered from now on: one the user just removed must not return.
      seeded = withDefaultIds(seeded ?? (await read())?.seeded ?? []);
      await write(check.sites, seeded);
      return check.sites;
    },
  };
}
