// İş F — Dosyalar end-to-end against the real engine: a temp git repo as a project, one card worktree,
// browsing and previewing inside them, and every escape (.., absolute, symlinks, .git) refused.
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, startEngine, stopEngine, type EngineProc } from "./harness.ts";

const KEY = randomBytes(32).toString("base64url");
const SECRET = "KOKPIT-FILES-E2E-SECRET-41c2";
const MAX_READ = 32;

let root: string;
let repo: string;
let engine: EngineProc | undefined;
let c: Client;
let projectId: string;
let cardId: string;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-e2e-files-")));
  repo = join(root, "depo");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(root, "home"));
  writeFileSync(join(root, "secret.txt"), SECRET);
  writeFileSync(join(repo, "README.md"), "# Depo\nmerhaba\n");
  writeFileSync(join(repo, "src", "main.ts"), "console.log('kokpit');\n");
  writeFileSync(join(repo, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]));
  writeFileSync(join(repo, "big.log"), "satır\n".repeat(100));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "-c", "user.email=e2e@kokpit.test", "-c", "user.name=e2e", "add", ".");
  git(repo, "-c", "user.email=e2e@kokpit.test", "-c", "user.name=e2e", "commit", "-q", "-m", "ilk");
  // Untracked escapes: must never be followed.
  symlinkSync(join(root, "secret.txt"), join(repo, "kacis.txt"));
  symlinkSync("/etc", join(repo, "etc"));
  symlinkSync(join(repo, "src"), join(repo, "kaynak"));

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
      files: { maxReadBytes: MAX_READ },
    }),
  );
  engine = await startEngine({ KOKPIT_CONFIG: configPath, KOKPIT_KEY: KEY, HOME: join(root, "home") });
  c = await Client.connect(engine.port, KEY);
  await c.req("settings.update", { defaultToolId: null });
  projectId = (await c.req<{ project: { id: string } }>("projects.create", { name: "Depo", location: { kind: "local", path: repo } })).project.id;
  const { card } = await c.req<{ card: { id: string; worktreePath: string } }>("cards.create", { projectId, name: "Dosya kartı" });
  cardId = card.id;
  writeFileSync(join(card.worktreePath, "kart-notu.txt"), "yalnız kartta\n");
}, 60000);

afterAll(async () => {
  await c?.close();
  await stopEngine(engine);
  rmSync(root, { recursive: true, force: true });
});

type Entry = { name: string; kind: string; size?: number; target?: string };
const list = (params: Record<string, unknown>) => c.req<{ entries: Entry[]; truncated: boolean }>("files.list", params);

describe("Dosyalar end-to-end", () => {
  it("lists the project root: folders first, .git hidden", async () => {
    const { entries, truncated } = await list({ projectId, path: "" });
    expect(truncated).toBe(false);
    expect(entries.map((e) => e.name)).toEqual(["kaynak", "src", "big.log", "etc", "kacis.txt", "logo.png", "README.md"]);
    expect(entries.find((e) => e.name === "kaynak")).toEqual({ name: "kaynak", kind: "symlink", target: "dir" });
    expect(entries.find((e) => e.name === "etc")).toEqual({ name: "etc", kind: "symlink" });
    expect(entries.find((e) => e.name === "README.md")).toEqual({ name: "README.md", kind: "file", size: 15 });
  });

  it("opens subfolders and previews text, binary and big files", async () => {
    expect((await list({ projectId, path: "src" })).entries).toEqual([{ name: "main.ts", kind: "file", size: 23 }]);
    expect(await c.req("files.read", { projectId, path: "src/main.ts" })).toEqual({
      text: "console.log('kokpit');\n",
      size: 23,
      truncated: false,
    });
    expect(await c.req("files.read", { projectId, path: "logo.png" })).toEqual({ binary: true, size: 10, truncated: false, media: "image" });
    const big = await c.req<{ text: string; size: number; truncated: boolean }>("files.read", { projectId, path: "big.log" });
    expect(big.truncated).toBe(true);
    expect(big.size).toBe(Buffer.byteLength("satır\n".repeat(100)));
    expect(Buffer.byteLength(big.text)).toBeLessThanOrEqual(MAX_READ);
    expect(big.text.startsWith("satır\nsatır\n")).toBe(true);
  });

  it("browses a card's worktree, not the project folder", async () => {
    const names = (await list({ cardId, path: "" })).entries.map((e) => e.name);
    expect(names).toContain("kart-notu.txt");
    expect(names).toContain("README.md");
    expect((await list({ projectId, path: "" })).entries.map((e) => e.name)).not.toContain("kart-notu.txt");
    expect(await c.req("files.read", { cardId, path: "kart-notu.txt" })).toMatchObject({ text: "yalnız kartta\n" });
  });

  it.each([
    ["../secret.txt", "INVALID"],
    ["src/../../secret.txt", "INVALID"],
    ["/etc/passwd", "INVALID"],
    ["kacis.txt", "INVALID"],
    ["etc/hosts", "INVALID"],
    ["%2e%2e%2fsecret.txt", "NOT_FOUND"],
    [".git/config", "NOT_FOUND"],
    [".git/HEAD", "NOT_FOUND"],
  ])("refuses %s (%s), for the project and the card", async (path, code) => {
    await expect(c.req("files.read", { projectId, path })).rejects.toMatchObject({ code });
    // The card's worktree has no copy of the untracked links: there they are simply missing.
    const card = await c.req("files.read", { cardId, path }).then(
      () => "OK",
      (e: { code: string }) => e.code,
    );
    expect(["INVALID", "NOT_FOUND"]).toContain(card);
    await expect(list({ projectId, path: ".git" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses malformed requests without dropping the connection", async () => {
    await expect(c.req("files.list", { path: "" })).rejects.toMatchObject({ code: "INVALID" });
    await expect(c.req("files.list", { projectId, cardId, path: "" })).rejects.toMatchObject({ code: "INVALID" });
    await expect(c.req("files.read", { projectId, path: "a".repeat(5000) })).rejects.toMatchObject({ code: "INVALID" });
    expect((await list({ projectId, path: "src" })).entries).toHaveLength(1);
  });

  it("ssh projects have no files (Turkish note)", async () => {
    const { host } = await c.req<{ host: { id: string } }>("sshHosts.create", { name: "Uzak", hostname: "uzak.example" });
    const { project } = await c.req<{ project: { id: string } }>("projects.create", {
      name: "Uzak",
      location: { kind: "ssh", hostId: host.id, path: repo },
    });
    await expect(list({ projectId: project.id, path: "" })).rejects.toMatchObject({ code: "INVALID", message: expect.stringMatching(/SSH/) });
  });

  it("never logs file contents", () => {
    expect(engine!.logs()).not.toContain(SECRET);
    expect(engine!.logs()).not.toContain("kokpit');");
  });
});
