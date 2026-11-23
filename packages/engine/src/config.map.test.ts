// İş C — Harita: the `map` key of engine.json (partial overrides of map.defaults.json).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";
import { FakeLogger } from "../test/fakes/server-fakes.ts";

let root: string;
let cfgPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kokpit-config-map-"));
  cfgPath = join(root, "engine.json");
  mkdirSync(join(root, "home"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const load = (user: Record<string, unknown>) => {
  writeFileSync(cfgPath, JSON.stringify({ dataDir: join(root, "data"), key: "k".repeat(43), ...user }));
  return loadConfig({ env: { KOKPIT_CONFIG: cfgPath, HOME: join(root, "home"), SHELL: "/bin/sh" }, logger: new FakeLogger() });
};

describe("config: map", () => {
  it("is empty when not given", async () => {
    expect((await load({})).map).toEqual({});
  });

  it("passes a partial override through", async () => {
    expect((await load({ map: { updateCommand: "echo x", maxDepth: 1 } })).map).toEqual({ updateCommand: "echo x", maxDepth: 1 });
  });

  it.each([
    ["unknown key", { nope: 1 }],
    ["traversing dir", { dirName: "../etc" }],
    ["not an object", "graphify-out"],
  ])("rejects %s", async (_n, map) => {
    await expect(load({ map })).rejects.toThrow(/map/);
  });
});
