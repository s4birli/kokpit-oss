// Girişler: the state file keeps a login's METADATA only (id, project, site, username, label, dates) — the password
// is in the Keychain. The field is absent in files written before it and whenever empty, so older files load as
// "no logins" and files of users without logins keep their shape.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SavedLogin } from "@kokpit/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineError, type Logger } from "./contracts.ts";
import { createFileStore, createMemoryStore } from "./store.ts";

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
const AT = "2026-01-02T03:04:05.000Z";
const login = (id: string, projectId = "p1", over: Partial<SavedLogin> = {}): SavedLogin => ({
  id,
  projectId,
  origin: "https://ornek.example",
  username: `kullanıcı-${id}`,
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kokpit-store-logins-"));
  file = join(dir, "state.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe.each([
  ["file", () => createFileStore(file, logger)],
  ["memory", () => createMemoryStore()],
] as const)("logins (%s)", (_n, make) => {
  it("lists per project, gets by id, replaces by id and removes", () => {
    const s = make();
    expect(s.listLogins("p1")).toEqual([]);
    s.upsertLogin(login("a"));
    s.upsertLogin(login("b", "p2"));
    s.upsertLogin(login("c", "p1", { label: "İş" }));
    expect(s.listLogins("p1").map((l) => l.id)).toEqual(["a", "c"]);
    expect(s.listLogins("p2").map((l) => l.id)).toEqual(["b"]);
    expect(s.listLogins().map((l) => l.id)).toEqual(["a", "b", "c"]);
    s.upsertLogin(login("a", "p1", { username: "yeni" }));
    expect(s.getLogin("a")?.username).toBe("yeni");
    expect(s.listLogins().map((l) => l.id)).toEqual(["a", "b", "c"]);
    s.removeLogin("a");
    expect(s.getLogin("a")).toBeUndefined();
    s.removeLogin("yok");
    expect(s.listLogins().map((l) => l.id)).toEqual(["b", "c"]);
  });

  it("hands out copies", () => {
    const s = make();
    s.upsertLogin(login("a"));
    s.getLogin("a")!.username = "değişti";
    s.listLogins()[0]!.username = "değişti";
    expect(s.getLogin("a")?.username).toBe("kullanıcı-a");
  });

  it("refuses anything that is not login metadata — a password above all", () => {
    const s = make();
    for (const bad of [
      { ...login("a"), password: "gizli" },
      { ...login("a"), secret: "gizli" },
      { ...login("a"), origin: "https://ornek.example/yol" },
      { ...login("a"), origin: "ftp://x" },
      { ...login("a"), username: "" },
      { ...login("a"), id: "" },
    ]) {
      expect(() => s.upsertLogin(bad as SavedLogin), JSON.stringify(bad)).toThrow(EngineError);
    }
    expect(s.listLogins()).toEqual([]);
  });

  it("remembers per project that the user accepted the agent risk of filling; revocable", () => {
    const s = make();
    expect(s.isLoginRiskAccepted("p1")).toBe(false);
    s.setLoginRiskAccepted("p1", true);
    s.setLoginRiskAccepted("p1", true);
    s.setLoginRiskAccepted("p2", true);
    expect(s.isLoginRiskAccepted("p1")).toBe(true);
    s.setLoginRiskAccepted("p1", false);
    expect(s.isLoginRiskAccepted("p1")).toBe(false);
    expect(s.isLoginRiskAccepted("p2")).toBe(true);
    expect(() => s.setLoginRiskAccepted("", true)).toThrow(EngineError);
  });

  it("keeps the Keychain items that still have to be deleted (orphans)", () => {
    const s = make();
    expect(s.listLoginOrphans()).toEqual([]);
    s.setLoginOrphans([{ service: "dev.kokpit.login.p1", account: "a" }]);
    expect(s.listLoginOrphans()).toEqual([{ service: "dev.kokpit.login.p1", account: "a" }]);
    expect(() => s.setLoginOrphans([{ service: "a b", account: "a" }])).toThrow(EngineError);
    expect(() => s.setLoginOrphans([{ service: "s", account: "a", secret: "x" } as never])).toThrow(EngineError);
    s.setLoginOrphans([]);
    expect(s.listLoginOrphans()).toEqual([]);
  });
});

describe("logins in the state file", () => {
  it("survive a restart; empty lists are not written; the file never holds a password field", () => {
    const s = createFileStore(file, logger);
    s.markSeeded("x");
    expect(JSON.parse(readFileSync(file, "utf8"))).not.toHaveProperty("logins");
    expect(JSON.parse(readFileSync(file, "utf8"))).not.toHaveProperty("loginOrphans");
    s.upsertLogin(login("a", "p1", { label: "İş" }));
    s.setLoginOrphans([{ service: "dev.kokpit.login.p9", account: "z" }]);
    s.setLoginRiskAccepted("p1", true);
    const again = createFileStore(file, logger);
    expect(again.isLoginRiskAccepted("p1")).toBe(true);
    again.setLoginRiskAccepted("p1", false);
    expect(JSON.parse(readFileSync(file, "utf8"))).not.toHaveProperty("loginRiskAccepted");
    expect(again.listLogins()).toEqual([login("a", "p1", { label: "İş" })]);
    expect(again.listLoginOrphans()).toEqual([{ service: "dev.kokpit.login.p9", account: "z" }]);
    const text = readFileSync(file, "utf8");
    expect(text).not.toMatch(/password|parola|secret/i);
    again.removeLogin("a");
    again.setLoginOrphans([]);
    expect(JSON.parse(readFileSync(file, "utf8"))).not.toHaveProperty("logins");
  });

  it("a file written before logins existed loads as 'no logins' and is not rewritten or moved aside", () => {
    const old = { version: 2, projects: [], sshHosts: [], tools: [], cards: [], terminals: [], seeded: ["x"] };
    writeFileSync(file, JSON.stringify(old));
    const s = createFileStore(file, logger);
    expect(s.listLogins()).toEqual([]);
    expect(s.isSeeded("x")).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(old);
  });

  it("refuses two logins with one id in a file", () => {
    const warned: string[] = [];
    writeFileSync(file, JSON.stringify({ version: 2, projects: [], sshHosts: [], tools: [], cards: [], terminals: [], seeded: [], logins: [login("a"), login("a")] }));
    const s = createFileStore(file, { ...logger, warn: (m) => warned.push(m), error: (m) => warned.push(m) });
    expect(s.listLogins()).toEqual([]);
    expect(warned.length).toBeGreaterThan(0);
  });
});
