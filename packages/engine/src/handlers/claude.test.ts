// İş C (Adım 8) — claude.inventory handlers: which folder is the project part (project, card worktree), who has
// none (SSH, not cloned: user part only, with a note), and which config dir is asked for.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_MESSAGE_BYTES, type Card, type Project } from "@kokpit/shared";
import { createClaudeInventory, loadClaudeInventoryConfig } from "../claude-inventory.ts";
import { EngineError } from "../contracts.ts";
import { createClaudeHandlers } from "./claude.ts";

let base: string;
let handlers: ReturnType<typeof createClaudeHandlers>;
const projects = new Map<string, Project>();
const cards = new Map<string, Card>();
const asked: string[] = [];

const put = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-claudeh-")));
  put(join(base, "proje", ".claude", "agents", "proje-ajani.md"), "---\nname: proje-ajani\n---\n");
  put(join(base, "kart", ".claude", "agents", "kart-ajani.md"), "---\nname: kart-ajani\n---\n");
  put(join(base, "home", ".claude", "agents", "kullanici-ajani.md"), "---\nname: kullanici-ajani\n---\n");
  put(join(base, "work", "agents", "work-ajani.md"), "---\nname: work-ajani\n---\n");
  projects.set("pl", { id: "pl", name: "Yerel", location: { kind: "local", path: join(base, "proje") } });
  projects.set("pk", { id: "pk", name: "Work", location: { kind: "local", path: join(base, "proje") } });
  projects.set("pn", { id: "pn", name: "Klonsuz", location: { kind: "github", url: "https://github.com/a/c" } });
  projects.set("ps", { id: "ps", name: "Uzak", location: { kind: "ssh", hostId: "h1", path: join(base, "proje") } });
  cards.set("c1", { id: "c1", projectId: "pl", name: "Kart", branch: "kokpit/kart", worktreePath: join(base, "kart"), createdAt: "" });
  handlers = createClaudeHandlers({
    inventory: createClaudeInventory({
      config: loadClaudeInventoryConfig({}),
      homeDir: join(base, "home"),
      configDirFor: (p) => {
        asked.push(p.id);
        return p.id === "pk" ? join(base, "work") : join(base, "home", ".claude");
      },
    }),
    requireProject: (id) => {
      const p = projects.get(id);
      if (!p) throw new EngineError("NOT_FOUND", "yok");
      return p;
    },
    requireCard: (id) => {
      const c = cards.get(id);
      if (!c) throw new EngineError("NOT_FOUND", "yok");
      return c;
    },
  });
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

const names = (r: { items: { name: string }[] }) => r.items.map((i) => i.name);

describe("claude handlers", () => {
  it("project: project part + the project's account", () => {
    const r = handlers["claude.inventory"](null, { projectId: "pl" });
    expect(names(r)).toEqual(["proje-ajani", "kullanici-ajani"]);
    expect(r.note).toBeUndefined();
    expect(handlers["claude.inventory.read"](null, { projectId: "pl", id: "project:agents/proje-ajani.md" }).text).toContain("proje-ajani");
  });

  it("asks configDirFor with the project (another account → another user part)", () => {
    asked.length = 0;
    expect(names(handlers["claude.inventory"](null, { projectId: "pk" }))).toEqual(["proje-ajani", "work-ajani"]);
    expect(asked).toEqual(["pk"]);
  });

  it("card: the worktree is the project part, the card's project picks the account", () => {
    asked.length = 0;
    expect(names(handlers["claude.inventory"](null, { cardId: "c1" }))).toEqual(["kart-ajani", "kullanici-ajani"]);
    expect(asked).toEqual(["pl"]);
  });

  it.each([
    ["ps", /SSH/],
    ["pn", /klonlanmadı/],
  ])("%s: only the user part, with a Turkish note", (projectId, note) => {
    const r = handlers["claude.inventory"](null, { projectId });
    expect(names(r)).toEqual(["kullanici-ajani"]);
    expect(r.note).toMatch(note);
    expect(r.claudeMd.project).toBeUndefined();
    expect(() => handlers["claude.inventory.read"](null, { projectId, id: "project:agents/proje-ajani.md" })).toThrow(EngineError);
    expect(handlers["claude.inventory.read"](null, { projectId, id: "user:agents/kullanici-ajani.md" }).text).toContain("kullanici");
  });

  it("an inventory too large for one frame is cut to what fits and reported as truncated", () => {
    // Inside every default cap (items, description length) — and still more than a frame.
    const cfg = loadClaudeInventoryConfig({});
    const count = Math.ceil((1.2 * MAX_MESSAGE_BYTES) / cfg.maxDescriptionChars);
    expect(count).toBeLessThan(cfg.maxItems);
    for (let n = 0; n < count; n++) {
      put(join(base, "buyuk", ".claude", "agents", `ajan-${String(n).padStart(5, "0")}.md`), `---\nname: ajan-${n}\ndescription: ${"d".repeat(cfg.maxDescriptionChars)}\n---\n`);
    }
    projects.set("pb", { id: "pb", name: "Büyük", location: { kind: "local", path: join(base, "buyuk") } });
    const r = handlers["claude.inventory"](null, { projectId: "pb" });
    const frame = JSON.stringify({ type: "res", id: Number.MAX_SAFE_INTEGER, ok: true, result: r });
    expect(frame.length).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(r.truncated).toBe(true);
    expect(r.items.length).toBeGreaterThan(count / 2);
    expect(r.items.length).toBeLessThan(count);
    expect(r.claudeMd).toBeDefined();
  });

  it("disabled engine answers INVALID; unknown targets NOT_FOUND", () => {
    const off = createClaudeHandlers({ inventory: undefined, requireProject: () => projects.get("pl")!, requireCard: () => cards.get("c1")! });
    expect(() => off["claude.inventory"](null, { projectId: "pl" })).toThrow(/kapalı/);
    expect(() => handlers["claude.inventory"](null, { projectId: "yok" })).toThrow(EngineError);
  });
});
