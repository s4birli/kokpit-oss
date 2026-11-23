// İş F — Dosyalar: the `files` key of engine.json (partial overrides of files.defaults.json).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";
import { FakeLogger } from "../test/fakes/server-fakes.ts";

let root: string;
let cfgPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kokpit-config-files-"));
  cfgPath = join(root, "engine.json");
  mkdirSync(join(root, "home"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const load = (user: Record<string, unknown>) => {
  writeFileSync(cfgPath, JSON.stringify({ dataDir: join(root, "data"), key: "k".repeat(43), ...user }));
  return loadConfig({ env: { KOKPIT_CONFIG: cfgPath, HOME: join(root, "home"), SHELL: "/bin/sh" }, logger: new FakeLogger() });
};

describe("config: files", () => {
  it("is empty when not given", async () => {
    expect((await load({})).files).toEqual({});
  });

  it("passes a partial override through", async () => {
    expect((await load({ files: { hiddenNames: [".git", "node_modules"], maxEntries: 50 } })).files).toEqual({
      hiddenNames: [".git", "node_modules"],
      maxEntries: 50,
    });
  });

  it("passes a partial media override through", async () => {
    expect((await load({ files: { media: { tokenTtlMs: 5000, maxStreams: 2 } } })).files).toEqual({ media: { tokenTtlMs: 5000, maxStreams: 2 } });
  });

  it.each([
    ["unknown key", { nope: 1 }],
    ["unknown media key", { media: { nope: 1 } }],
    ["a media type served as html", { media: { types: { htm: { kind: "image", mime: "text/html", signatures: [[{ at: 0, text: "<" }]] } } } }],
    ["a short media token", { media: { tokenBytes: 4 } }],
    ["traversing hidden name", { hiddenNames: ["../etc"] }],
    ["not an object", ".git"],
  ])("rejects %s", async (_n, files) => {
    await expect(load({ files })).rejects.toThrow(/files/);
  });
});
