// İş C (Adım 8) — Claude envanteri: frontmatter parsing, discovery (project, user, plugin), path safety and caps.
// Every fixture lives in a temp dir: a fake HOME with a fake `.claude`, never the real one.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Project } from "@kokpit/shared";
import {
  ClaudeInventoryConfigOverrideSchema,
  createClaudeInventory,
  defaultConfigDirFor,
  loadClaudeInventoryConfig,
  parseFrontmatter,
  type ClaudeInventoryConfig,
} from "./claude-inventory.ts";
import { EngineError } from "./contracts.ts";
import { FILES_MAX_READ_BYTES } from "./files.ts";

const SECRET = "KOKPIT-CLAUDE-INVENTORY-SECRET-9d1f";
const CAPS = { maxNameChars: 40, maxDescriptionChars: 80 };

let base: string;
let home: string;
let configDir: string;
let repo: string;
let outside: string;

const project = (path: string): Project => ({ id: "p1", name: "P", location: { kind: "local", path } });
const sshProject: Project = { id: "s1", name: "S", location: { kind: "ssh", hostId: "h1", path: "/srv/x" } };

function put(path: string, text: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const md = (name: string | undefined, description: string, body = "gövde\n") =>
  `---\n${name !== undefined ? `name: ${name}\n` : ""}description: ${description}\n---\n${body}`;

function config(over: Partial<ClaudeInventoryConfig> = {}): ClaudeInventoryConfig {
  return { ...loadClaudeInventoryConfig({}), ...over };
}

function service(over: Partial<ClaudeInventoryConfig> = {}, extra: { configDirFor?: (p: Project) => string } = {}) {
  return createClaudeInventory({
    config: config(over),
    homeDir: home,
    configDirFor: extra.configDirFor ?? defaultConfigDirFor(home, config().configDirName),
  });
}

const target = (root: string | null, p: Project = project(repo)) => ({ project: p, projectRoot: root });

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-claude-inv-")));
  home = join(base, "home");
  configDir = join(home, ".claude");
  repo = join(base, "depo");
  outside = join(base, "dışarı");
  put(join(outside, "secret.md"), SECRET);
  put(join(outside, "secret.txt"), SECRET);
  put(join(outside, "skills", "kacak", "SKILL.md"), md("kacak", SECRET));

  // Project level.
  put(join(repo, "CLAUDE.md"), "# proje\n");
  put(join(repo, ".claude", "skills", "derle", "SKILL.md"), md("derle", "Projeyi derler"));
  put(join(repo, ".claude", "skills", "adsiz", "SKILL.md"), md(undefined, "Adı klasörden gelir"));
  put(join(repo, ".claude", "skills", "bos", "README.md"), "SKILL.md yok\n");
  put(join(repo, ".claude", "agents", "inceleyici.md"), md("inceleyici", "Kodu inceler"));
  put(join(repo, ".claude", "agents", "notlar.txt"), SECRET);
  put(join(repo, ".claude", "commands", "yayinla.md"), "---\ndescription: Sürüm yayınlar\n---\nadımlar\n");
  put(join(repo, ".claude", "commands", "git", "temizle.md"), "Ön bilgi yok, düz metin\n");
  put(join(repo, ".claude", "settings.json"), `{"secret":"${SECRET}"}`);
  // Escapes: links out of the project, a link whose target is not markdown.
  symlinkSync(join(outside, "secret.md"), join(repo, ".claude", "agents", "kacis.md"));
  symlinkSync(join(outside, "skills", "kacak"), join(repo, ".claude", "skills", "kacak"));
  symlinkSync(join(repo, ".claude", "settings.json"), join(repo, ".claude", "commands", "ayar.md"));
  // A link inside the project is fine.
  symlinkSync(join(repo, ".claude", "agents", "inceleyici.md"), join(repo, ".claude", "agents", "takma.md"));
  // A FIFO named like markdown must never block or be read.
  execFileSync("mkfifo", [join(repo, ".claude", "commands", "boru.md")]);

  // User level.
  put(join(configDir, "CLAUDE.md"), "# kullanıcı\n");
  put(join(configDir, "skills", "kisisel", "SKILL.md"), md("kisisel", "Kullanıcı skill'i"));
  put(join(configDir, "agents", "yardimci.md"), md("yardimci", '"tırnaklı: açıklama"'));
  put(join(configDir, "commands", "selam.md"), md(undefined, "Selam verir"));
  // Credentials and other files next to them are never read.
  put(join(configDir, ".credentials.json"), SECRET);
  put(join(configDir, "settings.json"), SECRET);

  // Plugins: a manifest-named plugin, one without a manifest, a deep one beyond the depth cap, and a duplicate.
  put(join(configDir, "plugins", "cache", "pazar", "guc", "1.0.0", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "superguc" }));
  put(join(configDir, "plugins", "cache", "pazar", "guc", "1.0.0", "skills", "tdd", "SKILL.md"), md("test-driven", "Önce test"));
  put(join(configDir, "plugins", "yerel", "skills", "harita", "SKILL.md"), md(undefined, "Harita çizer"));
  put(join(configDir, "plugins", "yerel", "skills", "harita", "notes.txt"), SECRET);
  put(join(configDir, "plugins", "a", "b", "c", "d", "e", "f", "g", "skills", "derin", "SKILL.md"), md("derin", "Çok derin"));
  put(join(configDir, "plugins", "kopya", "yerel", "skills", "harita", "SKILL.md"), md(undefined, "İkinci kopya"));
  put(join(configDir, "plugins", "node_modules", "x", "skills", "nm", "SKILL.md"), md("nm", "yok sayılır"));
  symlinkSync(outside, join(configDir, "plugins", "dis-baglanti"));
  // A cycle must not loop.
  symlinkSync(join(configDir, "plugins"), join(configDir, "plugins", "dongu"));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("parseFrontmatter", () => {
  it("reads name and description", () => {
    expect(parseFrontmatter(md("ad", "açıklama"), CAPS)).toEqual({ name: "ad", description: "açıklama" });
  });

  it("handles CRLF, BOM, quotes and comments", () => {
    const text = "﻿---\r\nname: 'tek ''tırnak'''\r\ndescription: \"çift \\\"tırnak\\\" ve\\t satır\" # yorum\r\n---\r\n";
    expect(parseFrontmatter(text, CAPS)).toEqual({ name: "tek 'tırnak'", description: 'çift "tırnak" ve satır' });
    expect(parseFrontmatter("---\ndescription: düz # yorum\n---\n", CAPS)).toEqual({ description: "düz" });
  });

  it("handles block scalars and plain continuation lines", () => {
    expect(parseFrontmatter("---\ndescription: >\n  bir\n  iki\nname: x\n---\n", CAPS)).toEqual({ name: "x", description: "bir iki" });
    expect(parseFrontmatter("---\ndescription: |\n  bir\n  iki\n---\n", CAPS)).toEqual({ description: "bir\niki" });
    expect(parseFrontmatter("---\ndescription: bir\n  iki\n---\n", CAPS)).toEqual({ description: "bir iki" });
  });

  it("ignores everything but top-level string name/description", () => {
    const text = "---\nmetadata:\n  name: iç\ndescription: [liste]\nname: !!python/object:os.system x\ntools: Read\n---\n";
    expect(parseFrontmatter(text, CAPS)).toEqual({});
  });

  it.each([
    ["no frontmatter", "# başlık\nname: x\n"],
    ["unterminated", "---\nname: x\ndescription: y\n"],
    ["empty", ""],
    ["just a fence", "---"],
    ["binary junk", "---\n\u0000\u0001name: x\n---\n"],
  ])("malformed (%s) yields nothing", (_n, text) => {
    const r = parseFrontmatter(text, CAPS);
    expect(r.name).toBeUndefined();
  });

  it("caps lengths and strips control characters", () => {
    const r = parseFrontmatter(`---\nname: ${"n".repeat(500)}\ndescription: a\u0007b ${"d".repeat(5000)}\n---\n`, CAPS);
    expect(r.name!.length).toBeLessThanOrEqual(CAPS.maxNameChars);
    expect(r.description!.length).toBeLessThanOrEqual(CAPS.maxDescriptionChars);
    expect(r.description!.startsWith("ab ")).toBe(true);
  });

  it("monkey: random input never throws and stays within caps", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const alphabet = ["---", "\n", ":", " ", "name", "description", "'", '"', "|", ">", "#", "\\", "ş", "\r", "\t", "-", "[", "{", "!!"];
    for (let i = 0; i < 2000; i++) {
      let s = rnd() < 0.7 ? "---\n" : "";
      const n = Math.floor(rnd() * 60);
      for (let j = 0; j < n; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      const r = parseFrontmatter(s, CAPS);
      if (r.name !== undefined) expect(r.name.length).toBeLessThanOrEqual(CAPS.maxNameChars);
      if (r.description !== undefined) expect(r.description.length).toBeLessThanOrEqual(CAPS.maxDescriptionChars);
    }
  });
});

describe("config", () => {
  it("loads defaults and refuses unknown or out-of-range overrides", () => {
    const c = loadClaudeInventoryConfig({});
    expect(c.configDirName).toBe(".claude");
    expect(c.maxReadBytes).toBeLessThanOrEqual(FILES_MAX_READ_BYTES);
    expect(() => loadClaudeInventoryConfig({ maxReadBytes: FILES_MAX_READ_BYTES + 1 })).toThrow(/invalid claudeInventory config/);
    expect(ClaudeInventoryConfigOverrideSchema.safeParse({ nope: 1 }).success).toBe(false);
    expect(ClaudeInventoryConfigOverrideSchema.safeParse({ configDirName: "../x" }).success).toBe(false);
  });

  it("defaultConfigDirFor is <HOME>/<configDirName> for every project", () => {
    expect(defaultConfigDirFor("/h", ".claude")(project("/x"))).toBe("/h/.claude");
  });
});

describe("inventory", () => {
  const byName = <T extends { name: string }>(items: T[], name: string) => items.find((i) => i.name === name);

  it("lists project skills/agents/commands with frontmatter and display paths", () => {
    const r = service().inventory(target(repo));
    const derle = byName(r.items, "derle")!;
    expect(derle).toEqual({
      kind: "skill",
      name: "derle",
      description: "Projeyi derler",
      source: "project",
      path: ".claude/skills/derle/SKILL.md",
      id: "project:skills/derle/SKILL.md",
    });
    expect(byName(r.items, "adsiz")).toMatchObject({ kind: "skill", description: "Adı klasörden gelir" });
    expect(byName(r.items, "inceleyici")).toMatchObject({ kind: "agent", source: "project" });
    expect(byName(r.items, "takma")).toBeUndefined(); // frontmatter name wins: the link reads as "inceleyici"
    expect(r.items.filter((i) => i.name === "inceleyici")).toHaveLength(2);
    expect(byName(r.items, "yayinla")).toMatchObject({ kind: "command", description: "Sürüm yayınlar" });
    expect(byName(r.items, "git:temizle")).toMatchObject({ kind: "command", id: "project:commands/git/temizle.md" });
    expect(byName(r.items, "git:temizle")!.description).toBeUndefined();
    expect(r.claudeMd).toEqual({ project: true, user: true });
    expect(r.note).toBeUndefined();
  });

  it("lists user items and plugin skills (manifest name, dedup, depth cap, ignored dirs)", () => {
    const r = service().inventory(target(repo));
    expect(byName(r.items, "kisisel")).toMatchObject({ source: "user", path: "~/.claude/skills/kisisel/SKILL.md", id: "user:skills/kisisel/SKILL.md" });
    expect(byName(r.items, "yardimci")).toMatchObject({ kind: "agent", description: "tırnaklı: açıklama" });
    expect(byName(r.items, "selam")).toMatchObject({ kind: "command", source: "user" });
    expect(byName(r.items, "superguc:test-driven")).toMatchObject({
      kind: "skill",
      source: "plugin",
      id: "plugin:cache/pazar/guc/1.0.0/skills/tdd/SKILL.md",
      path: "~/.claude/plugins/cache/pazar/guc/1.0.0/skills/tdd/SKILL.md",
    });
    const harita = r.items.filter((i) => i.name === "yerel:harita");
    expect(harita).toHaveLength(1);
    expect(harita[0]!.description).toBe("Harita çizer"); // shallower copy wins
    expect(byName(r.items, "g:derin")).toBeUndefined(); // beyond pluginMaxDepth
    expect(r.items.some((i) => i.name.includes("nm"))).toBe(false);
  });

  it("never lists anything outside its root, nor non-markdown, nor a FIFO", () => {
    const r = service().inventory(target(repo));
    const text = JSON.stringify(r);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("kacis");
    expect(text).not.toContain("kacak");
    expect(text).not.toContain("ayar");
    expect(text).not.toContain("boru");
    expect(text).not.toContain("notlar");
    expect(text).not.toContain("credentials");
  });

  it("sorts by kind, then source, then name", () => {
    const r = service().inventory(target(repo));
    const kinds = r.items.map((i) => i.kind);
    expect(kinds).toEqual([...kinds].sort((a, b) => ["skill", "agent", "command"].indexOf(a) - ["skill", "agent", "command"].indexOf(b)));
    const skills = r.items.filter((i) => i.kind === "skill").map((i) => i.source);
    expect(skills.indexOf("user")).toBeGreaterThan(skills.lastIndexOf("project"));
  });

  it("without a project folder lists only the user/plugin part, with the note", () => {
    const r = service().inventory({ project: sshProject, projectRoot: null, note: "uzak" });
    expect(r.items.some((i) => i.source === "project")).toBe(false);
    expect(r.items.some((i) => i.source === "user")).toBe(true);
    expect(r.note).toBe("uzak");
    expect(r.claudeMd).toEqual({ user: true });
  });

  it("uses configDirFor(project); a missing config dir is just empty", () => {
    const seen: string[] = [];
    const svc = service({}, { configDirFor: (p) => (seen.push(p.id), join(base, "yok")) });
    const r = svc.inventory(target(repo));
    expect(seen).toEqual(["p1"]);
    expect(r.items.every((i) => i.source === "project")).toBe(true);
    expect(r.claudeMd).toEqual({ project: true, user: false });
  });

  it("caps the number of items and the scan", () => {
    const r = service({ maxItems: 3 }).inventory(target(repo));
    expect(r.items).toHaveLength(3);
    expect(r.truncated).toBe(true);
    const s = service({ maxScanEntries: 5 }).inventory(target(repo));
    expect(s.truncated).toBe(true);
  });

  it("reads only the frontmatter head of a huge file", () => {
    const big = join(base, "buyuk");
    put(join(big, ".claude", "agents", "dev.md"), `---\nname: dev\ndescription: ${"x".repeat(100)}\n---\n${"y".repeat(5_000_000)}`);
    put(join(big, ".claude", "agents", "kesik.md"), `---\nname: kesik\ndescription: ${"x".repeat(100_000)}\n---\n`);
    const r = service({ maxFrontmatterBytes: 4096 }).inventory(target(big, project(big)));
    expect(byName(r.items, "dev")).toBeDefined();
    // The closing fence is past the cap: no frontmatter, name from the file.
    expect(byName(r.items, "kesik")).toMatchObject({ kind: "agent" });
    expect(byName(r.items, "kesik")!.description).toBeUndefined();
  });
});

describe("read", () => {
  const read = (id: string, over: Partial<ClaudeInventoryConfig> = {}, root: string | null = repo) =>
    service(over).read(target(root), id);
  const code = (fn: () => unknown): string => {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      return (err as EngineError).code;
    }
    return "OK";
  };

  it("previews listed items of every source", () => {
    expect(read("project:skills/derle/SKILL.md").text).toContain("Projeyi derler");
    expect(read("user:agents/yardimci.md").text).toContain("yardimci");
    expect(read("plugin:yerel/skills/harita/SKILL.md").text).toContain("Harita çizer");
    const plain = "Ön bilgi yok, düz metin\n";
    expect(read("project:commands/git/temizle.md")).toEqual({ text: plain, size: Buffer.byteLength(plain), truncated: false });
  });

  it("caps the preview", () => {
    const r = read("project:skills/derle/SKILL.md", { maxReadBytes: 8 });
    expect(r).toMatchObject({ text: "---\nname", truncated: true });
  });

  it.each([
    "project:../CLAUDE.md",
    "user:../../dışarı/secret.md",
    "user:/etc/passwd",
    "user:skills/../../CLAUDE.md",
    "user:settings.json",
    "user:.credentials.json",
    "user:agents/../.credentials.json",
    "user:CLAUDE.md",
    "project:agents/notlar.txt",
    "project:settings.json",
    "plugin:yerel/skills/harita/notes.txt",
    "plugin:cache/pazar/guc/1.0.0/.claude-plugin/plugin.json",
    "project:skills/derle/../../agents/inceleyici.md",
    "project:skills\\derle\\SKILL.md",
    "project:skills/derle/SKILL.md\u0000",
    "nope:agents/a.md",
    "agents/a.md",
    "user:",
    "user:skills/kisisel/README.md",
    "user:agents/x/y.md",
    "user:commands/a/b/c/d/e/f/g.md",
  ])("refuses id %j", (id) => {
    expect(["INVALID", "NOT_FOUND"]).toContain(code(() => read(id)));
  });

  it("refuses symlinks leaving the root, to non-markdown, and FIFOs", () => {
    expect(code(() => read("project:agents/kacis.md"))).toBe("INVALID");
    expect(code(() => read("project:skills/kacak/SKILL.md"))).toBe("INVALID");
    expect(code(() => read("project:commands/ayar.md"))).toBe("INVALID");
    expect(code(() => read("project:commands/boru.md"))).toBe("INVALID");
    expect(code(() => read("plugin:dis-baglanti/skills/kacak/SKILL.md"))).toBe("INVALID");
    // A link inside the project is fine.
    expect(read("project:agents/takma.md").text).toContain("inceleyici");
  });

  it("project ids need a project folder; missing files are NOT_FOUND", () => {
    expect(code(() => read("project:skills/derle/SKILL.md", {}, null))).toBe("INVALID");
    expect(code(() => read("project:skills/yok/SKILL.md"))).toBe("NOT_FOUND");
  });

  it("monkey: random ids never read outside or throw non-engine errors", () => {
    let seed = 11;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const parts = ["project:", "user:", "plugin:", "skills", "agents", "commands", "/", "..", ".", "SKILL.md", "a.md", "derle", "%2e", "\\", "~", "secret.md", ".credentials.json"];
    for (let i = 0; i < 1500; i++) {
      let id = "";
      const n = 1 + Math.floor(rnd() * 10);
      for (let j = 0; j < n; j++) id += parts[Math.floor(rnd() * parts.length)];
      try {
        const r = service().read(target(repo), id);
        expect(r.text ?? "").not.toContain(SECRET);
      } catch (err) {
        expect(err).toBeInstanceOf(EngineError);
      }
    }
  });
});
