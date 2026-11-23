import { describe, expect, it } from "vitest";
import { accountBadge, checkConfigDir, projectAccountBadge } from "./claude-accounts.ts";

const accounts = [
  { id: "benim", name: "Benim", configDir: "/u/.claude", isDefault: true },
  { id: "work", name: "Work", configDir: "/u/.claude-work" },
];

describe("claude account helpers (İş H)", () => {
  it("badges only non-default, known accounts", () => {
    expect(accountBadge(accounts, "work")).toBe("Work");
    expect(accountBadge(accounts, "benim")).toBeUndefined();
    expect(accountBadge(accounts, undefined)).toBeUndefined();
    expect(accountBadge(accounts, "gone")).toBeUndefined();
    expect(accountBadge(undefined, "work")).toBeUndefined();
    expect(projectAccountBadge(accounts, { claudeAccountId: "work" })).toBe("Work");
    expect(projectAccountBadge(accounts, {})).toBeUndefined();
  });

  it("config dir check: absolute or ~/, never empty", () => {
    expect(checkConfigDir("~/.claude-work")).toBeUndefined();
    expect(checkConfigDir(" /Users/x/.c ")).toBeUndefined();
    for (const bad of ["", "  ", "rel", "~", "~user/x", "a\0b"]) expect(checkConfigDir(bad)).toBeTypeOf("string");
  });
});
