// İş C (Adım 8) — Claude envanteri end-to-end against the real engine: a temp HOME with a fake `~/.claude`
// (skills, agents, commands, a plugin skill, a credentials file that must never leak), a local project with its own
// `.claude`, an SSH project (account part only), previews, caps from engine.json and escapes refused.
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, startEngine, stopEngine, type EngineProc } from "./harness.ts";

const KEY = randomBytes(32).toString("base64url");
const SECRET = "KOKPIT-CLAUDE-E2E-SECRET-5a7e";
const MAX_READ = 48;

let root: string;
let engine: EngineProc | undefined;
let c: Client;
let projectId: string;
let sshProjectId: string;

const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

type Item = { kind: string; name: string; description?: string; source: string; path: string; id: string };
type Inventory = { items: Item[]; truncated: boolean; claudeMd: { project?: boolean; user: boolean }; note?: string };

async function reqError(method: string, params: Record<string, unknown>): Promise<{ code: string; message: string }> {
  try {
    await c.req(method, params);
  } catch (err) {
    return err as { code: string; message: string };
  }
  throw new Error(`${method} unexpectedly succeeded`);
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-e2e-claude-")));
  const home = join(root, "home");
  const cfg = join(home, ".claude");
  const repo = join(root, "depo");
  put(join(root, "gizli.md"), SECRET);
  put(join(cfg, ".credentials.json"), SECRET);
  put(join(cfg, "CLAUDE.md"), "# ben\n");
  put(join(cfg, "skills", "gunluk", "SKILL.md"), "---\nname: gunluk\ndescription: Günlük özet çıkarır\n---\nadımlar\n");
  put(join(cfg, "agents", "denetci.md"), "---\nname: denetci\ndescription: Kodu denetler\n---\n");
  put(join(cfg, "commands", "selam.md"), "---\ndescription: Selam verir\n---\nSelam!\n");
  put(join(cfg, "plugins", "cache", "pazar", "guc", "1.0.0", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "guc" }));
  put(join(cfg, "plugins", "cache", "pazar", "guc", "1.0.0", "skills", "tdd", "SKILL.md"), "---\nname: tdd\ndescription: Önce test\n---\n");
  put(join(repo, ".claude", "skills", "derle", "SKILL.md"), "---\nname: derle\ndescription: Projeyi derler\n---\n" + "x".repeat(200));
  put(join(repo, ".claude", "commands", "yayinla.md"), "---\ndescription: Sürüm yayınlar\n---\n");
  symlinkSync(join(root, "gizli.md"), join(repo, ".claude", "commands", "kacis.md"));

  const configPath = join(root, "engine.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      dataDir: join(root, "data"),
      port: 0,
      shell: "/bin/sh",
      shellArgs: [],
      listenTailscale: false,
      flushIntervalMs: 100,
      killGraceMs: 200,
      claudeInventory: { maxReadBytes: MAX_READ },
    }),
  );
  engine = await startEngine({ KOKPIT_CONFIG: configPath, KOKPIT_KEY: KEY, HOME: home });
  c = await Client.connect(engine.port, KEY);
  await c.req("settings.update", { defaultToolId: null });
  projectId = (await c.req<{ project: { id: string } }>("projects.create", { name: "Depo", location: { kind: "local", path: repo } })).project.id;
  const { host } = await c.req<{ host: { id: string } }>("sshHosts.create", { name: "Kutu", hostname: "kutu.example" });
  sshProjectId = (
    await c.req<{ project: { id: string } }>("projects.create", { name: "Uzak", location: { kind: "ssh", hostId: host.id, path: "/srv/depo" } })
  ).project.id;
}, 60000);

afterAll(async () => {
  await c?.close();
  await stopEngine(engine);
  rmSync(root, { recursive: true, force: true });
});

describe("Claude envanteri end-to-end", () => {
  it("lists project, user and plugin items from the temp HOME", async () => {
    const r = await c.req<Inventory>("claude.inventory", { projectId });
    expect(r.items.map((i) => `${i.kind}/${i.source}/${i.name}`)).toEqual([
      "skill/project/derle",
      "skill/user/gunluk",
      "skill/plugin/guc:tdd",
      "agent/user/denetci",
      "command/project/yayinla",
      "command/user/selam",
    ]);
    expect(r.items.find((i) => i.name === "gunluk")).toMatchObject({ description: "Günlük özet çıkarır", path: "~/.claude/skills/gunluk/SKILL.md" });
    expect(r.claudeMd).toEqual({ project: false, user: true });
    expect(r.truncated).toBe(false);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("previews an item, capped by engine.json", async () => {
    const r = await c.req<{ text: string; size: number; truncated: boolean }>("claude.inventory.read", { projectId, id: "project:skills/derle/SKILL.md" });
    expect(r.text).toHaveLength(MAX_READ);
    expect(r.text.startsWith("---\nname: derle")).toBe(true);
    expect(r.truncated).toBe(true);
    const u = await c.req<{ text: string }>("claude.inventory.read", { projectId, id: "user:commands/selam.md" });
    expect(u.text).toContain("Selam!");
  });

  it.each([
    "user:.credentials.json",
    "user:../gizli.md",
    "project:commands/kacis.md",
    "user:settings.json",
    "/etc/passwd",
  ])("refuses %j", async (id) => {
    const err = await reqError("claude.inventory.read", { projectId, id });
    expect(["INVALID", "NOT_FOUND"]).toContain(err.code);
    expect(err.message).not.toContain(SECRET);
  });

  it("SSH project: account part only, with a note", async () => {
    const r = await c.req<Inventory>("claude.inventory", { projectId: sshProjectId });
    expect(r.items.every((i) => i.source !== "project")).toBe(true);
    expect(r.items.some((i) => i.name === "gunluk")).toBe(true);
    expect(r.note).toMatch(/SSH/);
  });

  it("malformed requests answer INVALID without closing the socket", async () => {
    expect((await reqError("claude.inventory", {})).code).toBe("INVALID");
    expect((await reqError("claude.inventory.read", { projectId, id: "" })).code).toBe("INVALID");
    expect((await c.req<Inventory>("claude.inventory", { projectId })).items.length).toBeGreaterThan(0);
  });
});
