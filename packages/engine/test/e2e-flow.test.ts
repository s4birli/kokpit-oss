// İş W — Akış end-to-end against the real engine: a temp project with docs/akis fixtures, listing (newest first,
// titles, non-.mmd ignored, capped), reading (size-capped), every escape refused, ssh projects without flows.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, startEngine, stopEngine, type EngineProc } from "./harness.ts";

const KEY = randomBytes(32).toString("base64url");
const SECRET = "KOKPIT-FLOW-E2E-SECRET-7d1e";
const MAX_FILES = 3;
const MAX_BYTES = 200;

let root: string;
let repo: string;
let engine: EngineProc | undefined;
let c: Client;
let projectId: string;

function writeAt(path: string, content: string, mtimeSec: number): void {
  writeFileSync(path, content);
  utimesSync(path, mtimeSec, mtimeSec);
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-e2e-flow-")));
  repo = join(root, "depo");
  const akis = join(repo, "docs", "akis");
  mkdirSync(akis, { recursive: true });
  mkdirSync(join(root, "home"));
  writeFileSync(join(root, "gizli.mmd"), `flowchart TD\n  ${SECRET}`);
  writeAt(join(akis, "giris.mmd"), "%% title: Giriş akışı\nflowchart TD\n  A([Başla]) --> B{Şifre doğru mu?}", 1_700_000_300);
  writeAt(join(akis, "odeme.mmd"), "flowchart LR\n  X --> Y", 1_700_000_200);
  writeAt(join(akis, "eski.mmd"), "flowchart LR\n  E", 1_700_000_100);
  writeAt(join(akis, "en-eski.mmd"), "flowchart LR\n  EE", 1_700_000_000);
  writeAt(join(akis, "buyuk.mmd"), `flowchart TD\n${"  A --> B\n".repeat(50)}`, 1_600_000_000);
  writeFileSync(join(akis, "notlar.md"), "# değil");
  writeFileSync(join(akis, "README.txt"), "değil");
  symlinkSync(join(root, "gizli.mmd"), join(akis, "kacis.mmd"));

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
      flow: { maxFiles: MAX_FILES, maxBytes: MAX_BYTES },
    }),
  );
  engine = await startEngine({ KOKPIT_CONFIG: configPath, KOKPIT_KEY: KEY, HOME: join(root, "home") });
  c = await Client.connect(engine.port, KEY);
  await c.req("settings.update", { defaultToolId: null });
  projectId = (await c.req<{ project: { id: string } }>("projects.create", { name: "Depo", location: { kind: "local", path: repo } })).project.id;
}, 60000);

afterAll(async () => {
  await c?.close();
  await stopEngine(engine);
  rmSync(root, { recursive: true, force: true });
});

type Flow = { id: string; file: string; title?: string; modifiedAt: string };
const list = (params: Record<string, unknown>) => c.req<{ flows: Flow[]; truncated: boolean }>("flow.list", params);

describe("Akış end-to-end", () => {
  it("info: the flow folder and a claude command that reads the shipped prompt file", async () => {
    const info = await c.req<{ available: boolean; dir: string; updateCommand: string }>("flow.info", { projectId });
    expect(info.available).toBe(true);
    expect(info.dir).toBe("docs/akis");
    expect(info.updateCommand).toMatch(/^claude /);
    const m = /'([^']*akis-ciz\.md)'/.exec(info.updateCommand);
    expect(m).not.toBeNull();
    expect(existsSync(m![1]!)).toBe(true);
  });

  it("lists .mmd files newest first, capped, with titles; non-.mmd and symlinks ignored", async () => {
    const { flows, truncated } = await list({ projectId });
    expect(truncated).toBe(true);
    expect(flows.map((f) => f.id)).toEqual(["giris.mmd", "odeme.mmd", "eski.mmd"]);
    expect(flows[0]).toEqual({
      id: "giris.mmd",
      file: "docs/akis/giris.mmd",
      title: "Giriş akışı",
      modifiedAt: new Date(1_700_000_300_000).toISOString(),
    });
    expect(JSON.stringify(flows)).not.toContain("kacis");
    expect(JSON.stringify(flows)).not.toContain("notlar");
  });

  it("reads a flow; a too-large one is refused", async () => {
    expect(await c.req("flow.read", { projectId, id: "odeme.mmd" })).toEqual({ text: "flowchart LR\n  X --> Y" });
    await expect(c.req("flow.read", { projectId, id: "buyuk.mmd" })).rejects.toMatchObject({ code: "INVALID" });
  });

  it.each([
    ["../../gizli.mmd", "INVALID"],
    ["/etc/passwd.mmd", "INVALID"],
    ["notlar.md", "INVALID"],
    ["..%2f..%2fgizli.mmd", "INVALID"],
    ["%2e%2e%2fgizli.mmd", "NOT_FOUND"],
    ["kacis.mmd", "NOT_FOUND"],
    ["yok.mmd", "NOT_FOUND"],
  ])("refuses %s (%s) without leaking", async (id, code) => {
    const r = await c.req("flow.read", { projectId, id }).then(
      (v) => ({ ok: v }),
      (e: { code: string; message: string }) => e,
    );
    expect(r).toMatchObject({ code });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("refuses malformed requests without dropping the connection", async () => {
    await expect(c.req("flow.list", {})).rejects.toMatchObject({ code: "INVALID" });
    await expect(c.req("flow.list", { projectId, dir: "/" })).rejects.toMatchObject({ code: "INVALID" });
    await expect(c.req("flow.read", { projectId, id: `${"a".repeat(300)}.mmd` })).rejects.toMatchObject({ code: "INVALID" });
    expect((await list({ projectId })).flows).toHaveLength(MAX_FILES);
  });

  it("ssh projects: unavailable, no list (Turkish note)", async () => {
    const { host } = await c.req<{ host: { id: string } }>("sshHosts.create", { name: "Uzak", hostname: "uzak.example" });
    const { project } = await c.req<{ project: { id: string } }>("projects.create", {
      name: "Uzak",
      location: { kind: "ssh", hostId: host.id, path: repo },
    });
    expect(await c.req("flow.info", { projectId: project.id })).toEqual({ available: false });
    await expect(list({ projectId: project.id })).rejects.toMatchObject({ code: "INVALID", message: expect.stringMatching(/SSH/) });
  });
});
