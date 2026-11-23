import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Card, Project, SshHost, Tool } from "@kokpit/shared";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../test/fakes/memory-store.ts";
import { EngineError, type Logger, type StateStore } from "./contracts.ts";
import { createProjectService, type ProjectServiceDeps } from "./projects.ts";

const TUNABLES = {
  slugMaxLen: 40,
  slugFallback: "proje",
  builtinProjectId: "mac-mini",
  builtinProjectName: "Mac mini",
};

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-projects-")));
  tmpDirs.push(d);
  return d;
}

interface Setup {
  svc: ReturnType<typeof createProjectService>;
  store: StateStore;
  home: string;
  reposDir: string;
  hosts: Map<string, SshHost>;
  tools: Map<string, Tool>;
  clones: { url: string; dest: string }[];
  deleted: string[];
  warnings: string[];
  /** Next clone fails after writing a partial dir. */
  failNextClone: { value: boolean };
}

function setup(opts: { configProjects?: Project[]; store?: StateStore; home?: string } = {}): Setup {
  const root = tmp();
  const home = opts.home ?? join(root, "home");
  mkdirSync(home, { recursive: true });
  const reposDir = join(root, "repos");
  mkdirSync(reposDir);
  const store = opts.store ?? new MemoryStore();
  const hosts = new Map<string, SshHost>([["oracle", { id: "oracle", name: "oracle", hostname: "oracle", source: "ssh-config" }]]);
  const tools = new Map<string, Tool>([["claude", { id: "claude", name: "Claude", command: "claude" }]]);
  const clones: Setup["clones"] = [];
  const deleted: string[] = [];
  const warnings: string[] = [];
  const failNextClone = { value: false };
  const logger: Logger = { info() {}, warn: (m) => warnings.push(m), error() {} };
  const deps: ProjectServiceDeps = {
    config: { projects: opts.configProjects ?? [], tunables: TUNABLES },
    paths: { reposDir },
    hostPaths: { homeDir: home },
    store,
    logger,
    sshHosts: { get: (id) => hosts.get(id) },
    tools: { get: (id) => tools.get(id) },
    git: {
      clone: async (url, dest) => {
        clones.push({ url, dest });
        mkdirSync(dest);
        writeFileSync(join(dest, "partial"), "x");
        if (failNextClone.value) {
          failNextClone.value = false;
          throw Object.assign(new Error("clone failed"), { stderr: "fatal: repository not found\n" });
        }
        mkdirSync(join(dest, ".git"));
      },
    },
    onBeforeDelete: (id) => {
      deleted.push(id);
    },
    claudeAccounts: { get: (id) => (["benim", "work"].includes(id) ? { id, name: id, configDir: `/h/.${id}` } : undefined) }, // İş H
  };
  return { svc: createProjectService(deps), store, home, reposDir, hosts, tools, clones, deleted, warnings, failNextClone };
}

async function engineError(p: Promise<unknown> | (() => unknown)): Promise<EngineError> {
  let err: unknown;
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(EngineError);
  return err as EngineError;
}

const card = (id: string, projectId: string): Card => ({
  id,
  projectId,
  name: id,
  branch: `kokpit/${id}`,
  worktreePath: `/w/${id}`,
  createdAt: "2026-11-16T00:00:00.000Z",
});

describe("init", () => {
  it("seeds the built-in project at the home dir and imports config projects", async () => {
    const repo = tmp();
    const s = setup({ configProjects: [{ id: "kokpit", name: "Kokpit", location: { kind: "local", path: repo } }] });
    await s.svc.init();
    expect(s.svc.list()).toEqual([
      { id: "mac-mini", name: "Mac mini", location: { kind: "local", path: s.home }, builtin: true },
      { id: "kokpit", name: "Kokpit", location: { kind: "local", path: repo } },
    ]);
    expect(s.store.isSeeded("builtin-project")).toBe(true);
    expect(s.store.isSeeded("config-projects")).toBe(true);
  });

  it("is idempotent and never resurrects deleted projects", async () => {
    const store = new MemoryStore();
    const cfg: Project[] = [{ id: "a", name: "A", location: { kind: "local", path: "/x" } }];
    const s1 = setup({ configProjects: cfg, store });
    await s1.svc.init();
    await s1.svc.init();
    expect(store.listProjects().map((p) => p.id)).toEqual(["mac-mini", "a"]);
    s1.svc.delete("a");
    const s2 = setup({ configProjects: cfg, store });
    await s2.svc.init();
    expect(store.listProjects().map((p) => p.id)).toEqual(["mac-mini"]);
  });

  it("does not overwrite a stored project with the same id as a config project", async () => {
    const store = new MemoryStore();
    store.upsertProject({ id: "a", name: "Edited", location: { kind: "local", path: "/y" } });
    const s = setup({ configProjects: [{ id: "a", name: "A", location: { kind: "local", path: "/x" } }], store });
    await s.svc.init();
    expect(store.getProject("a")?.name).toBe("Edited");
  });
});

describe("create", () => {
  it("local: stores an existing directory, id from the name", async () => {
    const s = setup();
    const dir = tmp();
    const p = await s.svc.create({ name: "Şık Proje", location: { kind: "local", path: dir } });
    expect(p).toEqual({ id: "sik-proje", name: "Şık Proje", location: { kind: "local", path: dir } });
    expect(s.svc.get("sik-proje")).toEqual(p);
  });

  it("local: normalises the path", async () => {
    const s = setup();
    const dir = tmp();
    const p = await s.svc.create({ name: "x", location: { kind: "local", path: `${dir}/sub/..` } });
    expect(p.location).toEqual({ kind: "local", path: dir });
  });

  it("local: rejects a missing path or a file with INVALID naming the path", async () => {
    const s = setup();
    const missing = join(tmp(), "yok");
    const e1 = await engineError(s.svc.create({ name: "x", location: { kind: "local", path: missing } }));
    expect(e1.code).toBe("INVALID");
    expect(e1.message).toContain(missing);
    const file = join(tmp(), "f");
    writeFileSync(file, "x");
    const e2 = await engineError(s.svc.create({ name: "x", location: { kind: "local", path: file } }));
    expect(e2.code).toBe("INVALID");
    expect(e2.message).toContain(file);
    expect(s.svc.list()).toEqual([]);
  });

  it("makes ids unique with -2, -3 (also against the built-in project)", async () => {
    const s = setup();
    await s.svc.init();
    const dir = tmp();
    const a = await s.svc.create({ name: "Aynı", location: { kind: "local", path: dir } });
    const b = await s.svc.create({ name: "aynı", location: { kind: "local", path: dir } });
    const c = await s.svc.create({ name: "Mac Mini", location: { kind: "local", path: dir } });
    expect([a.id, b.id, c.id]).toEqual(["ayni", "ayni-2", "mac-mini-2"]);
  });

  it("github: clones into <reposDir>/<id> and stores the clone path", async () => {
    const s = setup();
    const url = "https://github.com/owner/repo.git";
    const p = await s.svc.create({ name: "Repo", location: { kind: "github", url } });
    const dest = join(s.reposDir, "repo");
    expect(s.clones).toEqual([{ url, dest }]);
    expect(p).toEqual({ id: "repo", name: "Repo", location: { kind: "github", url, path: dest } });
    expect(s.store.getProject("repo")).toEqual(p);
  });

  it("github: on failure removes the partial dir, stores nothing, GIT_FAILED with stderr", async () => {
    const s = setup();
    s.failNextClone.value = true;
    const err = await engineError(s.svc.create({ name: "Repo", location: { kind: "github", url: "https://x/y" } }));
    expect(err.code).toBe("GIT_FAILED");
    expect(err.message).toContain("repository not found");
    expect(readdirSync(s.reposDir)).toEqual([]);
    expect(s.svc.list()).toEqual([]);
    const ok = await s.svc.create({ name: "Repo", location: { kind: "github", url: "https://x/y" } });
    expect(ok.id).toBe("repo");
  });

  it("github: skips an id whose clone dir already exists (never deletes it)", async () => {
    const s = setup();
    mkdirSync(join(s.reposDir, "repo"));
    writeFileSync(join(s.reposDir, "repo", "keep"), "x");
    const p = await s.svc.create({ name: "Repo", location: { kind: "github", url: "https://x/y" } });
    expect(p.id).toBe("repo-2");
    expect(existsSync(join(s.reposDir, "repo", "keep"))).toBe(true);
  });

  it("github: concurrent creates with the same name get distinct ids and dirs", async () => {
    const s = setup();
    const ps = await Promise.all(
      Array.from({ length: 4 }, () => s.svc.create({ name: "Repo", location: { kind: "github", url: "https://x/y" } })),
    );
    expect(ps.map((p) => p.id).sort()).toEqual(["repo", "repo-2", "repo-3", "repo-4"]);
    expect(new Set(s.clones.map((c) => c.dest)).size).toBe(4);
  });

  it("ssh: needs an existing host (NOT_FOUND otherwise)", async () => {
    const s = setup();
    const p = await s.svc.create({ name: "Uzak", location: { kind: "ssh", hostId: "oracle", path: "/srv/app" } });
    expect(p.location).toEqual({ kind: "ssh", hostId: "oracle", path: "/srv/app" });
    const home = await s.svc.create({ name: "Ev", location: { kind: "ssh", hostId: "oracle" } });
    expect(home.location).toEqual({ kind: "ssh", hostId: "oracle" });
    const err = await engineError(s.svc.create({ name: "x", location: { kind: "ssh", hostId: "nope" } }));
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toContain("nope");
  });

  it.each([
    ["/home/ubuntu/../x/", "/home/ubuntu/../x"],
    ["/home/ubuntu/./app", "/home/ubuntu/./app"],
    ["/srv/app//", "/srv/app"],
    ["/", "/"],
    ["//", "/"],
    ["/srv/my app", "/srv/my app"],
  ])("ssh: the remote path %s is stored as given, only trailing slashes trimmed → %s", async (given, stored) => {
    const s = setup();
    const p = await s.svc.create({ name: "Uzak", location: { kind: "ssh", hostId: "oracle", path: given } });
    expect(p.location).toEqual({ kind: "ssh", hostId: "oracle", path: stored });
  });

  it("defaultToolId must exist (NOT_FOUND), and is stored", async () => {
    const s = setup();
    const dir = tmp();
    const err = await engineError(
      s.svc.create({ name: "x", location: { kind: "local", path: dir }, defaultToolId: "nope" }),
    );
    expect(err.code).toBe("NOT_FOUND");
    const p = await s.svc.create({ name: "x", location: { kind: "local", path: dir }, defaultToolId: "claude" });
    expect(p.defaultToolId).toBe("claude");
  });

  it("rejects malformed input with INVALID (defence in depth)", async () => {
    const s = setup();
    const bad: unknown[] = [
      {},
      { name: "", location: { kind: "local", path: "/" } },
      { name: "x", location: { kind: "local", path: "relative" } },
      { name: "x", location: { kind: "github", url: "--upload-pack=x" } },
      { name: "x", location: { kind: "github", url: "file:///etc" } },
      { name: "x", location: { kind: "github", url: "https://x/y", path: "/tmp/chosen" } },
      { name: "x", location: { kind: "ftp", path: "/" } },
      { name: "x", location: { kind: "local", path: "/" }, builtin: true },
    ];
    for (const input of bad) {
      const err = await engineError(s.svc.create(input as never));
      expect(err.code).toBe("INVALID");
    }
    expect(s.clones).toEqual([]);
    expect(s.svc.list()).toEqual([]);
  });
});

describe("update", () => {
  it("renames and sets/clears the default tool, not the location", async () => {
    const s = setup();
    const dir = tmp();
    await s.svc.create({ name: "x", location: { kind: "local", path: dir } });
    expect(s.svc.update({ projectId: "x", name: "Yeni ad", defaultToolId: "claude" })).toEqual({
      id: "x",
      name: "Yeni ad",
      location: { kind: "local", path: dir },
      defaultToolId: "claude",
    });
    const cleared = s.svc.update({ projectId: "x", defaultToolId: null });
    expect(cleared).not.toHaveProperty("defaultToolId");
    expect(s.store.getProject("x")).toEqual(cleared);
    expect(s.svc.update({ projectId: "x" })).toEqual(cleared);
  });

  it("errors: unknown project, unknown tool, location change", async () => {
    const s = setup();
    await s.svc.create({ name: "x", location: { kind: "local", path: tmp() } });
    expect((await engineError(() => s.svc.update({ projectId: "nope", name: "a" }))).code).toBe("NOT_FOUND");
    expect((await engineError(() => s.svc.update({ projectId: "x", defaultToolId: "nope" }))).code).toBe("NOT_FOUND");
    const loc = { projectId: "x", location: { kind: "local", path: "rel" } } as never;
    expect((await engineError(() => s.svc.update(loc))).code).toBe("INVALID");
  });
});

describe("update location (İş P)", () => {
  it("local → local: the new folder must exist; the path is normalised; other fields stay", async () => {
    const s = setup();
    const a = tmp();
    const b = tmp();
    await s.svc.create({ name: "x", location: { kind: "local", path: a }, defaultToolId: "claude" });
    const missing = await engineError(() => s.svc.update({ projectId: "x", location: { kind: "local", path: join(b, "yok") } }));
    expect(missing.code).toBe("INVALID");
    expect(missing.message).toContain("Klasör bulunamadı");
    expect(s.svc.get("x")?.location).toEqual({ kind: "local", path: a });
    const next = s.svc.update({ projectId: "x", location: { kind: "local", path: `${b}/./` } });
    expect(next).toEqual({ id: "x", name: "x", location: { kind: "local", path: b }, defaultToolId: "claude" });
    expect(s.store.getProject("x")).toEqual(next);
  });

  it("local ↔ ssh: the host must exist; the remote path is kept as typed (trailing slashes go)", async () => {
    const s = setup();
    await s.svc.create({ name: "x", location: { kind: "local", path: tmp() } });
    expect((await engineError(() => s.svc.update({ projectId: "x", location: { kind: "ssh", hostId: "nope" } }))).code).toBe("NOT_FOUND");
    expect(s.svc.update({ projectId: "x", location: { kind: "ssh", hostId: "oracle", path: "/srv/../app/" } }).location).toEqual({
      kind: "ssh",
      hostId: "oracle",
      path: "/srv/../app",
    });
    expect(s.svc.update({ projectId: "x", location: { kind: "ssh", hostId: "oracle" } }).location).toEqual({ kind: "ssh", hostId: "oracle" });
    const dir = tmp();
    expect(s.svc.update({ projectId: "x", location: { kind: "local", path: dir } }).location).toEqual({ kind: "local", path: dir });
  });

  it("refuses a project with cards: Önce kartları sil", async () => {
    const s = setup();
    const a = tmp();
    await s.svc.create({ name: "x", location: { kind: "local", path: a } });
    s.store.addCard(card("c1", "x"));
    const err = await engineError(() => s.svc.update({ projectId: "x", location: { kind: "local", path: tmp() } }));
    expect(err.code).toBe("INVALID");
    expect(err.message).toContain("Önce kartları sil");
    expect(s.svc.get("x")?.location).toEqual({ kind: "local", path: a });
    // Other fields still change on a project with cards; sending the same location is not a change.
    expect(s.svc.update({ projectId: "x", name: "y", location: { kind: "local", path: a } }).name).toBe("y");
  });

  it("refuses built-in projects (Mac mini, Browser tasks)", async () => {
    const s = setup();
    await s.svc.init();
    const err = await engineError(() => s.svc.update({ projectId: "mac-mini", location: { kind: "local", path: tmp() } }));
    expect(err.code).toBe("INVALID");
    expect(err.message).toContain("Yerleşik");
    s.store.upsertProject({ id: "tarayici", name: "Browser tasks", location: { kind: "local", path: tmp() }, builtin: true });
    expect((await engineError(() => s.svc.update({ projectId: "tarayici", location: { kind: "local", path: tmp() } }))).code).toBe("INVALID");
    expect(s.svc.update({ projectId: "mac-mini", name: "Ev" }).name).toBe("Ev");
  });

  it("github: the location cannot change, and nothing becomes github", async () => {
    const s = setup();
    const gh = await s.svc.create({ name: "Repo", location: { kind: "github", url: "https://x/y" } });
    const err = await engineError(() => s.svc.update({ projectId: gh.id, location: { kind: "local", path: tmp() } }));
    expect(err.code).toBe("INVALID");
    expect(err.message).toContain("GitHub");
    // The same URL is no change (the form always sends the location).
    expect(s.svc.update({ projectId: gh.id, name: "R2", location: { kind: "github", url: "https://x/y" } }).location).toEqual(gh.location);
    expect((await engineError(() => s.svc.update({ projectId: gh.id, location: { kind: "github", url: "https://x/z" } }))).code).toBe("INVALID");
    await s.svc.create({ name: "l", location: { kind: "local", path: tmp() } });
    expect((await engineError(() => s.svc.update({ projectId: "l", location: { kind: "github", url: "https://x/y" } }))).code).toBe("INVALID");
    expect(s.clones).toHaveLength(1);
  });

});


describe("delete", () => {
  it("removes the record after the hook, never touches files", async () => {
    const s = setup();
    const p = await s.svc.create({ name: "Repo", location: { kind: "github", url: "https://x/y" } });
    s.svc.delete(p.id);
    expect(s.deleted).toEqual([p.id]);
    expect(s.svc.get(p.id)).toBeUndefined();
    expect(existsSync(join(s.reposDir, "repo", "partial"))).toBe(true);
  });

  it("refuses the built-in project and a project with cards (INVALID), unknown → NOT_FOUND", async () => {
    const s = setup();
    await s.svc.init();
    expect((await engineError(() => s.svc.delete("mac-mini"))).code).toBe("INVALID");
    await s.svc.create({ name: "x", location: { kind: "local", path: tmp() } });
    s.store.addCard(card("c1", "x"));
    const err = await engineError(() => s.svc.delete("x"));
    expect(err.code).toBe("INVALID");
    expect(err.message).toContain("Önce kartları sil");
    expect((await engineError(() => s.svc.delete("nope"))).code).toBe("NOT_FOUND");
    expect(s.deleted).toEqual([]);
    expect(s.svc.list().map((p) => p.id)).toEqual(["mac-mini", "x"]);
  });
});

describe("monkey", () => {
  it("random create/update/delete sequences match an in-memory model", async () => {
    let seed = 987654;
    const rnd = (n: number) => {
      seed = (seed * 48271) % 2147483647;
      return seed % n;
    };
    const s = setup();
    await s.svc.init();
    const dirs = [tmp(), tmp(), join(tmp(), "missing")];
    const names = ["Alpha", "alpha", "Şeker", "🚀", "  b  ", "Mac mini", "x".repeat(80)];
    const toolIds = ["claude", "nope", null];
    const model = new Map<string, Project>(s.svc.list().map((p) => [p.id, p]));
    const withCards = new Set<string>();
    let created = 0;

    for (let step = 0; step < 300; step++) {
      const ids = [...model.keys(), "ghost"];
      const pick = ids[rnd(ids.length)]!;
      const op = rnd(6);
      if (op <= 1) {
        const name = names[rnd(names.length)]!;
        const kind = rnd(3);
        const toolId = toolIds[rnd(3)];
        const location =
          kind === 0
            ? { kind: "local" as const, path: dirs[rnd(dirs.length)]! }
            : kind === 1
              ? { kind: "github" as const, url: "https://github.com/a/b" }
              : { kind: "ssh" as const, hostId: rnd(2) ? "oracle" : "nope" };
        const failClone = kind === 1 && rnd(3) === 0;
        s.failNextClone.value = failClone;
        const input = { name, location, ...(toolId ? { defaultToolId: toolId } : {}) };
        const res = await s.svc.create(input).then(
          (p) => p,
          (e: EngineError) => e,
        );
        const expectFail =
          (kind === 0 && location.kind === "local" && location.path === dirs[2]) ||
          (kind === 2 && location.kind === "ssh" && location.hostId === "nope") ||
          toolId === "nope" ||
          failClone;
        if (expectFail) {
          expect(res).toBeInstanceOf(EngineError);
        } else {
          expect(res).not.toBeInstanceOf(EngineError);
          const p = res as Project;
          expect(model.has(p.id)).toBe(false);
          expect(p.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
          model.set(p.id, p);
          created++;
        }
        s.failNextClone.value = false;
      } else if (op === 2) {
        const tool = toolIds[rnd(3)];
        let threw: EngineError | undefined;
        try {
          s.svc.update({ projectId: pick, name: "Renamed", defaultToolId: tool });
        } catch (e) {
          threw = e as EngineError;
        }
        const ok = model.has(pick) && tool !== "nope";
        expect(threw?.code).toBe(ok ? undefined : "NOT_FOUND");
        if (ok) {
          const prev = model.get(pick)!;
          const { defaultToolId: _d, ...rest } = prev;
          model.set(pick, tool ? { ...rest, name: "Renamed", defaultToolId: tool } : { ...rest, name: "Renamed" });
        }
      } else if (op === 3) {
        if (model.has(pick) && !withCards.has(pick) && rnd(4) === 0) {
          s.store.addCard(card(`c-${step}`, pick));
          withCards.add(pick);
        }
      } else {
        let threw: EngineError | undefined;
        try {
          s.svc.delete(pick);
        } catch (e) {
          threw = e as EngineError;
        }
        const builtin = model.get(pick)?.builtin === true;
        if (!model.has(pick)) expect(threw?.code).toBe("NOT_FOUND");
        else if (builtin || withCards.has(pick)) expect(threw?.code).toBe("INVALID");
        else {
          expect(threw).toBeUndefined();
          model.delete(pick);
        }
      }
      const byId = (a: Project, b: Project) => a.id.localeCompare(b.id);
      expect([...s.svc.list()].sort(byId)).toEqual([...model.values()].sort(byId));
      // Every github project's clone dir exists; no orphan dirs from failed clones.
      const cloneDirs = new Set(readdirSync(s.reposDir));
      for (const p of model.values()) {
        if (p.location.kind === "github") expect(cloneDirs.has(p.id)).toBe(true);
      }
      for (const d of cloneDirs) {
        const owner = [...model.values()].find((p) => p.location.kind === "github" && p.location.path === join(s.reposDir, d));
        const deletedGithub = s.deleted.includes(d);
        expect(owner !== undefined || deletedGithub).toBe(true);
      }
    }
    expect(model.has("mac-mini")).toBe(true);
    expect(created).toBeGreaterThan(20);
    expect(s.deleted.length).toBeGreaterThan(5);
  });
});

describe("Claude account (İş H)", () => {
  it("create and update set, keep and clear the account; unknown ids are refused", async () => {
    const s = setup();
    const created = await s.svc.create({ name: "k", location: { kind: "local", path: tmp() }, claudeAccountId: "work" });
    expect(created.claudeAccountId).toBe("work");
    expect(s.svc.update({ projectId: "k", name: "K2" }).claudeAccountId).toBe("work");
    const cleared = s.svc.update({ projectId: "k", claudeAccountId: null });
    expect(cleared).not.toHaveProperty("claudeAccountId");
    expect(s.svc.update({ projectId: "k", claudeAccountId: "benim" }).claudeAccountId).toBe("benim");
    expect((await engineError(() => s.svc.update({ projectId: "k", claudeAccountId: "nope" }))).code).toBe("NOT_FOUND");
    expect(
      (await engineError(s.svc.create({ name: "z", location: { kind: "local", path: tmp() }, claudeAccountId: "nope" }))).code,
    ).toBe("NOT_FOUND");
    expect(s.svc.list().some((p) => p.name === "z")).toBe(false);
  });

  it("the built-in project may pick an account too", async () => {
    const s = setup();
    await s.svc.init();
    expect(s.svc.update({ projectId: "mac-mini", claudeAccountId: "work" }).claudeAccountId).toBe("work");
  });
});
