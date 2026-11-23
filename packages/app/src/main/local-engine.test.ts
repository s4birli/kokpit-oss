// @vitest-environment node
// Yerel bağlantı: detection of an engine running on this Mac. Temp HOME only; never the real config or key.
import { createServer, type Server } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLocalEngineService,
  detectLocalEngine,
  LOCAL_ENGINE_DETECT_ENV,
  LocalEngineError,
  localEngineDefaults,
  parseLaunchdPlist,
  type LocalEngineDeps,
} from "./local-engine.ts";

const KEY = "k".repeat(20) + "-secret-test-key";
const FILE_KEY = "f".repeat(20) + "-file-test-key";

let home: string;
let dataDir: string;
let server: Server | undefined;
let healthStatus = 200;
let healthBody = JSON.stringify({ ok: true });

function startHealth(): Promise<number> {
  server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(healthStatus, { "content-type": "application/json" });
      res.end(healthBody);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server!.listen(0, "127.0.0.1", () => resolve((server!.address() as AddressInfo).port)));
}

function configPath(): string {
  return join(home, ".config", "kokpit", "engine.json");
}

function writeConfig(content: unknown): void {
  mkdirSync(join(home, ".config", "kokpit"), { recursive: true });
  writeFileSync(configPath(), typeof content === "string" ? content : JSON.stringify(content));
}

function writeKeyFile(key: string): void {
  writeFileSync(join(dataDir, "engine.key"), key + "\n", { mode: 0o600 });
}

function deps(over: Partial<LocalEngineDeps> = {}): LocalEngineDeps {
  return { env: { HOME: home }, log: vi.fn(), ...over };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kokpit-local-engine-"));
  dataDir = join(home, "data");
  mkdirSync(dataDir);
  healthStatus = 200;
  healthBody = JSON.stringify({ ok: true });
});

afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  rmSync(home, { recursive: true, force: true });
});

describe("detectLocalEngine", () => {
  it("finds the engine: port from the config file, key from <dataDir>/engine.key (trimmed)", async () => {
    const port = await startHealth();
    writeConfig({ dataDir, port, shell: "/bin/sh", projects: [] });
    writeKeyFile(FILE_KEY);
    await expect(detectLocalEngine(deps())).resolves.toEqual({ url: `ws://127.0.0.1:${port}`, port, key: FILE_KEY });
  });

  it("prefers `key` in the config file over engine.key", async () => {
    const port = await startHealth();
    writeConfig({ dataDir, port, key: KEY });
    writeKeyFile(FILE_KEY);
    expect((await detectLocalEngine(deps()))?.key).toBe(KEY);
  });

  it("honors the engine's env rules: KOKPIT_CONFIG, KOKPIT_PORT, KOKPIT_KEY, KOKPIT_DATA_DIR, XDG_CONFIG_HOME", async () => {
    const port = await startHealth();
    const other = join(home, "elsewhere.json");
    writeFileSync(other, JSON.stringify({ dataDir: "/nonexistent", port: 1 }));
    const env = { HOME: home, KOKPIT_CONFIG: other, KOKPIT_PORT: String(port), KOKPIT_KEY: KEY, KOKPIT_DATA_DIR: dataDir };
    expect(await detectLocalEngine(deps({ env }))).toEqual({ url: `ws://127.0.0.1:${port}`, port, key: KEY });

    const xdg = join(home, "xdg");
    mkdirSync(join(xdg, "kokpit"), { recursive: true });
    writeFileSync(join(xdg, "kokpit", "engine.json"), JSON.stringify({ dataDir, port }));
    writeKeyFile(FILE_KEY);
    expect((await detectLocalEngine(deps({ env: { HOME: home, XDG_CONFIG_HOME: xdg } })))?.port).toBe(port);
  });

  it("expands ~ in dataDir like the engine", async () => {
    const port = await startHealth();
    writeConfig({ dataDir: "~/data", port });
    writeKeyFile(FILE_KEY);
    expect((await detectLocalEngine(deps()))?.key).toBe(FILE_KEY);
  });

  it("uses the default port when the file has none", async () => {
    const port = await startHealth();
    writeConfig({ dataDir });
    writeKeyFile(FILE_KEY);
    const r = await detectLocalEngine(deps({ config: { ...localEngineDefaults, defaultPort: port } }));
    expect(r?.port).toBe(port);
  });

  it(`${LOCAL_ENGINE_DETECT_ENV}=0 turns detection off without reading anything`, async () => {
    const port = await startHealth();
    writeConfig({ dataDir, port, key: KEY });
    expect(await detectLocalEngine(deps({ env: { HOME: home, [LOCAL_ENGINE_DETECT_ENV]: "0" } }))).toBeNull();
    expect(await detectLocalEngine(deps({ env: { HOME: home, [LOCAL_ENGINE_DETECT_ENV]: "1" } }))).not.toBeNull();
  });

  it("null when the config file is missing", async () => {
    await startHealth();
    expect(await detectLocalEngine(deps())).toBeNull();
  });

  it("null when the config file is malformed JSON, the wrong shape or too large", async () => {
    const port = await startHealth();
    writeKeyFile(FILE_KEY);
    writeConfig("{not json");
    expect(await detectLocalEngine(deps())).toBeNull();
    writeConfig({ dataDir, port: "7420" });
    expect(await detectLocalEngine(deps())).toBeNull();
    writeConfig({ dataDir, port: 70000 });
    expect(await detectLocalEngine(deps())).toBeNull();
    writeConfig([1, 2]);
    expect(await detectLocalEngine(deps())).toBeNull();
    writeConfig({ dataDir, port, pad: "x".repeat(localEngineDefaults.maxConfigBytes) });
    expect(await detectLocalEngine(deps())).toBeNull();
  });

  it("ignores unrelated engine fields (only dataDir, port, key, listenLocalhost are read)", async () => {
    const port = await startHealth();
    writeConfig({ dataDir, port, key: KEY, projects: [{ name: "x", repoPath: "/x" }], browser: { anything: 1 } });
    expect((await detectLocalEngine(deps()))?.port).toBe(port);
  });

  it("null when listenLocalhost is false", async () => {
    const port = await startHealth();
    writeConfig({ dataDir, port, key: KEY, listenLocalhost: false });
    expect(await detectLocalEngine(deps())).toBeNull();
  });

  it("null when the port is 0 (random) — nothing to connect to", async () => {
    await startHealth();
    writeConfig({ dataDir, port: 0, key: KEY });
    expect(await detectLocalEngine(deps())).toBeNull();
  });

  it("null when no key can be found, the key file is too short, too large or unreadable", async () => {
    const port = await startHealth();
    writeConfig({ dataDir, port });
    expect(await detectLocalEngine(deps())).toBeNull();
    writeKeyFile("short");
    expect(await detectLocalEngine(deps())).toBeNull();
    writeKeyFile("x".repeat(localEngineDefaults.maxKeyBytes + 1));
    expect(await detectLocalEngine(deps())).toBeNull();
    writeKeyFile(FILE_KEY);
    chmodSync(join(dataDir, "engine.key"), 0o000);
    expect(await detectLocalEngine(deps())).toBeNull();
    chmodSync(join(dataDir, "engine.key"), 0o600);
  });

  it("null when dataDir is missing or relative", async () => {
    const port = await startHealth();
    writeConfig({ port });
    expect(await detectLocalEngine(deps())).toBeNull();
    writeConfig({ port, dataDir: "relative/data" });
    expect(await detectLocalEngine(deps())).toBeNull();
  });

  it("null when /health is down, not 200, or not {ok:true}", async () => {
    const port = await startHealth();
    writeConfig({ dataDir, port, key: KEY });
    healthStatus = 500;
    expect(await detectLocalEngine(deps())).toBeNull();
    healthStatus = 200;
    healthBody = "nope";
    expect(await detectLocalEngine(deps())).toBeNull();
    healthBody = JSON.stringify({ ok: false });
    expect(await detectLocalEngine(deps())).toBeNull();
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    expect(await detectLocalEngine(deps())).toBeNull();
  });

  it("null when /health hangs past the timeout", async () => {
    server = createServer(() => {
      /* never answers */
    });
    const port = await new Promise<number>((r) => server!.listen(0, "127.0.0.1", () => r((server!.address() as AddressInfo).port)));
    writeConfig({ dataDir, port, key: KEY });
    const started = Date.now();
    const r = await detectLocalEngine(deps({ config: { ...localEngineDefaults, healthTimeoutMs: 200 } }));
    expect(r).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
    server.closeAllConnections();
  });

  it("never logs the key, whatever happens", async () => {
    const log = vi.fn();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    const port = await startHealth();
    writeConfig({ dataDir, port, key: KEY });
    await detectLocalEngine(deps({ log }));
    healthStatus = 500;
    await detectLocalEngine(deps({ log }));
    writeConfig({ dataDir, port, key: KEY, listenLocalhost: false });
    await detectLocalEngine(deps({ log }));
    writeConfig({ dataDir, port, key: 42 });
    await detectLocalEngine(deps({ log }));
    const logged = JSON.stringify([log.mock.calls, ...spies.map((s) => s.mock.calls)]);
    expect(logged).not.toContain(KEY);
    expect(log).toHaveBeenCalled();
    spies.forEach((s) => s.mockRestore());
  });
});

describe("launchd plist (installed engine)", () => {
  const plist = (env: Record<string, string>, entry: string) =>
    [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<plist version="1.0">`,
      `<dict>`,
      `\t<key>Label</key>`,
      `\t<string>dev.kokpit.engine</string>`,
      `\t<key>ProgramArguments</key>`,
      `\t<array>`,
      `\t\t<string>/opt/node</string>`,
      `\t\t<string>${entry}</string>`,
      `\t</array>`,
      `\t<key>EnvironmentVariables</key>`,
      `\t<dict>`,
      ...Object.entries(env).flatMap(([k, v]) => [`\t\t<key>${k}</key>`, `\t\t<string>${v}</string>`]),
      `\t</dict>`,
      `</dict>`,
      `</plist>`,
    ].join("\n");

  it("parses the environment and the engine dir (xml-unescaped)", () => {
    const p = parseLaunchdPlist(plist({ HOME: "/Users/a", KOKPIT_CONFIG: "/x/a&amp;b.json" }, "/eng/pkg/src/main.ts"));
    expect(p).toEqual({ env: { HOME: "/Users/a", KOKPIT_CONFIG: "/x/a&b.json" }, engineDir: "/eng/pkg" });
    expect(parseLaunchdPlist("garbage")).toEqual({ env: {}, engineDir: null });
  });

  it("uses the plist's KOKPIT_CONFIG and the installed engine's config.defaults.json port", async () => {
    const port = await startHealth();
    const engineDir = join(home, "engine");
    mkdirSync(join(engineDir, "src"), { recursive: true });
    writeFileSync(join(engineDir, "config.defaults.json"), JSON.stringify({ port, listenLocalhost: true, shellArgs: [] }));
    const cfg = join(home, "custom", "engine.json");
    mkdirSync(join(home, "custom"));
    writeFileSync(cfg, JSON.stringify({ dataDir }));
    writeKeyFile(FILE_KEY);
    const agents = join(home, localEngineDefaults.launchAgentsDir);
    mkdirSync(agents, { recursive: true });
    writeFileSync(
      join(agents, `${localEngineDefaults.launchdLabel}.plist`),
      plist({ HOME: home, KOKPIT_CONFIG: cfg }, join(engineDir, "src", "main.ts")),
    );
    expect(await detectLocalEngine(deps())).toEqual({ url: `ws://127.0.0.1:${port}`, port, key: FILE_KEY });
  });

  it("installed engine defaults with listenLocalhost false → null", async () => {
    const port = await startHealth();
    const engineDir = join(home, "engine");
    mkdirSync(join(engineDir, "src"), { recursive: true });
    writeFileSync(join(engineDir, "config.defaults.json"), JSON.stringify({ port, listenLocalhost: false }));
    writeConfig({ dataDir, key: KEY });
    const agents = join(home, localEngineDefaults.launchAgentsDir);
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, `${localEngineDefaults.launchdLabel}.plist`), plist({ HOME: home }, join(engineDir, "src", "main.ts")));
    expect(await detectLocalEngine(deps())).toBeNull();
  });
});

describe("createLocalEngineService", () => {
  const found = { url: "ws://127.0.0.1:7", port: 7, key: KEY };

  it("info() exposes only the address, never the key", async () => {
    const svc = createLocalEngineService({ detect: async () => found, save: vi.fn() });
    const info = await svc.info();
    expect(info).toEqual({ address: "127.0.0.1:7" });
    expect(JSON.stringify(info)).not.toContain(KEY);
    const none = createLocalEngineService({ detect: async () => null, save: vi.fn() });
    expect(await none.info()).toBeNull();
  });

  it("connect() re-detects and saves url + key in main; returns nothing", async () => {
    const save = vi.fn(async () => {});
    const svc = createLocalEngineService({ detect: async () => found, save });
    await expect(svc.connect()).resolves.toBeUndefined();
    expect(save).toHaveBeenCalledWith({ url: found.url, key: KEY });
  });

  it("connect() throws a user-facing LocalEngineError when the engine is gone", async () => {
    const save = vi.fn();
    const svc = createLocalEngineService({ detect: async () => null, save });
    await expect(svc.connect()).rejects.toBeInstanceOf(LocalEngineError);
    expect(save).not.toHaveBeenCalled();
  });
});
