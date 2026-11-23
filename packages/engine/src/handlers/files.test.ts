// İş F — Dosyalar: which folder a files.* request browses (project, card worktree), and who has none.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Card, Project } from "@kokpit/shared";
import { EngineError } from "../contracts.ts";
import { isFilesMediaTokenPath } from "@kokpit/shared";
import { createFileService, loadFilesConfig } from "../files.ts";
import { createMediaService, type MediaService } from "../files-media.ts";
import { FakeLogger } from "../../test/fakes/server-fakes.ts";
import { createFilesHandlers } from "./files.ts";

let base: string;
let handlers: ReturnType<typeof createFilesHandlers>;
let media: MediaService;
const PNG = Buffer.from("89504e470d0a1a0a0000000d", "hex");
const connA = { conn: { id: "a" } };
const connB = { conn: { id: "b" } };
const projects = new Map<string, Project>();
const cards = new Map<string, Card>();

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-filesh-")));
  mkdirSync(join(base, "proje"));
  mkdirSync(join(base, "kart"));
  writeFileSync(join(base, "proje", "proje.txt"), "proje");
  writeFileSync(join(base, "kart", "kart.txt"), "kart");
  writeFileSync(join(base, "proje", "resim.png"), PNG);
  writeFileSync(join(base, "kart", "kart.png"), PNG);
  projects.set("pl", { id: "pl", name: "Yerel", location: { kind: "local", path: join(base, "proje") } });
  projects.set("pg", { id: "pg", name: "GitHub", location: { kind: "github", url: "https://github.com/a/b", path: join(base, "proje") } });
  projects.set("pn", { id: "pn", name: "Klonsuz", location: { kind: "github", url: "https://github.com/a/c" } });
  projects.set("ps", { id: "ps", name: "Uzak", location: { kind: "ssh", hostId: "h1", path: join(base, "proje") } });
  cards.set("c1", { id: "c1", projectId: "pl", name: "Kart", branch: "kokpit/kart", worktreePath: join(base, "kart"), createdAt: "" });
  const config = loadFilesConfig({});
  const files = createFileService({ config });
  media = createMediaService({ config: config.media, resolve: files.resolve, logger: new FakeLogger() });
  handlers = createFilesHandlers({
    files,
    media,
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

const names = (r: { entries: { name: string }[] }) => r.entries.map((e) => e.name);
function err(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (e) {
    if (e instanceof EngineError) return { code: e.code, message: e.message };
    throw e;
  }
  throw new Error("expected an EngineError");
}

describe("files handlers", () => {
  it("browse the project folder (local and cloned github)", () => {
    expect(names(handlers["files.list"](null, { projectId: "pl", path: "" }))).toEqual(["proje.txt", "resim.png"]);
    expect(names(handlers["files.list"](null, { projectId: "pg", path: "" }))).toEqual(["proje.txt", "resim.png"]);
    expect(handlers["files.read"](null, { projectId: "pl", path: "proje.txt" })).toEqual({ text: "proje", size: 5, truncated: false });
  });

  it("browse a card's worktree", () => {
    expect(names(handlers["files.list"](null, { cardId: "c1", path: "" }))).toEqual(["kart.png", "kart.txt"]);
    expect(handlers["files.read"](null, { cardId: "c1", path: "kart.txt" }).text).toBe("kart");
  });

  it("ssh projects have no files here (Turkish note)", () => {
    const e = err(() => handlers["files.list"](null, { projectId: "ps", path: "" }));
    expect(e.code).toBe("INVALID");
    expect(e.message).toMatch(/SSH/);
    expect(err(() => handlers["files.read"](null, { projectId: "ps", path: "proje.txt" })).code).toBe("INVALID");
  });

  it("a github project that is not cloned yet has no folder", () => {
    expect(err(() => handlers["files.list"](null, { projectId: "pn", path: "" })).code).toBe("NOT_FOUND");
  });

  it("unknown project or card → NOT_FOUND", () => {
    expect(err(() => handlers["files.list"](null, { projectId: "nope", path: "" })).code).toBe("NOT_FOUND");
    expect(err(() => handlers["files.read"](null, { cardId: "nope", path: "x" })).code).toBe("NOT_FOUND");
  });

  it("a card cannot reach its project's folder through ..", () => {
    expect(err(() => handlers["files.read"](null, { cardId: "c1", path: "../proje/proje.txt" })).code).toBe("INVALID");
  });

  it("files.read names the media kind of a viewable file", () => {
    expect(handlers["files.read"](null, { projectId: "pl", path: "resim.png" })).toEqual({ binary: true, size: PNG.length, truncated: false, media: "image" });
    expect(handlers["files.read"](null, { projectId: "pl", path: "proje.txt" }).media).toBeUndefined();
  });

  it("files.mediaUrl issues a URL for the project's or the card's file, owned by the asking connection", () => {
    const p = handlers["files.mediaUrl"](connA, { projectId: "pl", path: "resim.png" });
    expect(isFilesMediaTokenPath(p.path)).toBe(true);
    expect(p).toMatchObject({ kind: "image", mime: "image/png", size: PNG.length });
    const c = handlers["files.mediaUrl"](connA, { cardId: "c1", path: "kart.png" });
    expect(c.path).not.toBe(p.path);
    expect(media.stats().tokens).toBe(2);
    // Another connection cannot end it; its owner can.
    expect(handlers["files.mediaRevoke"](connB, { path: p.path })).toEqual({});
    expect(media.stats().tokens).toBe(2);
    expect(handlers["files.mediaRevoke"](connA, { path: p.path })).toEqual({});
    expect(media.stats().tokens).toBe(1);
    media.revokeOwner(connA.conn);
    expect(media.stats().tokens).toBe(0);
  });

  it("files.mediaUrl refuses what files.read refuses, and types outside the allowlist", () => {
    const e = err(() => handlers["files.mediaUrl"](connA, { projectId: "ps", path: "resim.png" }));
    expect(e.code).toBe("INVALID");
    expect(e.message).toMatch(/SSH/);
    expect(err(() => handlers["files.mediaUrl"](connA, { projectId: "pn", path: "resim.png" })).code).toBe("NOT_FOUND");
    expect(err(() => handlers["files.mediaUrl"](connA, { projectId: "nope", path: "resim.png" })).code).toBe("NOT_FOUND");
    expect(err(() => handlers["files.mediaUrl"](connA, { cardId: "c1", path: "../proje/resim.png" })).code).toBe("INVALID");
    expect(err(() => handlers["files.mediaUrl"](connA, { projectId: "pl", path: "proje.txt" })).code).toBe("INVALID");
    expect(media.stats().tokens).toBe(0);
  });

  it("without a media service files.mediaUrl is INVALID and revoke is a no-op", () => {
    const off = createFilesHandlers({ files: createFileService({ config: loadFilesConfig({}) }), requireProject: () => projects.get("pl")!, requireCard: () => cards.get("c1")! });
    expect(err(() => off["files.mediaUrl"](connA, { projectId: "pl", path: "resim.png" })).code).toBe("INVALID");
    expect(off["files.mediaRevoke"](connA, { path: `/files/media/${"A".repeat(43)}` })).toEqual({});
  });

  it("without a file service every request is INVALID", () => {
    const off = createFilesHandlers({ files: undefined, requireProject: () => projects.get("pl")!, requireCard: () => cards.get("c1")! });
    expect(err(() => off["files.list"](null, { projectId: "pl", path: "" })).code).toBe("INVALID");
    expect(err(() => off["files.mediaUrl"](connA, { projectId: "pl", path: "resim.png" })).code).toBe("INVALID");
  });
});
