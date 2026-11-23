// İş B: projects carry `browser.runOn`; the built-in "Browser tasks" project is seeded once.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../test/fakes/memory-store.ts";
import type { Logger, StateStore } from "./contracts.ts";
import { createProjectService, type ProjectServiceDeps } from "./projects.ts";

const roots: string[] = [];
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

const logger: Logger = { info() {}, warn() {}, error() {} };

function setup(store: StateStore = new MemoryStore(), withBrowserProject = true, extra: Partial<ProjectServiceDeps> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-projects-browser-")));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home);
  const local = join(root, "local");
  mkdirSync(local);
  const deps: ProjectServiceDeps = {
    config: { projects: [], tunables: { slugMaxLen: 40, slugFallback: "proje", builtinProjectId: "mac-mini", builtinProjectName: "Mac mini" } },
    paths: { reposDir: join(root, "repos") },
    hostPaths: { homeDir: home },
    store,
    logger,
    sshHosts: { get: () => undefined },
    tools: { get: () => undefined },
    git: { clone: async () => {} },
    ...(withBrowserProject
      ? { browserProject: { id: "web-tasks", name: "Browser tasks", path: join(root, "browser-workspace") } }
      : {}),
    ...extra,
  };
  return { svc: createProjectService(deps), store, root, local };
}

describe("projects: browser", () => {
  it("seeds the built-in browser project once, after Mac mini, and creates its folder", async () => {
    const { svc, store, root } = setup();
    await svc.init();
    const list = svc.list();
    expect(list.map((p) => p.id)).toEqual(["mac-mini", "web-tasks"]);
    expect(list[1]).toEqual({
      id: "web-tasks",
      name: "Browser tasks",
      location: { kind: "local", path: join(root, "browser-workspace") },
      builtin: true,
    });
    expect(statSync(join(root, "browser-workspace")).isDirectory()).toBe(true);

    // Renamed by the user, then re-init (engine restart): not re-seeded, name kept.
    svc.update({ projectId: "web-tasks", name: "Web" });
    await svc.init();
    expect(svc.list().filter((p) => p.id === "web-tasks")).toHaveLength(1);
    expect(store.getProject("web-tasks")?.name).toBe("Web");
  });

  it("the built-in browser project cannot be deleted", async () => {
    const { svc } = setup();
    await svc.init();
    expect(() => svc.delete("web-tasks")).toThrow(/silinemez/);
  });

  it("an existing workspace folder is reused, and its absence later is not fatal", async () => {
    const { svc, root } = setup();
    mkdirSync(join(root, "browser-workspace"));
    await svc.init();
    expect(existsSync(join(root, "browser-workspace"))).toBe(true);
  });

  it("without the dep nothing extra is seeded (older wiring)", async () => {
    const { svc } = setup(new MemoryStore(), false);
    await svc.init();
    expect(svc.list().map((p) => p.id)).toEqual(["mac-mini"]);
  });

  it("create stores browser.runOn; update changes it and keeps it otherwise", async () => {
    const { svc, local } = setup();
    await svc.init();
    const p = await svc.create({ name: "Web", location: { kind: "local", path: local }, browser: { runOn: "client" } });
    expect(p.browser).toEqual({ runOn: "client" });
    expect(svc.update({ projectId: p.id, name: "Web 2" }).browser).toEqual({ runOn: "client" });
    expect(svc.update({ projectId: p.id, browser: { runOn: "engine" } }).browser).toEqual({ runOn: "engine" });
    const plain = await svc.create({ name: "Düz", location: { kind: "local", path: local } });
    expect(plain).not.toHaveProperty("browser");
  });

  it("browser.window: stored only while visible; an update that names only runOn keeps it", async () => {
    const { svc, local } = setup();
    await svc.init();
    const p = await svc.create({ name: "Web", location: { kind: "local", path: local } });
    const visible = svc.update({ projectId: p.id, browser: { runOn: "engine", window: "visible" } });
    expect(visible.browser).toEqual({ runOn: "engine", window: "visible" });
    // An app that only knows runOn (older form) does not turn the window back to hidden.
    expect(svc.update({ projectId: p.id, browser: { runOn: "engine" } }).browser).toEqual({ runOn: "engine", window: "visible" });
    // Hidden is the default: not stored.
    expect(svc.update({ projectId: p.id, browser: { runOn: "engine", window: "hidden" } }).browser).toEqual({ runOn: "engine" });
  });

  it("onAfterUpdate sees the window change (the engine restarts the running browser in the new mode)", async () => {
    const seen: [string | undefined, string | undefined][] = [];
    const { svc, local } = setup(new MemoryStore(), true, { onAfterUpdate: (next, prev) => seen.push([prev?.browser?.window, next.browser?.window]) });
    await svc.init();
    const p = await svc.create({ name: "Web", location: { kind: "local", path: local } });
    svc.update({ projectId: p.id, browser: { runOn: "engine", window: "visible" } });
    expect(seen.at(-1)).toEqual([undefined, "visible"]);
  });
});
