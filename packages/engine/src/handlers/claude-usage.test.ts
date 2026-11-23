// Claude kullanımı — protocol handlers.
import { describe, expect, it, vi } from "vitest";
import type { ClaudeUsageResult } from "@kokpit/shared";
import type { ClaudeUsageService } from "../claude-usage.ts";
import { EngineError } from "../contracts.ts";
import { claudeUsageHandlers } from "./claude-usage.ts";

const RESULT: ClaudeUsageResult = { accounts: [], sessionWindowHours: 5, longWindowDays: 7, refreshIntervalMs: 60_000, probeAvailable: true };

function fakeService() {
  const get = vi.fn<ClaudeUsageService["get"]>(() => RESULT);
  const probe = vi.fn<ClaudeUsageService["probe"]>(async () => RESULT);
  const service: ClaudeUsageService = {
    get,
    probe,
    refresh: async () => {},
    idle: async () => {},
    onChange: () => () => {},
    stats: () => ({ bytesRead: 0, filesRead: 0, passes: 0, rebuilds: 0 }),
    dispose: async () => {},
  };
  return { service, get, probe };
}

describe("claudeUsage handlers", () => {
  it("get passes the account and refresh flag through", () => {
    const { service, get } = fakeService();
    const h = claudeUsageHandlers({ service });
    expect(h["claudeUsage.get"](null, { accountId: "work", refresh: true })).toBe(RESULT);
    expect(get).toHaveBeenCalledWith({ accountId: "work", refresh: true });
    h["claudeUsage.get"](null, {});
    expect(get).toHaveBeenLastCalledWith({});
  });

  it("probe asks the service for that account", async () => {
    const { service, probe } = fakeService();
    const h = claudeUsageHandlers({ service });
    expect(await h["claudeUsage.probe"](null, { accountId: "work", confirm: true })).toBe(RESULT);
    expect(probe).toHaveBeenCalledWith("work");
  });

  it("without the service every request answers INVALID", async () => {
    const h = claudeUsageHandlers({ service: undefined });
    expect(() => h["claudeUsage.get"](null, {})).toThrowError(EngineError);
    await expect(async () => h["claudeUsage.probe"](null, { accountId: "a", confirm: true })).rejects.toMatchObject({ code: "INVALID" });
  });
});
