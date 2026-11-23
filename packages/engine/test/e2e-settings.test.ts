// End-to-end for the global default tool ("Ayarlarda varsayılan araç") against the real engine:
// seeded default, fallback when the project has none, plain shell on null, restart, delete guard.
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadToolDefaults } from "../src/tools.ts";
import { Client, startEngine, stopEngine, type EngineProc } from "./harness.ts";

const KEY = randomBytes(32).toString("base64url");
const DIMS = { cols: 100, rows: 30 };
const MARKER_CMD = "echo GLOBAL_DEFAULT_$((6*7))";
const MARKER_OUT = /GLOBAL_DEFAULT_42/;
const SHELL_PROBE = "echo SHELL_$((3*5))";
const SHELL_OUT = /SHELL_15/;

let root: string;
let home: string;
let dataDir: string;
let localDir: string;
let configPath: string;
let engine: EngineProc | undefined;

type Settings = { defaultToolId?: string };
type Term = { id: string; toolId?: string };

const env = () => ({ KOKPIT_CONFIG: configPath, KOKPIT_KEY: KEY, HOME: home });
const connect = () => Client.connect(engine!.port, KEY);
const defaults = loadToolDefaults();

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-e2e-settings-")));
  home = join(root, "home");
  dataDir = join(root, "data");
  localDir = join(root, "proje");
  mkdirSync(home, { recursive: true });
  mkdirSync(localDir);
  configPath = join(root, "engine.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      dataDir,
      port: 0,
      shell: "/bin/sh",
      shellArgs: [],
      listenTailscale: false,
      flushIntervalMs: 100,
      killGraceMs: 200,
    }),
  );
  engine = await startEngine(env());
}, 30000);

afterAll(async () => {
  await stopEngine(engine);
  rmSync(root, { recursive: true, force: true });
});

describe("genel varsayılan araç end-to-end", () => {
  let projectId: string;
  let markerId: string;

  it("a fresh engine defaults to the tool from tools.defaults.json (plain claude) and ships claude-agents-skip", async () => {
    const c = await connect();
    const { settings } = await c.req<{ settings: Settings }>("settings.get", {});
    expect(settings).toEqual({ defaultToolId: defaults.defaultToolId });
    expect(settings.defaultToolId).toBe("claude");
    const { tools } = await c.req<{ tools: { id: string; command: string }[] }>("tools.list", {});
    expect(tools.find((t) => t.id === "claude-agents-skip")?.command).toBe("claude agents --dangerously-skip-permissions");
    await c.close();
  });

  it("a project without a default tool starts the global default", async () => {
    const c = await connect();
    ({ tool: { id: markerId } } = await c.req<{ tool: { id: string } }>("tools.create", { name: "İşaret", command: MARKER_CMD }));
    ({ project: { id: projectId } } = await c.req<{ project: { id: string } }>("projects.create", {
      name: "Varsayılansız",
      location: { kind: "local", path: localDir },
    }));
    const changed = c.waitFor((f) => f.type === "event" && f.name === "settings.changed");
    const { settings } = await c.req<{ settings: Settings }>("settings.update", { defaultToolId: markerId });
    expect(settings).toEqual({ defaultToolId: markerId });
    await changed;
    const { terminal } = await c.req<{ terminal: Term }>("terminal.open", { projectId, ...DIMS });
    expect(terminal.toolId).toBe(markerId);
    await c.waitForOutput(terminal.id, MARKER_OUT);
    // "Yalnız kabuk" in the picker: toolId null skips the global default.
    const { terminal: shell } = await c.req<{ terminal: Term }>("terminal.open", { projectId, ...DIMS, toolId: null });
    expect(shell.toolId).toBeUndefined();
    c.input(shell.id, `${SHELL_PROBE}\r`);
    await c.waitForOutput(shell.id, SHELL_OUT);
    expect(c.output(shell.id)).not.toMatch(MARKER_OUT);
    await c.close();
  });

  it("refuses to delete the global default tool", async () => {
    const c = await connect();
    await expect(c.req("tools.delete", { toolId: markerId })).rejects.toMatchObject({
      code: "INVALID",
      message: expect.stringMatching(/varsayılan/),
    });
    await expect(c.req("settings.update", { defaultToolId: "olmayan-arac" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await c.close();
  });

  it("keeps the global default across a restart", async () => {
    await stopEngine(engine);
    engine = await startEngine(env());
    const c = await connect();
    expect((await c.req<{ settings: Settings }>("settings.get", {})).settings).toEqual({ defaultToolId: markerId });
    await c.close();
  }, 30000);

  it("null = plain shell, and that choice also survives a restart (the seed does not come back)", async () => {
    let c = await connect();
    expect((await c.req<{ settings: Settings }>("settings.update", { defaultToolId: null })).settings).toEqual({});
    await c.close();
    await stopEngine(engine);
    engine = await startEngine(env());
    c = await connect();
    expect((await c.req<{ settings: Settings }>("settings.get", {})).settings).toEqual({});
    const { terminal } = await c.req<{ terminal: Term }>("terminal.open", { projectId, ...DIMS });
    expect(terminal.toolId).toBeUndefined();
    c.input(terminal.id, `${SHELL_PROBE}\r`);
    await c.waitForOutput(terminal.id, SHELL_OUT);
    expect(c.output(terminal.id)).not.toMatch(MARKER_OUT);
    // İş H: settings also hold the seeded Claude accounts.
    expect(JSON.parse(readFileSync(join(dataDir, "state.json"), "utf8")).settings).toMatchObject({ defaultToolId: null });
    // Not the default any more → deletable.
    await c.req("tools.delete", { toolId: markerId });
    await c.close();
  }, 30000);
});
