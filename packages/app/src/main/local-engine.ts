// Yerel bağlantı: finds an engine running on this Mac so the connect screen can offer one-click "Bu Mac'teki
// motora bağlan". Read-only and quiet: anything missing, malformed, oversized or unreachable → null.
//
// Mirrors the engine's own lookup (packages/engine/src/config.ts — keep in sync):
//   environment  = the installed launchd agent's EnvironmentVariables (~/Library/LaunchAgents/<label>.plist,
//                  written by `pnpm engine:launchd`) when present, else this process' env;
//   config file  = KOKPIT_CONFIG, else $XDG_CONFIG_HOME/kokpit/engine.json, else ~/.config/kokpit/engine.json;
//   port         = KOKPIT_PORT > file `port` > the installed engine's config.defaults.json > `defaultPort` here;
//   key          = KOKPIT_KEY > file `key` > <dataDir>/engine.key (trimmed).
// Only `dataDir`, `port`, `key` and `listenLocalhost` are read. `defaultPort` / `defaultListenLocalhost` /
// `launchdLabel` in local-engine.defaults.json duplicate the engine's config.defaults.json and
// launchd/defaults.json; they are only used when the installed engine's own files cannot be found.
//
// The key is never logged and never returned to the renderer (see createLocalEngineService).
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import defaults from "./local-engine.defaults.json" with { type: "json" };
import type { LocalEngineInfo } from "../renderer/engine/local-engine-ipc.ts";
import { t } from "../i18n/index.ts";

export type LocalEngineConfig = typeof defaults;
export const localEngineDefaults: LocalEngineConfig = defaults;

export interface LocalEngine {
  url: string;
  port: number;
  key: string;
}

export interface LocalEngineDeps {
  /** This process' environment (HOME, and KOKPIT_* / XDG_CONFIG_HOME when no launchd agent is installed). */
  env: NodeJS.ProcessEnv;
  config?: LocalEngineConfig;
  /** Why detection gave up; never receives the key. */
  log?: (message: string) => void;
}

/** A message that is safe to show in the UI. */
export class LocalEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalEngineError";
  }
}

const MAX_PORT = 65535;
const portSchema = z.number().int().min(0).max(MAX_PORT);

/** The engine file fields we read; everything else in the file is ignored (stripped). */
const EngineFileSchema = z.object({
  dataDir: z.string().min(1).optional(),
  port: portSchema.optional(),
  key: z.string().optional(),
  listenLocalhost: z.boolean().optional(),
});
type EngineFile = z.infer<typeof EngineFileSchema>;

class Skip extends Error {}

/** Reads a whole file of at most `max` bytes; larger or unreadable → Skip. */
async function readCapped(path: string, max: number, what: string): Promise<string> {
  let fh;
  try {
    fh = await open(path, "r");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new Skip(code === "ENOENT" ? `${what} yok` : `${what} okunamadı (${code ?? "hata"})`);
  }
  try {
    const buf = Buffer.alloc(max + 1);
    let total = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, total, buf.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > max) throw new Skip(`${what} çok büyük`);
    }
    return buf.subarray(0, total).toString("utf8");
  } catch (e) {
    if (e instanceof Skip) throw e;
    throw new Skip(`${what} okunamadı`);
  } finally {
    await fh.close();
  }
}

async function readOptional(path: string, max: number): Promise<string | null> {
  try {
    return await readCapped(path, max, "dosya");
  } catch {
    return null;
  }
}

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

const XML_ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&amp;": "&" };
const xmlUnescape = (s: string): string => s.replace(/&(lt|gt|quot|apos|amp);/g, (m) => XML_ENTITIES[m]!);
const plistStrings = (xml: string): string[] => [...xml.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => xmlUnescape(m[1]!));

/**
 * The launchd agent's environment and the engine package dir (from ProgramArguments [node, <engine>/src/main.ts]).
 * Only the plist shape the engine's own installer writes is understood.
 */
export function parseLaunchdPlist(xml: string): { env: Record<string, string>; engineDir: string | null } {
  const env: Record<string, string> = {};
  const envDict = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(xml)?.[1];
  if (envDict) {
    for (const m of envDict.matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)) {
      env[xmlUnescape(m[1]!)] = xmlUnescape(m[2]!);
    }
  }
  const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml)?.[1];
  const entry = args ? plistStrings(args)[1] : undefined;
  const engineDir = entry && isAbsolute(entry) ? dirname(dirname(entry)) : null;
  return { env, engineDir };
}

/** The installed engine's defaults (port, listenLocalhost), or null when not resolvable. */
async function readEngineDefaults(engineDir: string | null, c: LocalEngineConfig): Promise<EngineFile | null> {
  if (!engineDir) return null;
  const text = await readOptional(join(engineDir, c.engineDefaultsFileName), c.maxConfigBytes);
  if (text === null) return null;
  try {
    const r = EngineFileSchema.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

function resolveConfigPath(env: Record<string, string | undefined>, home: string, c: LocalEngineConfig): string {
  if (env.KOKPIT_CONFIG) return resolve(expandHome(env.KOKPIT_CONFIG, home));
  const base = env.XDG_CONFIG_HOME ? expandHome(env.XDG_CONFIG_HOME, home) : join(home, ".config");
  return join(base, c.configDirName, c.configFileName);
}

function parseEngineFile(text: string): EngineFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Skip("motor ayar dosyası geçerli JSON değil");
  }
  const r = EngineFileSchema.safeParse(raw);
  if (!r.success) throw new Skip(`motor ayar dosyası geçersiz (${r.error.issues[0]?.path.join(".") || "kök"})`);
  return r.data;
}

function validKey(key: string, c: LocalEngineConfig): boolean {
  return key.length >= c.minKeyLength && key.length <= c.maxKeyLength;
}

async function healthy(port: number, c: LocalEngineConfig): Promise<boolean> {
  try {
    const res = await fetch(`http://${c.host}:${port}${c.healthPath}`, {
      signal: AbortSignal.timeout(c.healthTimeoutMs),
      redirect: "error",
    });
    if (res.status !== 200) return false;
    const body: unknown = await res.json();
    return body !== null && typeof body === "object" && (body as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

async function detect(deps: LocalEngineDeps): Promise<LocalEngine> {
  const c = deps.config ?? localEngineDefaults;
  const appHome = deps.env.HOME || homedir();

  const plistText = await readOptional(join(appHome, c.launchAgentsDir, `${c.launchdLabel}.plist`), c.maxPlistBytes);
  const plist = plistText === null ? null : parseLaunchdPlist(plistText);
  const env: Record<string, string | undefined> = plist ? plist.env : deps.env;
  const home = env.HOME || appHome;

  const engineDefaults = await readEngineDefaults(plist?.engineDir ?? null, c);
  const configPath = resolveConfigPath(env, home, c);
  const file = parseEngineFile(await readCapped(configPath, c.maxConfigBytes, "motor ayar dosyası"));

  if ((file.listenLocalhost ?? engineDefaults?.listenLocalhost ?? c.defaultListenLocalhost) === false) {
    throw new Skip("motor 127.0.0.1'i dinlemiyor (listenLocalhost: false)");
  }

  let port = file.port ?? engineDefaults?.port ?? c.defaultPort;
  if (env.KOKPIT_PORT) {
    const n = /^\d+$/.test(env.KOKPIT_PORT) ? Number(env.KOKPIT_PORT) : NaN;
    if (!portSchema.safeParse(n).success) throw new Skip("KOKPIT_PORT geçersiz");
    port = n;
  }
  if (port === 0) throw new Skip("motor rastgele port kullanıyor (port: 0)");

  let key: string | undefined = env.KOKPIT_KEY || file.key;
  if (key === undefined) {
    const dataDirRaw = env.KOKPIT_DATA_DIR || file.dataDir;
    if (!dataDirRaw) throw new Skip("dataDir yok");
    const dataDir = expandHome(dataDirRaw, home);
    if (!isAbsolute(dataDir)) throw new Skip("dataDir mutlak bir yol değil");
    key = (await readCapped(join(resolve(dataDir), c.keyFileName), c.maxKeyBytes, "anahtar dosyası")).trim();
  }
  if (!validKey(key, c)) throw new Skip("anahtar geçersiz uzunlukta");

  if (!(await healthy(port, c))) throw new Skip(`motor ${c.host}:${port} adresinde yanıt vermiyor`);
  return { url: `ws://${c.host}:${port}`, port, key };
}

/**
 * "0" turns detection off. The e2e harness sets it for every app launch, so tests never read this Mac's real
 * engine config or key; the local-connect e2e turns it back on with a temp HOME.
 */
export const LOCAL_ENGINE_DETECT_ENV = "KOKPIT_LOCAL_ENGINE_DETECT";

/** A reachable engine on this Mac with its key, or null. Never throws. */
export async function detectLocalEngine(deps: LocalEngineDeps): Promise<LocalEngine | null> {
  if (deps.env[LOCAL_ENGINE_DETECT_ENV] === "0") return null;
  try {
    return await detect(deps);
  } catch (e) {
    deps.log?.(`[kokpit] yerel motor bulunamadı: ${e instanceof Skip ? e.message : "beklenmeyen hata"}`);
    return null;
  }
}

export interface LocalEngineServiceDeps {
  detect: () => Promise<LocalEngine | null>;
  /** The settings store's save (validates and encrypts). */
  save: (settings: { url: string; key: string }) => Promise<void>;
}

/** What main exposes over IPC: the address for the renderer, and a connect that keeps the key in main. */
export function createLocalEngineService(deps: LocalEngineServiceDeps) {
  return {
    async info(): Promise<LocalEngineInfo | null> {
      const found = await deps.detect();
      return found ? { address: new URL(found.url).host } : null;
    },
    async connect(): Promise<void> {
      const found = await deps.detect();
      if (!found) throw new LocalEngineError(t("main.localEngine.notFound"));
      await deps.save({ url: found.url, key: found.key });
    },
  };
}
