// Kendini güncelleme: one command for a release on the engine Mac, in the order that keeps apps and engine in step.
//
//   pnpm deploy:local [--config <engine.json>] [--label <launchd label>] [--skip-build] [--wait[=<seconds>]] [--dry-run]
//
//   0. key       scripts/publish-app.ts keygen --config … → the publisher key (once; outside the repo)
//   1. build     pnpm --filter @kokpit/app dist          → packages/app/dist/mac-arm64/Kokpit.app (+ the zip),
//                with that key's PUBLIC half embedded (KOKPIT_APP_SIGNING_DIR)
//   2. publish   scripts/publish-app.ts --config …        → <dataDir>/app-updates/<buildId>/, current.json, signed
//   3. engine    scripts/launchd.ts install --config …    → the launchd service restarts with the new code
//   4. wait      (only with --wait) until every app that reconnects reports the published build
//
// The build is published BEFORE the engine restarts: the moment apps reconnect to the new engine they already find
// their update. Each step must succeed for the next to run; nothing is rolled back (a failed step is fixed and the
// command run again — publishing the same build twice is harmless).
//
// Without --config the engine's own rule applies: $KOKPIT_CONFIG, else ~/.config/kokpit/engine.json.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { authenticate } from "../src/ws-auth-client.ts";
import { isLoopbackAddress } from "../src/net.ts";
import type { AppUpdateClient, AppUpdateManifest } from "@kokpit/shared";
import { isLocale, LOCALES } from "@kokpit/shared/i18n";

const ENGINE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_DIR = resolve(ENGINE_DIR, "..", "..");
const DEFAULTS = JSON.parse(readFileSync(join(ENGINE_DIR, "deploy.defaults.json"), "utf8")) as {
  pnpm: string;
  appFilter: string;
  distScript: string;
  configDirName: string;
  configFileName: string;
  keyFileName: string;
  host: string;
  waitSeconds: number;
  /** Environment variable the app's build reads the publisher key folder from. */
  signingDirEnv: string;
  /** i18n: environment variable the app's build reads its default language from. */
  defaultLanguageEnv: string;
  waitPollMs: number;
  requestTimeoutMs: number;
};
const ENGINE_DEFAULTS = JSON.parse(readFileSync(join(ENGINE_DIR, "config.defaults.json"), "utf8")) as { port: number };
const APP_UPDATE_DEFAULTS = JSON.parse(readFileSync(join(ENGINE_DIR, "app-updates.defaults.json"), "utf8")) as { signingKeyDir: string };

export class DeployError extends Error {}

export interface ClientsAnswer {
  current: AppUpdateManifest | null;
  clients: AppUpdateClient[];
}

export interface DeployDeps {
  cwd: string;
  homedir: string;
  env: Record<string, string | undefined>;
  nodePath: string;
  /** Runs a command with its output shown (and `env` added to this process's); resolves to its exit status. */
  run(cmd: string, args: string[], cwd: string, env?: Record<string, string>): number | null;
  readFile(path: string): string;
  /** Asks the running engine which app builds it has seen. */
  clients(target: { host: string; port: number; key: string }): Promise<ClientsAnswer>;
  sleep(ms: number): Promise<void>;
  now(): number;
  stdout(s: string): void;
  stderr(s: string): void;
}

const USAGE = "usage: deploy-local.ts [--config <engine.json>] [--label <label>] [--skip-build] [--wait[=<seconds>]] [--dry-run]\n";
const expandHome = (p: string, home: string): string => (p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p);
const shown = (cmd: string, args: string[]): string => [cmd, ...args].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");

/** The config file the engine itself would read. */
export function resolveConfigPath(deps: Pick<DeployDeps, "cwd" | "homedir" | "env">, flag: string | undefined): string {
  if (flag !== undefined) return resolve(deps.cwd, expandHome(flag, deps.homedir));
  const fromEnv = deps.env.KOKPIT_CONFIG;
  if (fromEnv) return resolve(deps.cwd, expandHome(fromEnv, deps.homedir));
  const base = deps.env.XDG_CONFIG_HOME ? expandHome(deps.env.XDG_CONFIG_HOME, deps.homedir) : join(deps.homedir, ".config");
  return join(base, DEFAULTS.configDirName, DEFAULTS.configFileName);
}

/** The publisher key folder the engine config names (appUpdates.signingKeyDir, `~/` = home). */
export function signingKeyDirOf(deps: Pick<DeployDeps, "homedir" | "readFile">, configPath: string): string {
  const cfg = JSON.parse(deps.readFile(configPath)) as { appUpdates?: { signingKeyDir?: unknown } };
  const raw = typeof cfg.appUpdates?.signingKeyDir === "string" ? cfg.appUpdates.signingKeyDir : APP_UPDATE_DEFAULTS.signingKeyDir;
  return expandHome(raw, deps.homedir);
}

/**
 * i18n: the app build's default language — the engine config's `language` when it sets one (the build then starts in
 * the same language as its engine); otherwise nothing, and the build keeps the shared default.
 */
export function buildLanguageEnv(deps: Pick<DeployDeps, "readFile">, configPath: string): Record<string, string> {
  const cfg = JSON.parse(deps.readFile(configPath)) as { language?: unknown };
  if (cfg.language === undefined) return {};
  if (!isLocale(cfg.language)) throw new DeployError(`config ${configPath}: language must be one of ${LOCALES.join(", ")}`);
  return { [DEFAULTS.defaultLanguageEnv]: cfg.language };
}

/** Where and with which key the running engine is reached on this Mac (for --wait). */
export function engineTarget(deps: Pick<DeployDeps, "homedir" | "env" | "readFile">, configPath: string, host: string = DEFAULTS.host): { host: string; port: number; key: string } {
  // The access key's handshake binds no channel: it is only ever run with the engine on this Mac (loopback).
  if (!isLoopbackAddress(host)) throw new DeployError(`deploy talks to the engine only over loopback, not ${host}`);
  const cfg = JSON.parse(deps.readFile(configPath)) as { dataDir?: unknown; port?: unknown; key?: unknown };
  const port = typeof cfg.port === "number" ? cfg.port : ENGINE_DEFAULTS.port;
  let key = deps.env.KOKPIT_KEY ?? (typeof cfg.key === "string" ? cfg.key : undefined);
  if (key === undefined) {
    if (typeof cfg.dataDir !== "string" || cfg.dataDir === "") throw new DeployError(`config ${configPath} has no "dataDir"`);
    const dataDir = expandHome(cfg.dataDir, deps.homedir);
    if (!isAbsolute(dataDir)) throw new DeployError(`"dataDir" must be an absolute path`);
    try {
      key = deps.readFile(join(dataDir, DEFAULTS.keyFileName)).trim();
    } catch {
      throw new DeployError(`engine key not found in ${dataDir} (has the engine run at least once?)`);
    }
  }
  return { host, port, key };
}

/** One line per app the engine has seen. */
export function describeClients(a: ClientsAnswer): string[] {
  return a.clients.map((c) => {
    const state = c.buildId === a.current?.buildId ? "güncel" : c.outcomeBuildId === a.current?.buildId && c.outcome !== "updated" ? `KURAMADI (${c.outcome})` : "bekleniyor";
    return `  ${c.clientId}  ${c.buildId}  ${state}`;
  });
}

/** "done": every app seen runs the published build · "failed": one reported it could not · "waiting" otherwise. */
export function waitState(a: ClientsAnswer): "done" | "failed" | "waiting" {
  if (!a.current || a.clients.length === 0) return "waiting";
  const current = a.current.buildId;
  if (a.clients.some((c) => c.buildId !== current && c.outcomeBuildId === current && c.outcome !== undefined && c.outcome !== "updated")) return "failed";
  return a.clients.every((c) => c.buildId === current) ? "done" : "waiting";
}

export async function runCli(argv: string[], deps: DeployDeps): Promise<number> {
  try {
    // `--wait` alone means the default; node's parser wants a value, so the bare form is rewritten first.
    const args = argv.map((a) => (a === "--wait" ? `--wait=${DEFAULTS.waitSeconds}` : a));
    const { positionals, values } = parseArgs({
      args,
      allowPositionals: true,
      options: { config: { type: "string" }, label: { type: "string" }, "skip-build": { type: "boolean", default: false }, wait: { type: "string" }, "dry-run": { type: "boolean", default: false } },
    });
    if (positionals.length > 0) {
      deps.stderr(USAGE);
      return 64;
    }
    const waitSeconds = values.wait === undefined ? undefined : Number(values.wait);
    if (waitSeconds !== undefined && (!Number.isFinite(waitSeconds) || waitSeconds <= 0)) throw new DeployError("--wait needs a number of seconds");
    const configPath = resolveConfigPath(deps, values.config);
    try {
      JSON.parse(deps.readFile(configPath));
    } catch (e) {
      throw new DeployError(`cannot read engine config ${configPath}: ${(e as Error).message}`);
    }
    const signingDir = signingKeyDirOf(deps, configPath);
    const languageEnv = buildLanguageEnv(deps, configPath);
    const steps: { title: string; cmd: string; args: string[]; env?: Record<string, string> }[] = [
      { title: "0/3 yayıncı anahtarı", cmd: deps.nodePath, args: [join(ENGINE_DIR, "scripts", "publish-app.ts"), "keygen", "--config", configPath] },
      ...(values["skip-build"]
        ? []
        : [{ title: "1/3 uygulamayı derle", cmd: DEFAULTS.pnpm, args: ["--filter", DEFAULTS.appFilter, DEFAULTS.distScript], env: { [DEFAULTS.signingDirEnv]: signingDir, ...languageEnv } }]),
      { title: "2/3 derlemeyi yayınla", cmd: deps.nodePath, args: [join(ENGINE_DIR, "scripts", "publish-app.ts"), "--config", configPath] },
      {
        title: "3/3 motoru yeniden kur",
        cmd: deps.nodePath,
        args: [join(ENGINE_DIR, "scripts", "launchd.ts"), "install", "--config", configPath, ...(values.label !== undefined ? ["--label", values.label] : [])],
      },
    ];
    deps.stdout(`motor ayarı: ${configPath}\n`);
    for (const step of steps) {
      const envText = step.env ? `${Object.entries(step.env).map(([k, v]) => `${k}=${shown(v, [])}`).join(" ")} ` : "";
      deps.stdout(`\n== ${step.title}\n$ ${envText}${shown(step.cmd, step.args)}\n`);
      if (values["dry-run"]) continue;
      const status = deps.run(step.cmd, step.args, REPO_DIR, step.env);
      if (status !== 0) throw new DeployError(`"${step.title}" başarısız (çıkış ${status}); sonraki adımlar çalıştırılmadı`);
    }
    if (values["dry-run"]) {
      deps.stdout(`\n(dry run: hiçbir şey çalıştırılmadı${waitSeconds !== undefined ? `; ardından uygulamalar ${waitSeconds} sn beklenirdi` : ""})\n`);
      return 0;
    }
    if (waitSeconds === undefined) {
      deps.stdout("\nbitti. Açık Kokpit uygulamaları yeni derlemeyi kendileri indirir (durum: --wait ile ya da Ayarlar › Bağlantı).\n");
      return 0;
    }
    deps.stdout(`\n== uygulamalar bekleniyor (en çok ${waitSeconds} sn)\n`);
    const target = engineTarget(deps, configPath);
    const deadline = deps.now() + waitSeconds * 1000;
    let last = "";
    for (;;) {
      let answer: ClientsAnswer | undefined;
      try {
        answer = await deps.clients(target);
      } catch {
        // The engine is still coming up after the reinstall.
      }
      if (answer) {
        const lines = describeClients(answer).join("\n");
        if (lines !== last) {
          last = lines;
          deps.stdout(`yayında: ${answer.current?.buildId ?? "(yok)"}\n${lines || "  (henüz bağlanan uygulama yok)"}\n`);
        }
        const state = waitState(answer);
        if (state === "done") {
          deps.stdout("bitti: bağlanan bütün uygulamalar yeni derlemede.\n");
          return 0;
        }
        if (state === "failed") throw new DeployError("bir uygulama yeni derlemeyi kuramadı ve eskisine döndü (yukarıda); motor günlüğündeki \"app update report\" satırına bak");
      }
      if (deps.now() >= deadline) {
        deps.stderr("süre doldu: bazı uygulamalar henüz güncellenmedi (kullanılan pencere kesilmez; boşta kalınca ya da yeniden açılınca kurulur).\n");
        return 2;
      }
      await deps.sleep(DEFAULTS.waitPollMs);
    }
  } catch (e) {
    deps.stderr(`deploy-local: ${(e as Error).message}\n`);
    return e instanceof DeployError ? 1 : 70;
  }
}

function askClients(target: { host: string; port: number; key: string }): Promise<ClientsAnswer> {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(`ws://${target.host}:${target.port}`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("timeout"));
    }, DEFAULTS.requestTimeoutMs);
    const done = (fn: () => void): void => {
      clearTimeout(timer);
      ws.terminate();
      fn();
    };
    ws.on("error", (err) => done(() => reject(err)));
    ws.on("close", () => done(() => reject(new Error("closed"))));
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as { type: string; id?: number; ok?: boolean; result?: ClientsAnswer; error?: { message: string } };
      if (msg.type !== "res" || msg.id !== 1) return;
      done(() => (msg.ok && msg.result ? resolvePromise(msg.result) : reject(new Error(msg.error?.message ?? "failed"))));
    });
    // Mutual handshake: the key never crosses the wire, and nothing is asked before the engine proved itself.
    authenticate(ws, target.key, DEFAULTS.requestTimeoutMs).then(
      () => ws.send(JSON.stringify({ type: "req", id: 1, method: "app.update.clients", params: {} })),
      (err: unknown) => done(() => reject(err instanceof Error ? err : new Error(String(err)))),
    );
  });
}

export function realDeps(): DeployDeps {
  return {
    cwd: process.cwd(),
    homedir: homedir(),
    env: process.env,
    nodePath: process.execPath,
    run: (cmd, args, cwd, env) => {
      const r = spawnSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
      return r.error ? null : r.status;
    },
    readFile: (p) => readFileSync(p, "utf8"),
    clients: askClients,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: Date.now,
    stdout: (s) => void process.stdout.write(s),
    stderr: (s) => void process.stderr.write(s),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2), realDeps());
}
