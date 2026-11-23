import { describe, expect, it } from "vitest";
import {
  CLOSE_CODES,
  MAX_MESSAGE_BYTES,
  parseClientMessage,
  parseServerMessage,
  ProjectSchema,
  SettingsSchema,
  SshHostSchema,
  TerminalInfoSchema,
  ToolSchema,
  type ClientMessage,
} from "./protocol.ts";

const NONCE = "n".repeat(43);
const PROOF = "p".repeat(43);

describe("adım 2: projeler, sunucular, araçlar", () => {
  const ok = (m: unknown) => parseClientMessage(JSON.stringify(m)).ok;
  const req = (method: string, params: unknown) => ({ type: "req", id: 1, method, params });

  it("accepts project CRUD with every location kind", () => {
    expect(ok(req("projects.create", { name: "Acme", location: { kind: "local", path: "/x/Acme" } }))).toBe(true);
    expect(ok(req("projects.create", { name: "Gh", location: { kind: "github", url: "https://github.com/a/b.git" }, defaultToolId: "claude" }))).toBe(true);
    expect(ok(req("projects.create", { name: "Gh2", location: { kind: "github", url: "git@github.com:a/b.git" } }))).toBe(true);
    expect(ok(req("projects.create", { name: "Oracle", location: { kind: "ssh", hostId: "oracle", path: "/home/ubuntu/app" } }))).toBe(true);
    expect(ok(req("projects.create", { name: "Oracle", location: { kind: "ssh", hostId: "oracle" } }))).toBe(true);
    expect(ok(req("projects.update", { projectId: "p", name: "Yeni ad", defaultToolId: null }))).toBe(true);
    expect(ok(req("projects.delete", { projectId: "p" }))).toBe(true);
  });

  it.each([
    ["relative local path", { name: "x", location: { kind: "local", path: "rel/path" } }],
    ["unknown kind", { name: "x", location: { kind: "ftp", path: "/x" } }],
    ["empty name", { name: " ", location: { kind: "local", path: "/x" } }],
    ["bad github url", { name: "x", location: { kind: "github", url: "file:///etc" } }],
    ["github url option injection", { name: "x", location: { kind: "github", url: "--upload-pack=touch /tmp/x" } }],
    ["client-chosen github path", { name: "x", location: { kind: "github", url: "https://github.com/a/b", path: "/tmp" } }],
  ])("rejects project create: %s", (_n, params) => {
    expect(ok(req("projects.create", params))).toBe(false);
  });

  it("accepts ssh host CRUD and key listing", () => {
    expect(ok(req("sshHosts.list", {}))).toBe(true);
    expect(ok(req("sshKeys.list", {}))).toBe(true);
    expect(ok(req("sshHosts.create", { name: "Build box", hostname: "100.1.2.3", user: "deploy", port: 22, identityFile: "id_ed25519_build" }))).toBe(true);
    expect(ok(req("sshHosts.create", { name: "Min", hostname: "server.example.com" }))).toBe(true);
    expect(ok(req("sshHosts.update", { hostId: "h", port: 2222 }))).toBe(true);
    expect(ok(req("sshHosts.delete", { hostId: "h" }))).toBe(true);
  });

  it.each([
    ["hostname option injection", { name: "x", hostname: "-oProxyCommand=evil" }],
    ["hostname with space", { name: "x", hostname: "a b" }],
    ["hostname with shell char", { name: "x", hostname: "a;rm -rf /" }],
    ["user option injection", { name: "x", hostname: "h", user: "-l" }],
    ["port 0", { name: "x", hostname: "h", port: 0 }],
    ["port too big", { name: "x", hostname: "h", port: 70000 }],
    ["key path traversal", { name: "x", hostname: "h", identityFile: "../../etc/passwd" }],
    ["key absolute path", { name: "x", hostname: "h", identityFile: "/etc/ssh/ssh_host_key" }],
    ["key with slash", { name: "x", hostname: "h", identityFile: "sub/id" }],
  ])("rejects ssh host: %s", (_n, params) => {
    expect(ok(req("sshHosts.create", params))).toBe(false);
  });

  it("accepts tool CRUD, check and install", () => {
    expect(ok(req("tools.list", {}))).toBe(true);
    expect(ok(req("tools.check", {}))).toBe(true);
    expect(ok(req("tools.create", { name: "Gemini", command: "command gemini", installCommand: "npm i -g @google/gemini-cli", checkCommand: "command -v gemini" }))).toBe(true);
    expect(ok(req("tools.update", { toolId: "t", command: "claude --dangerously-skip-permissions" }))).toBe(true);
    expect(ok(req("tools.delete", { toolId: "t" }))).toBe(true);
    expect(ok(req("tools.install", { toolId: "t", cols: 80, rows: 24 }))).toBe(true);
    expect(ok(req("tools.create", { name: "x", command: "" }))).toBe(false);
  });

  it("opens terminals on a card or directly on a project, optionally with a tool", () => {
    expect(ok(req("terminal.open", { cardId: "c", cols: 80, rows: 24 }))).toBe(true);
    expect(ok(req("terminal.open", { projectId: "p", cols: 80, rows: 24, toolId: "claude" }))).toBe(true);
    expect(ok(req("terminal.open", { projectId: "p", cols: 80, rows: 24, command: "ls" }))).toBe(true);
    expect(ok(req("terminal.open", { cols: 80, rows: 24 }))).toBe(false);
    expect(ok(req("terminal.open", { cardId: "c", projectId: "p", cols: 80, rows: 24 }))).toBe(false);
    expect(ok(req("terminals.list", { projectId: "p" }))).toBe(true);
    expect(ok(req("terminals.list", { cardId: "c" }))).toBe(true);
    expect(ok(req("terminals.list", {}))).toBe(false);
    expect(ok(req("terminals.list", { cardId: "c", projectId: "p" }))).toBe(false);
  });

  it("server events for projects, hosts, tools and project terminals", () => {
    const sv = (m: unknown) => parseServerMessage(JSON.stringify(m)).ok;
    expect(sv({ type: "event", name: "projects.changed" })).toBe(true);
    expect(sv({ type: "event", name: "sshHosts.changed" })).toBe(true);
    expect(sv({ type: "event", name: "tools.changed" })).toBe(true);
    expect(sv({ type: "event", name: "terminals.changed", projectId: "p" })).toBe(true);
    expect(sv({ type: "event", name: "terminals.changed", projectId: "p", cardId: "c" })).toBe(true);
  });

  it("domain schemas", () => {
    expect(ProjectSchema.safeParse({ id: "p", name: "P", location: { kind: "local", path: "/x" } }).success).toBe(true);
    expect(TerminalInfoSchema.safeParse({ id: "t", projectId: "p", title: "zsh", status: "running", createdAt: "x" }).success).toBe(true);
    expect(SshHostSchema.safeParse({ id: "oracle", name: "oracle", hostname: "oracle", source: "ssh-config" }).success).toBe(true);
    expect(ToolSchema.safeParse({ id: "claude", name: "Claude", command: "claude" }).success).toBe(true);
  });
});

describe("genel ayarlar: varsayılan araç", () => {
  const ok = (m: unknown) => parseClientMessage(JSON.stringify(m)).ok;
  const req = (method: string, params: unknown) => ({ type: "req", id: 1, method, params });

  it("accepts settings.get and settings.update with a tool id or null (plain shell)", () => {
    expect(ok(req("settings.get", {}))).toBe(true);
    expect(ok(req("settings.update", { defaultToolId: "claude" }))).toBe(true);
    expect(ok(req("settings.update", { defaultToolId: null }))).toBe(true);
  });

  it.each([
    ["get with params", "settings.get", { x: 1 }],
    ["update without field", "settings.update", {}],
    ["update empty id", "settings.update", { defaultToolId: "" }],
    ["update numeric id", "settings.update", { defaultToolId: 5 }],
    ["update unknown field", "settings.update", { defaultToolId: "a", theme: "dark" }],
    ["update too long id", "settings.update", { defaultToolId: "x".repeat(201) }],
  ])("rejects %s", (_n, method, params) => {
    expect(ok(req(method, params))).toBe(false);
  });

  it("settings.changed event and the Settings schema", () => {
    expect(parseServerMessage(JSON.stringify({ type: "event", name: "settings.changed" })).ok).toBe(true);
    expect(SettingsSchema.safeParse({}).success).toBe(true);
    expect(SettingsSchema.safeParse({ defaultToolId: "claude" }).success).toBe(true);
    expect(SettingsSchema.safeParse({ defaultToolId: "" }).success).toBe(false);
  });

  it("terminal.open toolId: null asks for a plain shell explicitly (skips every default)", () => {
    expect(ok(req("terminal.open", { projectId: "p", cols: 80, rows: 24, toolId: null }))).toBe(true);
    expect(ok(req("terminal.open", { cardId: "c", cols: 80, rows: 24, toolId: null }))).toBe(true);
    expect(ok(req("terminal.open", { projectId: "p", cols: 80, rows: 24, toolId: "" }))).toBe(false);
  });
});

describe("parseClientMessage", () => {
  it("accepts the handshake frames, and no frame that carries a key", () => {
    expect(parseClientMessage(JSON.stringify({ type: "auth.hello", nonce: NONCE })).ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ type: "auth.proof", proof: PROOF })).ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ type: "hello", key: "abc" })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ type: "auth.hello", nonce: NONCE, key: "abc" })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ type: "auth.hello", nonce: "short" })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ type: "auth.proof", proof: "x" })).ok).toBe(false);
  });

  it("accepts every request method with valid params", () => {
    const reqs: ClientMessage[] = [
      { type: "req", id: 1, method: "projects.list", params: {} },
      { type: "req", id: 2, method: "cards.list", params: { projectId: "p1" } },
      { type: "req", id: 3, method: "cards.create", params: { projectId: "p1", name: "Yeni iş" } },
      { type: "req", id: 4, method: "cards.delete", params: { cardId: "c1" } },
      { type: "req", id: 5, method: "terminals.list", params: { cardId: "c1" } },
      { type: "req", id: 6, method: "terminal.open", params: { cardId: "c1", cols: 80, rows: 24 } },
      { type: "req", id: 7, method: "terminal.open", params: { cardId: "c1", cols: 80, rows: 24, command: "claude" } },
      { type: "req", id: 8, method: "terminal.attach", params: { terminalId: "t1", cols: 80, rows: 24 } },
      { type: "req", id: 9, method: "terminal.detach", params: { terminalId: "t1" } },
      { type: "req", id: 10, method: "terminal.close", params: { terminalId: "t1" } },
    ];
    for (const m of reqs) expect(parseClientMessage(JSON.stringify(m)).ok, m.type === "req" ? m.method : m.type).toBe(true);
  });

  it("accepts input and resize", () => {
    expect(parseClientMessage(JSON.stringify({ type: "input", terminalId: "t1", data: "ls\r" })).ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ type: "resize", terminalId: "t1", cols: 120, rows: 40 })).ok).toBe(true);
  });

  it.each([
    ["not json", "{"],
    ["empty", ""],
    ["array", "[]"],
    ["null", "null"],
    ["number", "42"],
    ["unknown type", JSON.stringify({ type: "nope" })],
    ["unknown method", JSON.stringify({ type: "req", id: 1, method: "rm.rf", params: {} })],
    ["missing params", JSON.stringify({ type: "req", id: 1, method: "cards.list" })],
    ["wrong param type", JSON.stringify({ type: "req", id: 1, method: "cards.list", params: { projectId: 5 } })],
    ["extra param key", JSON.stringify({ type: "req", id: 1, method: "cards.list", params: { projectId: "p", x: 1 } })],
    ["empty card name", JSON.stringify({ type: "req", id: 1, method: "cards.create", params: { projectId: "p", name: "  " } })],
    ["zero cols", JSON.stringify({ type: "resize", terminalId: "t", cols: 0, rows: 10 })],
    ["float rows", JSON.stringify({ type: "resize", terminalId: "t", cols: 10, rows: 1.5 })],
    ["huge cols", JSON.stringify({ type: "resize", terminalId: "t", cols: 100000, rows: 10 })],
    ["negative id", JSON.stringify({ type: "req", id: -1, method: "projects.list", params: {} })],
    ["proto pollution", `{"type":"auth.hello","nonce":"${"n".repeat(43)}","__proto__":{"admin":true}}`],
    ["the old hello", JSON.stringify({ type: "hello", key: "k" })],
  ])("rejects %s", (_name, raw) => {
    const r = parseClientMessage(raw);
    expect(r.ok).toBe(false);
  });

  it("rejects messages over the size limit", () => {
    const raw = JSON.stringify({ type: "input", terminalId: "t", data: "x".repeat(MAX_MESSAGE_BYTES) });
    expect(parseClientMessage(raw).ok).toBe(false);
  });

  it("never throws on random garbage", () => {
    for (let i = 0; i < 500; i++) {
      const len = Math.floor(Math.random() * 200);
      let s = "";
      for (let j = 0; j < len; j++) s += String.fromCharCode(Math.floor(Math.random() * 0x2fff));
      expect(() => parseClientMessage(s)).not.toThrow();
    }
  });
});

describe("parseServerMessage", () => {
  it("accepts output, exit, res and events", () => {
    const msgs = [
      { type: "auth.challenge", nonce: NONCE },
      { type: "hello.ok", engineVersion: "0.1.0", engineBuild: { buildId: "0.1.0+20261118100000.abc", version: "0.1.0", commit: "abc", builtAt: "t" }, protocol: 2, proof: PROOF },
      { type: "output", terminalId: "t1", data: "hi" },
      { type: "output", terminalId: "t1", data: "old", replay: true },
      { type: "exit", terminalId: "t1", exitCode: 0 },
      { type: "res", id: 1, ok: true, result: { projects: [] } },
      { type: "res", id: 1, ok: false, error: { code: "DIRTY_WORKTREE", message: "x" } },
      { type: "event", name: "cards.changed", projectId: "p1" },
      { type: "event", name: "terminals.changed", projectId: "p1", cardId: "c1" },
    ];
    for (const m of msgs) expect(parseServerMessage(JSON.stringify(m)).ok, m.type).toBe(true);
  });

  it("rejects garbage", () => {
    expect(parseServerMessage("{").ok).toBe(false);
    expect(parseServerMessage(JSON.stringify({ type: "output" })).ok).toBe(false);
  });
});

describe("close codes", () => {
  it("are in the application range", () => {
    for (const c of Object.values(CLOSE_CODES)) {
      expect(c).toBeGreaterThanOrEqual(4000);
      expect(c).toBeLessThan(5000);
    }
  });
});

describe("parseClientMessage: well-formed request with invalid params", () => {
  const raw = (method: string, params: unknown, id = 7) => JSON.stringify({ type: "req", id, method, params });
  const bad = (r: ReturnType<typeof parseClientMessage>) => (r.ok ? undefined : r.badRequest);

  it.each([
    ["ssh hostname option injection", "sshHosts.create", { name: "x", hostname: "-oProxyCommand=x" }],
    ["port 0", "sshHosts.create", { name: "x", hostname: "h", port: 0 }],
    ["port 65536", "sshHosts.create", { name: "x", hostname: "h", port: 65536 }],
    ["relative ssh path", "projects.create", { name: "x", location: { kind: "ssh", hostId: "h", path: "rel/x" } }],
    ["file:// github url", "projects.create", { name: "x", location: { kind: "github", url: "file:///etc" } }],
    ["terminal.open with both", "terminal.open", { cardId: "c", projectId: "p", cols: 80, rows: 24 }],
    ["terminal.open with neither", "terminal.open", { cols: 80, rows: 24 }],
    ["wrong param type", "cards.list", { projectId: 5 }],
  ])("%s → not ok, but reports id + method + a readable message", (_n, method, params) => {
    const r = parseClientMessage(raw(method, params));
    expect(r.ok).toBe(false);
    const b = bad(r);
    expect(b).toMatchObject({ id: 7, method });
    expect(b?.message.length).toBeGreaterThan(0);
    expect(b?.message).not.toMatch(/Invalid input|Too (small|big)|expected/);
  });

  it("messages are Turkish and name the field", () => {
    const msg = (method: string, params: unknown) => bad(parseClientMessage(raw(method, params)))?.message;
    expect(msg("sshHosts.create", { name: "x", hostname: "h", port: 0 })).toBe("port: en az 1 olmalı");
    expect(msg("sshHosts.create", { name: "x", hostname: "h", port: 65536 })).toBe("port: en çok 65535 olmalı");
    expect(msg("sshHosts.create", { name: "x", hostname: "-oProxyCommand=x" })).toBe("hostname: geçersiz karakter");
    expect(msg("projects.create", { name: "x", location: { kind: "ssh", hostId: "h", path: "rel/x" } })).toBe("location.path: mutlak yol olmalı");
    expect(msg("projects.create", { name: "x", location: { kind: "github", url: "file:///etc" } })).toBe(
      "location.url: https:// ya da git@ adresi olmalı",
    );
    expect(msg("cards.list", { projectId: 5 })).toBe("projectId: geçersiz tür");
    expect(msg("cards.list", {})).toBe("projectId: gerekli");
    expect(msg("cards.list", { projectId: "p", x: 1 })).toBe("bilinmeyen alan: x");
    expect(msg("terminal.open", { cols: 80, rows: 24 })).toBe("cardId ya da projectId'den tam olarak biri gerekli");
  });

  it.each([
    ["unknown method", JSON.stringify({ type: "req", id: 1, method: "rm.rf", params: {} })],
    ["missing params", JSON.stringify({ type: "req", id: 1, method: "cards.list" })],
    ["params not an object", JSON.stringify({ type: "req", id: 1, method: "cards.list", params: [] })],
    ["no id", JSON.stringify({ type: "req", method: "cards.list", params: { projectId: 5 } })],
    ["negative id", JSON.stringify({ type: "req", id: -1, method: "cards.list", params: { projectId: 5 } })],
    ["extra envelope key", JSON.stringify({ type: "req", id: 1, method: "cards.list", params: { projectId: 5 }, x: 1 })],
    ["not json", "{"],
    ["oversize", JSON.stringify({ type: "req", id: 1, method: "cards.list", params: { projectId: "x".repeat(MAX_MESSAGE_BYTES) } })],
    ["proto pollution in params", '{"type":"req","id":1,"method":"cards.list","params":{"__proto__":{"a":1}}}'],
  ])("truly malformed (%s) → no badRequest (connection gets closed)", (_n, s) => {
    const r = parseClientMessage(s);
    expect(r.ok).toBe(false);
    expect(bad(r)).toBeUndefined();
  });
});
