// İş H (Adım 8): claudeAccounts.* handlers over a real service on a temp HOME.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage, TerminalInfo } from "@kokpit/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClaudeAccountService, type ClaudeAccountService } from "../claude-accounts.ts";
import { EngineError, type Logger } from "../contracts.ts";
import { createMemoryStore } from "../store.ts";
import { claudeAccountHandlers } from "./claude-accounts.ts";

const silent: Logger = { info() {}, warn() {}, error() {} };
const terminal: TerminalInfo = { id: "t1", projectId: "mac-mini", title: "claude", status: "running", createdAt: "2026-01-01T00:00:00.000Z" };

describe("claudeAccountHandlers", () => {
  let home: string;
  let service: ClaudeAccountService;
  let events: ServerMessage[];
  let opened: unknown[];

  const handlers = (svc: ClaudeAccountService | undefined = service) =>
    claudeAccountHandlers<string>({
      service: svc,
      builtinProjectId: "mac-mini",
      loginCommand: "'claude' '/login'",
      broadcast: (m) => events.push(m),
      openTerminal: (ctx, target, size) => {
        opened.push([ctx, target, size]);
        return { terminal };
      },
    });

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-acc-h-")));
    const tunables = {
      defaultId: "benim",
      defaultName: "Benim",
      defaultDirName: ".claude",
      idFallback: "hesap",
      idMaxLen: 50,
      shareNames: ["skills"],
      loginArgs: ["/login"],
    };
    service = createClaudeAccountService({ store: createMemoryStore(), logger: silent, homeDir: home, tunables });
    service.init();
    events = [];
    opened = [];
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("CRUD answers and broadcasts claudeAccounts.changed on every change", async () => {
    const h = handlers();
    const { account } = await h["claudeAccounts.create"]("c", { name: "Work", configDir: "~/.claude-work" });
    expect(account.configDir).toBe(join(home, ".claude-work"));
    expect((await h["claudeAccounts.list"]("c", {})).accounts).toHaveLength(2);
    await h["claudeAccounts.update"]("c", { id: account.id, name: "K" });
    await h["claudeAccounts.delete"]("c", { id: account.id });
    expect(events).toEqual(Array(3).fill({ type: "event", name: "claudeAccounts.changed" }));
  });

  it("login opens the built-in project's terminal with the account, creating its folder", async () => {
    const h = handlers();
    const { account } = await h["claudeAccounts.create"]("c", { name: "Work", configDir: "~/.claude-work" });
    rmSync(account.configDir, { recursive: true });
    expect(await h["claudeAccounts.login"]("c", { id: account.id, cols: 90, rows: 30 })).toEqual({ terminal });
    expect(opened).toEqual([["c", { projectId: "mac-mini", command: "'claude' '/login'", claudeAccountId: account.id }, { cols: 90, rows: 30 }]]);
    expect(realpathSync(account.configDir)).toBe(account.configDir);
    await expect(Promise.resolve().then(() => h["claudeAccounts.login"]("c", { id: "nope", cols: 1, rows: 1 }))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("shareSkills reports linked and skipped", async () => {
    const h = handlers();
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    const { account } = await h["claudeAccounts.create"]("c", { name: "Work", configDir: "~/.claude-work" });
    expect(await h["claudeAccounts.shareSkills"]("c", { id: account.id, confirm: true })).toEqual({ linked: ["skills"], skipped: [] });
  });

  it("without a service: empty list, actions INVALID", async () => {
    const h = handlers(null as never);
    expect(await h["claudeAccounts.list"]("c", {})).toEqual({ accounts: [] });
    expect(() => h["claudeAccounts.create"]("c", { name: "x", configDir: "/x" })).toThrow(EngineError);
  });
});
