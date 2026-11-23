// Adım 9 İş A: projects carry `claudeBrowserEnv` (absent = on); update tells main.ts so the settings file follows.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "@kokpit/shared";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../test/fakes/memory-store.ts";
import type { Logger } from "./contracts.ts";
import { createProjectService, type ProjectServiceDeps } from "./projects.ts";

const roots: string[] = [];
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});
const logger: Logger = { info() {}, warn() {}, error() {} };

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-projects-cbe-")));
  roots.push(root);
  const local = join(root, "local");
  const other = join(root, "other");
  mkdirSync(local);
  mkdirSync(other);
  mkdirSync(join(root, "home"));
  const updates: { next: Project; previous: Project }[] = [];
  const deps: ProjectServiceDeps = {
    config: { projects: [], tunables: { slugMaxLen: 40, slugFallback: "proje", builtinProjectId: "mac-mini", builtinProjectName: "Mac mini" } },
    paths: { reposDir: join(root, "repos") },
    hostPaths: { homeDir: join(root, "home") },
    store: new MemoryStore(),
    logger,
    sshHosts: { get: () => undefined },
    tools: { get: () => undefined },
    git: { clone: async () => {} },
    onAfterUpdate: (next, previous) => updates.push({ next, previous }),
  };
  return { svc: createProjectService(deps), local, other, updates };
}

describe("projects: claudeBrowserEnv", () => {
  it("create stores it only when given; update switches it and keeps it across other updates", async () => {
    const { svc, local } = setup();
    const plain = await svc.create({ name: "A", location: { kind: "local", path: local } });
    expect(plain).not.toHaveProperty("claudeBrowserEnv");
    const off = await svc.create({ name: "B", location: { kind: "local", path: local }, claudeBrowserEnv: false });
    expect(off.claudeBrowserEnv).toBe(false);

    expect(svc.update({ projectId: plain.id, claudeBrowserEnv: false }).claudeBrowserEnv).toBe(false);
    expect(svc.update({ projectId: plain.id, name: "A2" }).claudeBrowserEnv).toBe(false);
    expect(svc.update({ projectId: plain.id, claudeBrowserEnv: true }).claudeBrowserEnv).toBe(true);
    expect(svc.get(plain.id)?.claudeBrowserEnv).toBe(true);
  });

  it("onAfterUpdate gets the stored project and the one before it (location change included)", async () => {
    const { svc, local, other, updates } = setup();
    const p = await svc.create({ name: "A", location: { kind: "local", path: local } });
    expect(updates).toEqual([]);
    svc.update({ projectId: p.id, claudeBrowserEnv: false });
    svc.update({ projectId: p.id, location: { kind: "local", path: other } });
    expect(updates).toHaveLength(2);
    expect(updates[0]).toEqual({ next: { ...p, claudeBrowserEnv: false }, previous: p });
    expect(updates[1]?.previous.location).toEqual({ kind: "local", path: local });
    expect(updates[1]?.next.location).toEqual({ kind: "local", path: other });
  });

  it("a failing onAfterUpdate does not undo or fail the update", async () => {
    const { svc, local, updates } = setup();
    const p = await svc.create({ name: "A", location: { kind: "local", path: local } });
    updates.push = () => {
      throw new Error("boom");
    };
    expect(svc.update({ projectId: p.id, name: "A2" }).name).toBe("A2");
    expect(svc.get(p.id)?.name).toBe("A2");
  });
});
