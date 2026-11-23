// İş W — Akış: the `flow` key of engine.json (partial overrides of flow.defaults.json).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";
import { FakeLogger } from "../test/fakes/server-fakes.ts";

let root: string;
let cfgPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kokpit-config-flow-"));
  cfgPath = join(root, "engine.json");
  mkdirSync(join(root, "home"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const load = (user: Record<string, unknown>) => {
  writeFileSync(cfgPath, JSON.stringify({ dataDir: join(root, "data"), key: "k".repeat(43), ...user }));
  return loadConfig({ env: { KOKPIT_CONFIG: cfgPath, HOME: join(root, "home"), SHELL: "/bin/sh" }, logger: new FakeLogger() });
};

describe("config: flow (İş W)", () => {
  it("is empty when not given", async () => {
    expect((await load({})).flow).toEqual({});
  });

  it("passes a partial override through", async () => {
    expect((await load({ flow: { dir: "belgeler/akis", maxFiles: 3 } })).flow).toEqual({ dir: "belgeler/akis", maxFiles: 3 });
  });

  it.each([
    ["unknown key", { nope: 1 }],
    ["traversing dir", { dir: "../etc" }],
    ["absolute dir", { dir: "/etc" }],
    ["not an object", "docs/akis"],
  ])("rejects %s", async (_n, flow) => {
    await expect(load({ flow })).rejects.toThrow(/flow/);
  });
});
