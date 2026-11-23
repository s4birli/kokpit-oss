import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Card, Project, SshHost, TerminalInfo, Tool } from "@kokpit/shared";
import { EngineError, type Logger, type StateStore } from "./contracts.ts";
import { createFileStore, createMemoryStore } from "./store.ts";

function memLogger() {
  const warns: string[] = [];
  const logger: Logger = { info: () => {}, warn: (m) => warns.push(m), error: () => {} };
  return { logger, warns };
}

const card = (id: string, projectId = "p1"): Card => ({
  id,
  projectId,
  name: `Card ${id}`,
  branch: `kokpit/${id}`,
  worktreePath: `/data/worktrees/${id}`,
  createdAt: "2026-11-16T00:00:00.000Z",
});

const term = (
  id: string,
  projectId: string,
  cardId?: string,
  status: TerminalInfo["status"] = "running",
): TerminalInfo => ({
  id,
  projectId,
  ...(cardId === undefined ? {} : { cardId }),
  title: `t ${id}`,
  status,
  ...(status === "exited" ? { exitCode: 0 } : {}),
  createdAt: "2026-11-16T00:00:00.000Z",
});

const project = (id: string, path = `/repos/${id}`): Project => ({ id, name: `P ${id}`, location: { kind: "local", path } });
const host = (id: string): SshHost => ({ id, name: `H ${id}`, hostname: `${id}.example`, source: "kokpit" });
const tool = (id: string): Tool => ({ id, name: `T ${id}`, command: id });

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kokpit-store-"));
  file = join(dir, "state.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const readDisk = () => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
const EMPTY = { version: 2, projects: [], sshHosts: [], tools: [], cards: [], terminals: [], seeded: [], settings: {} };

// Same contract for the file store and the in-memory store (the one test fake).
const variants: [string, () => StateStore][] = [
  ["file", () => createFileStore(file, memLogger().logger)],
  ["memory", () => createMemoryStore()],
];

describe.each(variants)("StateStore contract (%s)", (_name, make) => {
  it("starts empty", () => {
    const s = make();
    expect(s.listProjects()).toEqual([]);
    expect(s.listSshHosts()).toEqual([]);
    expect(s.listTools()).toEqual([]);
    expect(s.listCards()).toEqual([]);
    expect(s.listTerminals()).toEqual([]);
    expect(s.isSeeded("x")).toBe(false);
  });

  it("upserts, gets and removes projects, hosts and tools", () => {
    const s = make();
    s.upsertProject(project("a"));
    s.upsertProject(project("b"));
    s.upsertProject({ ...project("a"), name: "renamed" });
    expect(s.listProjects().map((p) => [p.id, p.name])).toEqual([["a", "renamed"], ["b", "P b"]]);
    expect(s.getProject("a")?.name).toBe("renamed");
    expect(s.getProject("zz")).toBeUndefined();
    s.removeProject("a");
    s.removeProject("missing");
    expect(s.listProjects()).toEqual([project("b")]);

    s.upsertSshHost(host("h"));
    expect(s.getSshHost("h")).toEqual(host("h"));
    s.removeSshHost("h");
    expect(s.listSshHosts()).toEqual([]);

    s.upsertTool(tool("claude"));
    expect(s.getTool("claude")).toEqual(tool("claude"));
    expect(s.listTools()).toEqual([tool("claude")]);
    s.removeTool("claude");
    expect(s.getTool("claude")).toBeUndefined();
  });

  it("rejects invalid records with INVALID", () => {
    const s = make();
    expect(() => s.upsertProject({ ...project("a"), location: { kind: "local", path: "rel" } })).toThrow(
      expect.objectContaining({ code: "INVALID" }),
    );
    expect(() => s.upsertProject({ ...project("a"), id: "" })).toThrow();
    expect(() => s.upsertSshHost({ ...host("h"), port: 70000 })).toThrow();
    expect(() => s.upsertSshHost({ ...host("h"), source: "ssh-config" })).toThrow(expect.objectContaining({ code: "INVALID" }));
    expect(() => s.upsertTool({ ...tool("t"), command: 5 as never })).toThrow();
    expect(() => s.upsertTerminal({ ...term("t", "p"), status: "zombie" as never })).toThrow();
    expect(() => s.upsertTerminal({ ...term("t", "p"), projectId: undefined as never })).toThrow();
    expect(() => s.addCard({ ...card("x"), id: "" })).toThrow();
    s.addCard(card("a"));
    expect(() => s.addCard(card("a"))).toThrow(/a/);
    expect(s.listProjects()).toEqual([]);
    expect(s.listCards()).toEqual([card("a")]);
  });

  it("filters cards by project and terminals by card or project", () => {
    const s = make();
    s.addCard(card("a", "p1"));
    s.addCard(card("b", "p2"));
    expect(s.listCards("p2")).toEqual([card("b", "p2")]);
    s.upsertTerminal(term("t1", "p1", "a"));
    s.upsertTerminal(term("t2", "p1"));
    s.upsertTerminal(term("t3", "p2", "b"));
    s.upsertTerminal(term("t1", "p1", "a", "exited"));
    expect(s.getTerminal("t1")).toEqual(term("t1", "p1", "a", "exited"));
    expect(s.listTerminals({ cardId: "a" }).map((t) => t.id)).toEqual(["t1"]);
    expect(s.listTerminals({ projectId: "p1" }).map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(s.listTerminals({ projectId: "p1", cardId: "a" }).map((t) => t.id)).toEqual(["t1"]);
    expect(s.listTerminals({}).length).toBe(3);
    expect(s.listTerminals().length).toBe(3);
    s.removeTerminal("t1");
    s.removeTerminal("missing");
    expect(s.listTerminals().map((t) => t.id)).toEqual(["t2", "t3"]);
  });

  it("returns copies, not internal references", () => {
    const s = make();
    const p = project("a");
    s.upsertProject(p);
    p.name = "mutated input";
    (p.location as { path: string }).path = "/mutated";
    s.getProject("a")!.name = "mutated get";
    (s.listProjects()[0]!.location as { path: string }).path = "/mutated-list";
    const c = card("a");
    s.addCard(c);
    c.name = "x";
    s.getCard("a")!.name = "y";
    s.listCards()[0]!.name = "z";
    s.upsertTerminal(term("t", "a"));
    s.getTerminal("t")!.title = "x";
    s.listTerminals()[0]!.title = "y";
    s.upsertTool(tool("t"));
    s.getTool("t")!.command = "rm";
    s.upsertSshHost(host("h"));
    s.listSshHosts()[0]!.hostname = "evil";
    expect(s.getProject("a")).toEqual(project("a"));
    expect(s.getCard("a")!.name).toBe("Card a");
    expect(s.getTerminal("t")!.title).toBe("t t");
    expect(s.getTool("t")!.command).toBe("t");
    expect(s.getSshHost("h")!.hostname).toBe("h.example");
  });

  it("settings start empty and merge patches; null is kept (explicitly no default tool)", () => {
    const s = make();
    expect(s.getSettings()).toEqual({});
    s.updateSettings({ defaultToolId: "claude" });
    expect(s.getSettings()).toEqual({ defaultToolId: "claude" });
    s.updateSettings({});
    expect(s.getSettings()).toEqual({ defaultToolId: "claude" });
    s.updateSettings({ defaultToolId: null });
    expect(s.getSettings()).toEqual({ defaultToolId: null });
    s.getSettings().defaultToolId = "evil";
    expect(s.getSettings()).toEqual({ defaultToolId: null });
  });

  it("rejects invalid settings with INVALID", () => {
    const s = make();
    for (const bad of [{ defaultToolId: "" }, { defaultToolId: 5 }, { other: 1 }]) {
      expect(() => s.updateSettings(bad as never)).toThrow(EngineError);
    }
    expect(s.getSettings()).toEqual({});
  });

  it("tracks seed keys", () => {
    const s = make();
    s.markSeeded("builtin-project");
    s.markSeeded("builtin-project");
    expect(s.isSeeded("builtin-project")).toBe(true);
    expect(s.isSeeded("config-projects")).toBe(false);
  });
});

describe("createFileStore", () => {
  it("does not create the file until the first mutation", () => {
    createFileStore(file, memLogger().logger);
    expect(existsSync(file)).toBe(false);
  });

  it("persists every mutation in the v2 format before returning", () => {
    const s = createFileStore(file, memLogger().logger);
    s.addCard(card("a", "p1"));
    expect(readDisk()).toEqual({ ...EMPTY, cards: [card("a", "p1")] });
    s.upsertProject(project("p1"));
    s.upsertSshHost(host("h"));
    s.upsertTool(tool("t"));
    s.upsertTerminal(term("t1", "p1"));
    s.markSeeded("k");
    expect(readDisk()).toEqual({
      version: 2,
      projects: [project("p1")],
      sshHosts: [host("h")],
      tools: [tool("t")],
      cards: [card("a", "p1")],
      terminals: [term("t1", "p1")],
      seeded: ["k"],
      settings: {},
    });
    s.removeCard("a");
    expect(readDisk().cards).toEqual([]);
  });

  it("writes atomically and leaves no temp files", () => {
    const s = createFileStore(file, memLogger().logger);
    for (let i = 0; i < 20; i++) s.upsertProject(project(`p${i}`));
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });

  it("keeps memory unchanged when the write fails", () => {
    const s = createFileStore(file, memLogger().logger);
    s.upsertProject(project("a"));
    rmSync(dir, { recursive: true, force: true });
    expect(() => s.upsertProject(project("b"))).toThrow();
    expect(() => s.markSeeded("k")).toThrow();
    expect(s.listProjects()).toEqual([project("a")]);
    expect(s.isSeeded("k")).toBe(false);
  });

  it("reloads state from disk", () => {
    const s = createFileStore(file, memLogger().logger);
    s.upsertProject(project("p1"));
    s.upsertSshHost(host("h"));
    s.upsertTool(tool("t"));
    s.addCard(card("a"));
    s.upsertTerminal(term("t", "p1", "a"));
    s.markSeeded("k");
    const r = createFileStore(file, memLogger().logger);
    expect(r.listProjects()).toEqual([project("p1")]);
    expect(r.listSshHosts()).toEqual([host("h")]);
    expect(r.listTools()).toEqual([tool("t")]);
    expect(r.listCards()).toEqual([card("a")]);
    expect(r.listTerminals()).toEqual([term("t", "p1", "a")]);
    expect(r.isSeeded("k")).toBe(true);
  });

  it("persists settings, including an explicit null, across reopen", () => {
    const s = createFileStore(file, memLogger().logger);
    s.updateSettings({ defaultToolId: "claude" });
    expect(readDisk().settings).toEqual({ defaultToolId: "claude" });
    expect(createFileStore(file, memLogger().logger).getSettings()).toEqual({ defaultToolId: "claude" });
    s.updateSettings({ defaultToolId: null });
    expect(readDisk().settings).toEqual({ defaultToolId: null });
    expect(createFileStore(file, memLogger().logger).getSettings()).toEqual({ defaultToolId: null });
  });

  it("reads an older v2 file without settings as empty settings, keeping everything else", () => {
    const { settings: _s, ...old } = EMPTY;
    writeFileSync(file, JSON.stringify({ ...old, tools: [tool("t")], seeded: ["default-tools"] }));
    const { logger, warns } = memLogger();
    const s = createFileStore(file, logger);
    expect(s.getSettings()).toEqual({});
    expect(s.listTools()).toEqual([tool("t")]);
    expect(s.isSeeded("default-tools")).toBe(true);
    expect(warns).toEqual([]);
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });

  describe("v1 migration", () => {
    const v1Term = (id: string, cardId: string): Record<string, unknown> => {
      const { projectId: _p, ...rest } = term(id, "ignored", cardId);
      return rest;
    };

    it("takes projectId from the card, drops orphan terminals with a warning, rewrites as v2", () => {
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          cards: [card("a", "p1"), card("b", "p2")],
          terminals: [v1Term("t1", "a"), v1Term("t2", "b"), v1Term("t3", "gone")],
        }),
      );
      const { logger, warns } = memLogger();
      const s = createFileStore(file, logger);
      expect(s.listCards()).toEqual([card("a", "p1"), card("b", "p2")]);
      expect(s.listTerminals()).toEqual([term("t1", "p1", "a"), term("t2", "p2", "b")]);
      expect(s.listProjects()).toEqual([]);
      expect(warns.some((w) => /t3|terminal/.test(w))).toBe(true);
      expect(readDisk()).toEqual({
        ...EMPTY,
        cards: [card("a", "p1"), card("b", "p2")],
        terminals: [term("t1", "p1", "a"), term("t2", "p2", "b")],
      });
      expect(readdirSync(dir).filter((f) => f.includes("corrupt"))).toEqual([]);
    });

    it("monkey: random v1 data migrates losslessly for terminals with a card", () => {
      let seed = 42;
      const rnd = (n: number) => {
        seed = (seed * 48271) % 2147483647;
        return seed % n;
      };
      for (let round = 0; round < 30; round++) {
        const cards = new Map<string, Card>();
        for (let i = 0; i < rnd(8); i++) {
          const c = card(`c${rnd(10)}`, `p${rnd(3)}`);
          cards.set(c.id, c);
        }
        const terms = new Map<string, Record<string, unknown>>();
        for (let i = 0; i < rnd(12); i++) {
          const id = `t${rnd(15)}`;
          terms.set(id, v1Term(id, `c${rnd(12)}`));
        }
        writeFileSync(file, JSON.stringify({ version: 1, cards: [...cards.values()], terminals: [...terms.values()] }));
        const { logger, warns } = memLogger();
        const s = createFileStore(file, logger);
        const expected = [...terms.values()]
          .filter((t) => cards.has(t.cardId as string))
          .map((t) => ({ ...t, projectId: cards.get(t.cardId as string)!.projectId }));
        expect(s.listCards()).toEqual([...cards.values()]);
        expect(s.listTerminals()).toEqual(expected);
        expect(warns.length).toBe(expected.length < terms.size ? 1 : 0);
        expect(createFileStore(file, memLogger().logger).listTerminals()).toEqual(expected);
        expect(readDisk().version).toBe(2);
        rmSync(file);
      }
    });
  });

  describe("corrupt files are moved aside", () => {
    const bad = [
      "{ not json",
      "",
      "null",
      "[]",
      JSON.stringify({ ...EMPTY, version: 3 }),
      JSON.stringify({ ...EMPTY, version: 2, cards: [{ id: 1 }] }),
      JSON.stringify({ version: 2, cards: [] }),
      JSON.stringify({ ...EMPTY, cards: [card("a"), card("a")] }),
      JSON.stringify({ ...EMPTY, projects: [project("a"), project("a")] }),
      JSON.stringify({ ...EMPTY, terminals: [{ ...term("t", "a"), status: "nope" }] }),
      JSON.stringify({ ...EMPTY, terminals: [{ ...term("t", "a"), projectId: undefined }] }),
      JSON.stringify({ ...EMPTY, seeded: [1] }),
      JSON.stringify({ ...EMPTY, settings: { defaultToolId: "" } }),
      JSON.stringify({ ...EMPTY, settings: [] }),
      JSON.stringify({ version: 1, cards: [{ id: 1 }], terminals: [] }),
      JSON.stringify({ version: 1, cards: [] }),
    ];
    for (const raw of bad) {
      it(JSON.stringify(raw).slice(0, 70), () => {
        writeFileSync(file, raw);
        const { logger, warns } = memLogger();
        const s = createFileStore(file, logger);
        expect(s.listCards()).toEqual([]);
        expect(s.listProjects()).toEqual([]);
        expect(warns.length).toBeGreaterThan(0);
        const aside = readdirSync(dir).filter((f) => f.startsWith("state.json.corrupt-"));
        expect(aside).toHaveLength(1);
        expect(readFileSync(join(dir, aside[0]!), "utf8")).toBe(raw);
        expect(existsSync(file)).toBe(false);
        s.addCard(card("ok"));
        expect(readDisk().cards).toEqual([card("ok")]);
      });
    }
  });

  it("monkey: random operations match an in-memory model, also after reopen", () => {
    let seed = 1234567;
    const rnd = (n: number) => {
      seed = (seed * 48271) % 2147483647;
      return seed % n;
    };
    const s = createFileStore(file, memLogger().logger);
    const projects = new Map<string, Project>();
    const cards = new Map<string, Card>();
    const terms = new Map<string, TerminalInfo>();
    const pids = ["p1", "p2", "p3"];
    const sortById = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id));
    for (let i = 0; i < 400; i++) {
      const cid = `c${rnd(15)}`;
      const tid = `t${rnd(25)}`;
      const pid = pids[rnd(3)]!;
      switch (rnd(6)) {
        case 0: {
          const c = card(cid, pid);
          if (cards.has(cid)) expect(() => s.addCard(c)).toThrow();
          else {
            s.addCard(c);
            cards.set(cid, c);
          }
          break;
        }
        case 1:
          s.removeCard(cid);
          cards.delete(cid);
          break;
        case 2: {
          const t = term(tid, pid, rnd(2) ? cid : undefined, rnd(2) ? "running" : "exited");
          s.upsertTerminal(t);
          terms.set(tid, t);
          break;
        }
        case 3:
          s.removeTerminal(tid);
          terms.delete(tid);
          break;
        case 4: {
          const p = project(pid, `/r/${rnd(100)}`);
          s.upsertProject(p);
          projects.set(pid, p);
          break;
        }
        case 5:
          s.removeProject(pid);
          projects.delete(pid);
          break;
      }
      expect(sortById(s.listProjects())).toEqual(sortById([...projects.values()]));
      expect(sortById(s.listCards())).toEqual(sortById([...cards.values()]));
      expect(sortById(s.listTerminals())).toEqual(sortById([...terms.values()]));
      expect(sortById(s.listCards(pid))).toEqual(sortById([...cards.values()].filter((c) => c.projectId === pid)));
      expect(sortById(s.listTerminals({ cardId: cid }))).toEqual(
        sortById([...terms.values()].filter((t) => t.cardId === cid)),
      );
      expect(sortById(s.listTerminals({ projectId: pid }))).toEqual(
        sortById([...terms.values()].filter((t) => t.projectId === pid)),
      );
    }
    const r = createFileStore(file, memLogger().logger);
    expect(r.listProjects()).toEqual(s.listProjects());
    expect(r.listCards()).toEqual(s.listCards());
    expect(r.listTerminals()).toEqual(s.listTerminals());
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });
});
