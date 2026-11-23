// İş W — Akış: which folder a flow.* request reads (project, card worktree), and who has none.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Card, Project } from "@kokpit/shared";
import { EngineError } from "../contracts.ts";
import { createFlowService, loadFlowConfig } from "../flow.ts";
import { createFlowHandlers } from "./flow.ts";

let base: string;
let handlers: ReturnType<typeof createFlowHandlers>;
const projects = new Map<string, Project>();
const cards = new Map<string, Card>();
const COMMAND = "claude 'akış çiz'";

const requireProject = (id: string): Project => {
  const p = projects.get(id);
  if (!p) throw new EngineError("NOT_FOUND", "yok");
  return p;
};
const requireCard = (id: string): Card => {
  const c = cards.get(id);
  if (!c) throw new EngineError("NOT_FOUND", "yok");
  return c;
};

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-flowh-")));
  mkdirSync(join(base, "proje", "docs", "akis"), { recursive: true });
  mkdirSync(join(base, "kart", "docs", "akis"), { recursive: true });
  writeFileSync(join(base, "proje", "docs", "akis", "proje.mmd"), "flowchart TD\n  P");
  writeFileSync(join(base, "kart", "docs", "akis", "kart.mmd"), "flowchart TD\n  K");
  projects.set("pl", { id: "pl", name: "Yerel", location: { kind: "local", path: join(base, "proje") } });
  projects.set("pn", { id: "pn", name: "Klonsuz", location: { kind: "github", url: "https://github.com/a/c" } });
  projects.set("ps", { id: "ps", name: "Uzak", location: { kind: "ssh", hostId: "h1", path: join(base, "proje") } });
  cards.set("c1", { id: "c1", projectId: "pl", name: "Kart", branch: "kokpit/kart", worktreePath: join(base, "kart"), createdAt: "" });
  handlers = createFlowHandlers({
    flow: createFlowService({ config: { ...loadFlowConfig({}, { flowPromptFile: "'/x'" }), updateCommand: COMMAND } }),
    requireProject,
    requireCard,
  });
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

function err(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (e) {
    if (e instanceof EngineError) return { code: e.code, message: e.message };
    throw e;
  }
  throw new Error("expected an EngineError");
}

describe("flow handlers", () => {
  it("info: folder and update command for projects and cards", () => {
    expect(handlers["flow.info"](null, { projectId: "pl" })).toEqual({ available: true, dir: "docs/akis", updateCommand: COMMAND });
    expect(handlers["flow.info"](null, { cardId: "c1" })).toEqual({ available: true, dir: "docs/akis", updateCommand: COMMAND });
  });

  it("list / read the project folder and a card's worktree", () => {
    expect(handlers["flow.list"](null, { projectId: "pl" }).flows.map((f) => f.id)).toEqual(["proje.mmd"]);
    expect(handlers["flow.list"](null, { cardId: "c1" }).flows.map((f) => f.id)).toEqual(["kart.mmd"]);
    expect(handlers["flow.read"](null, { projectId: "pl", id: "proje.mmd" })).toEqual({ text: "flowchart TD\n  P" });
    expect(handlers["flow.read"](null, { cardId: "c1", id: "kart.mmd" }).text).toContain("K");
    expect(err(() => handlers["flow.read"](null, { cardId: "c1", id: "proje.mmd" })).code).toBe("NOT_FOUND");
  });

  it("ssh projects: info says unavailable, list/read refuse with a Turkish note", () => {
    expect(handlers["flow.info"](null, { projectId: "ps" })).toEqual({ available: false });
    const e = err(() => handlers["flow.list"](null, { projectId: "ps" }));
    expect(e.code).toBe("INVALID");
    expect(e.message).toMatch(/SSH/);
    expect(err(() => handlers["flow.read"](null, { projectId: "ps", id: "proje.mmd" })).code).toBe("INVALID");
  });


  it("a github project not cloned yet: unavailable info, NOT_FOUND list", () => {
    expect(handlers["flow.info"](null, { projectId: "pn" })).toEqual({ available: false });
    expect(err(() => handlers["flow.list"](null, { projectId: "pn" })).code).toBe("NOT_FOUND");
  });

  it("unknown project or card → NOT_FOUND", () => {
    expect(err(() => handlers["flow.list"](null, { projectId: "nope" })).code).toBe("NOT_FOUND");
    expect(err(() => handlers["flow.read"](null, { cardId: "nope", id: "a.mmd" })).code).toBe("NOT_FOUND");
  });

  it("disabled service answers unavailable / INVALID", () => {
    const off = createFlowHandlers({ flow: undefined, requireProject, requireCard });
    expect(off["flow.info"](null, { projectId: "pl" })).toEqual({ available: false });
    expect(err(() => off["flow.list"](null, { projectId: "pl" })).code).toBe("INVALID");
  });
});
