// İş B: LaunchSpec.env reaches the terminal process (KOKPIT_CDP_URL), without overriding Kokpit's own vars.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as nodePty from "node-pty";
import { afterEach, beforeEach, expect, it } from "vitest";
import { MemoryStore } from "../test/fakes/memory-store.ts";
import type { EngineConfig, Logger } from "./contracts.ts";
import { createPtyManager } from "./pty.ts";

let root: string;
const spawned: nodePty.IPtyForkOptions[] = [];
const fakeSpawn = ((_file: string, _args: string[], opts: nodePty.IPtyForkOptions) => {
  spawned.push(opts);
  return { pid: 1, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), write() {}, resize() {}, kill() {} };
}) as unknown as typeof nodePty.spawn;
const logger: Logger = { info() {}, warn() {}, error() {} };

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-pty-browser-")));
  spawned.length = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function manager() {
  const config = { dataDir: root, bufferBytes: 1024, shell: "/bin/sh", shellArgs: [] } as unknown as EngineConfig;
  const paths = { stateFile: join(root, "s.json"), buffersDir: root, worktreesDir: root, reposDir: root };
  return createPtyManager({ config, paths, store: new MemoryStore(), logger, flushIntervalMs: 1000, killGraceMs: 10, spawn: fakeSpawn, newId: () => "t1" });
}

it("adds LaunchSpec.env to the terminal's environment", () => {
  manager().open(
    { projectId: "p" },
    { file: "/bin/sh", args: [], cwd: root, title: "sh", env: { KOKPIT_CDP_URL: "http://127.0.0.1:39222" } },
    { cols: 80, rows: 24 },
  );
  expect(spawned[0]?.env?.KOKPIT_CDP_URL).toBe("http://127.0.0.1:39222");
  expect(spawned[0]?.env?.KOKPIT_PROJECT_ID).toBe("p");
});

it("LaunchSpec.env cannot override Kokpit's identity variables", () => {
  manager().open(
    { projectId: "p" },
    { file: "/bin/sh", args: [], cwd: root, title: "sh", env: { KOKPIT_PROJECT_ID: "other", TERM: "dumb" } },
    { cols: 80, rows: 24 },
  );
  expect(spawned[0]?.env?.KOKPIT_PROJECT_ID).toBe("p");
  expect(spawned[0]?.env?.TERM).toBe("xterm-256color");
});
