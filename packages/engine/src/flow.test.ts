// İş W — Akış: listing and reading a project's Mermaid flow files.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineError } from "./contracts.ts";
import { createFlowService, FLOW_DEFAULTS_PATH, loadFlowConfig, type FlowConfig } from "./flow.ts";
import { loadToolDefaults } from "./tools.ts";

let root: string;
let proj: string;
let dir: string;
let outside: string;

const FILE_ARGS = { flowPromptFile: "'/motor/prompts/akis-ciz.md'" };
const CONFIG: FlowConfig = { ...loadFlowConfig({}, FILE_ARGS), maxFiles: 5, maxBytes: 64 };
const service = (cfg: FlowConfig = CONFIG) => createFlowService({ config: cfg });

function writeAt(path: string, content: string, mtimeSec = 1_700_000_000): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  utimesSync(path, mtimeSec, mtimeSec);
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof EngineError ? err.code : `not-engine: ${String(err)}`;
  }
  return undefined;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-flow-")));
  proj = join(root, "proje");
  dir = join(proj, "docs", "akis");
  outside = join(root, "dışarı");
  mkdirSync(dir, { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, "gizli.mmd"), "flowchart TD\n  SECRET-OUTSIDE");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("loadFlowConfig", () => {
  it("ships defaults: docs/akis and a claude command whose prompt file is expanded", () => {
    const c = loadFlowConfig({}, FILE_ARGS);
    expect(c.dir).toBe("docs/akis");
    expect(c.updateCommand).toContain("claude");
    expect(c.updateCommand).toContain("'/motor/prompts/akis-ciz.md'");
    expect(c.updateCommand).not.toContain("{{");
  });

  it("the prompt file is shipped with the engine (tools.defaults.json files) and asks for Mermaid in docs/akis", () => {
    const defaults = loadToolDefaults();
    const arg = defaults.fileArgs.flowPromptFile;
    expect(arg).toBeDefined();
    const path = arg!.slice(1, -1);
    const text = readFileSync(path, "utf8");
    expect(text).toMatch(/Mermaid/);
    expect(text).toContain("docs/akis");
    expect(text).toContain("%% title:");
    expect(loadFlowConfig({}, defaults.fileArgs).updateCommand).toContain(arg!);
  });

  it("refuses an unknown placeholder in the command", () => {
    expect(() => loadFlowConfig({ updateCommand: "claude {{nope}}" }, FILE_ARGS)).toThrow(/placeholder/);
  });

  it.each([
    ["traversing dir", { dir: "../etc" }],
    ["absolute dir", { dir: "/etc" }],
    ["dot segment", { dir: "docs/./akis" }],
    ["backslash", { dir: "docs\\akis" }],
    ["empty command", { updateCommand: " " }],
    ["unknown key", { nope: 1 }],
  ])("rejects %s", (_n, o) => {
    expect(() => loadFlowConfig(o as never, FILE_ARGS)).toThrow(/flow/);
  });

  it("reads the shipped defaults file", () => {
    expect(JSON.parse(readFileSync(FLOW_DEFAULTS_PATH, "utf8")).dir).toBe("docs/akis");
  });
});

describe("FlowService.list", () => {
  it("lists .mmd files newest first, with titles from the first-line comment", () => {
    writeAt(join(dir, "giris.mmd"), "%% title: Giriş akışı\nflowchart TD\n  A-->B", 1_700_000_100);
    writeAt(join(dir, "odeme.mmd"), "flowchart TD\n  A-->B", 1_700_000_200);
    const r = service().list(proj);
    expect(r.truncated).toBe(false);
    expect(r.flows.map((f) => f.id)).toEqual(["odeme.mmd", "giris.mmd"]);
    expect(r.flows[1]).toEqual({
      id: "giris.mmd",
      file: "docs/akis/giris.mmd",
      title: "Giriş akışı",
      modifiedAt: new Date(1_700_000_100_000).toISOString(),
    });
    expect(r.flows[0]!.title).toBeUndefined();
  });

  it("ignores non-.mmd files, folders, hidden files and symlinks", () => {
    writeAt(join(dir, "a.mmd"), "flowchart TD");
    writeAt(join(dir, "notlar.md"), "x");
    writeAt(join(dir, ".gizli.mmd"), "x");
    mkdirSync(join(dir, "klasor.mmd"));
    symlinkSync(join(outside, "gizli.mmd"), join(dir, "bag.mmd"));
    expect(service().list(proj).flows.map((f) => f.id)).toEqual(["a.mmd"]);
  });

  it("is empty when the folder is missing", () => {
    rmSync(join(proj, "docs"), { recursive: true });
    expect(service().list(proj)).toEqual({ flows: [], truncated: false });
  });

  it("refuses a flow folder that is (or passes through) a symlink", () => {
    rmSync(join(proj, "docs"), { recursive: true });
    mkdirSync(join(outside, "akis"));
    writeAt(join(outside, "akis", "x.mmd"), "flowchart TD");
    symlinkSync(outside, join(proj, "docs"));
    expect(service().list(proj)).toEqual({ flows: [], truncated: false });
    rmSync(join(proj, "docs"));
    mkdirSync(join(proj, "docs"));
    symlinkSync(join(outside, "akis"), join(proj, "docs", "akis"));
    expect(service().list(proj)).toEqual({ flows: [], truncated: false });
  });

  it("caps the list", () => {
    for (let i = 0; i < 8; i++) writeAt(join(dir, `f${i}.mmd`), "flowchart TD", 1_700_000_000 + i);
    const r = service().list(proj);
    expect(r.truncated).toBe(true);
    expect(r.flows.map((f) => f.id)).toEqual(["f7.mmd", "f6.mmd", "f5.mmd", "f4.mmd", "f3.mmd"]);
  });

  it("caps and cleans the title", () => {
    writeAt(join(dir, "a.mmd"), `%%   title:   ${"x".repeat(500)}\u0007\nflowchart TD`);
    const t = service({ ...CONFIG, titleMaxChars: 10 }).list(proj).flows[0]!.title;
    expect(t).toBe("x".repeat(10));
    writeAt(join(dir, "b.mmd"), "%% title:   \nflowchart TD");
    expect(service().list(proj).flows.find((f) => f.id === "b.mmd")!.title).toBeUndefined();
  });

  it("refuses a missing project folder", () => {
    expect(code(() => service().list(join(root, "yok")))).toBe("NOT_FOUND");
  });
});

describe("FlowService.read", () => {
  it("returns the text of a flow", () => {
    writeAt(join(dir, "a.mmd"), "flowchart TD\n  A-->B");
    expect(service().read(proj, "a.mmd")).toEqual({ text: "flowchart TD\n  A-->B" });
  });

  it.each(["../../../dışarı/gizli.mmd", "../x.mmd", "/etc/x.mmd", "a.md", ".gizli.mmd", "a/b.mmd", "a\0.mmd", ""])(
    "refuses id %j",
    (id) => {
      expect(code(() => service().read(proj, id))).toBe("INVALID");
    },
  );

  it("refuses a symlinked flow file even when the name is valid", () => {
    symlinkSync(join(outside, "gizli.mmd"), join(dir, "bag.mmd"));
    expect(code(() => service().read(proj, "bag.mmd"))).toBe("NOT_FOUND");
  });

  it("refuses through a symlinked flow folder", () => {
    rmSync(join(proj, "docs"), { recursive: true });
    mkdirSync(join(outside, "akis"));
    writeAt(join(outside, "akis", "x.mmd"), "flowchart TD");
    symlinkSync(outside, join(proj, "docs"));
    expect(code(() => service().read(proj, "x.mmd"))).toBe("NOT_FOUND");
  });

  it("refuses a missing file and a folder", () => {
    mkdirSync(join(dir, "klasor.mmd"));
    expect(code(() => service().read(proj, "yok.mmd"))).toBe("NOT_FOUND");
    expect(code(() => service().read(proj, "klasor.mmd"))).toBe("NOT_FOUND");
  });

  it("refuses a file over the size cap", () => {
    writeAt(join(dir, "buyuk.mmd"), "x".repeat(65));
    expect(code(() => service().read(proj, "buyuk.mmd"))).toBe("INVALID");
    writeAt(join(dir, "tam.mmd"), "x".repeat(64));
    expect(service().read(proj, "tam.mmd").text).toHaveLength(64);
  });
});
