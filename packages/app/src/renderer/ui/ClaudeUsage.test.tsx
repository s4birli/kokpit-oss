// Claude kullanımı — the usage block (per account) and the list of blocks.
import type { ClaudeUsageAccount, ClaudeUsageResult, ClaudeUsageTotals, ClaudeUsageWindow } from "@kokpit/shared";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeUsageBlock, ClaudeUsageList } from "./ClaudeUsage.tsx";
import { usageSourceNote } from "./claude-usage.ts";
import { FakeEngineClient } from "./test-utils/fake-client.ts";

const TR = "tr-TR";
const flush = () => act(async () => {});
const t = (messages: number, input: number, output: number, cacheWrite: number, cacheRead: number): ClaudeUsageTotals => ({ messages, input, output, cacheWrite, cacheRead });
const ZERO = t(0, 0, 0, 0, 0);
const window = (totals: ClaudeUsageTotals, extra: Partial<ClaudeUsageWindow> = {}): ClaudeUsageWindow => ({ totals, byModel: [], topProjects: [], ...extra });

const SESSION = window(t(12, 1000, 20_000, 300_000, 4_000_000), {
  byModel: [{ family: "opus", ...t(10, 900, 19_000, 290_000, 3_900_000) }, { family: "haiku", ...t(2, 100, 1000, 10_000, 100_000) }],
  topProjects: [{ projectId: "p1", name: "Alfa", ...t(12, 1000, 20_000, 300_000, 4_000_000) }],
});
const TODAY = window(t(40, 2000, 50_000, 700_000, 9_000_000));
const WEEK = window(t(900, 60_000, 1_500_000, 20_000_000, 250_000_000), {
  byModel: [{ family: "fable", ...t(900, 60_000, 1_500_000, 20_000_000, 250_000_000) }],
  topProjects: [
    { projectId: "p2", name: "Beta", ...t(600, 40_000, 1_000_000, 15_000_000, 200_000_000) },
    { name: "serbest", ...t(300, 10_000, 500_000, 5_000_000, 50_000_000) },
  ],
});

const account = (extra: Partial<ClaudeUsageAccount> = {}): ClaudeUsageAccount => ({
  accountId: "work",
  name: "Work",
  windows: { session: SESSION, today: TODAY, week: WEEK },
  updatedAt: "2026-11-18T12:03:00.000Z",
  indexing: false,
  ...extra,
});
const result = (accounts: ClaudeUsageAccount[], extra: Partial<ClaudeUsageResult> = {}): ClaudeUsageResult => ({
  accounts,
  sessionWindowHours: 5,
  longWindowDays: 7,
  refreshIntervalMs: 60_000,
  probeAvailable: true,
  ...extra,
});
const PLAN = {
  fiveHour: { usedPercent: 23.5, resetsAt: "2026-11-18T14:00:00.000Z", capturedAt: "2026-11-18T12:00:00.000Z", source: "statusline" as const },
  sevenDay: { usedPercent: 59, resetsAt: "2026-11-19T00:00:00.000Z", capturedAt: "2026-11-18T11:00:00.000Z", source: "probe" as const },
};
const clock = (iso: string) => new Intl.DateTimeFormat(TR, { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

function setupBlock(a: ClaudeUsageAccount = account(), meta: ClaudeUsageResult = result([a]), client = new FakeEngineClient()) {
  const onChanged = vi.fn(async () => {});
  const utils = render(<ClaudeUsageBlock client={client} account={a} meta={meta} locale={TR} now={Date.parse("2026-11-18T12:05:00.000Z")} onChanged={onChanged} />);
  return { client, onChanged, ...utils };
}

const block = (name = "Work") => screen.getByRole("group", { name: `Claude kullanımı: ${name}` });
const row = (label: string) => within(block()).getByRole("row", { name: new RegExp(`^${label}`) });
const cells = (label: string) => within(row(label)).getAllByRole("cell").map((c) => c.textContent);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ClaudeUsageBlock", () => {
  it("shows total, input, output, cache write, cache read and message count for the three windows", () => {
    setupBlock();
    expect(within(block()).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Dönem", "Toplam", "Girdi", "Çıktı", "Önbellek yazma", "Önbellek okuma", "İleti"]);
    expect(cells("Son 5 saat")).toEqual(["4,3 Mn", "1 B", "20 B", "300 B", "4 Mn", "12"]);
    expect(cells("Bugün")).toEqual(["9,8 Mn", "2 B", "50 B", "700 B", "9 Mn", "40"]);
    expect(cells("Son 7 gün")).toEqual(["271,6 Mn", "60 B", "1,5 Mn", "20 Mn", "250 Mn", "900"]);
  });

  it("says what the numbers are, and when they were last read", () => {
    setupBlock();
    expect(within(block()).getByText(usageSourceNote())).toBeTruthy();
    expect(within(block()).getByText(`Son güncelleme: ${clock("2026-11-18T12:03:00.000Z")}`)).toBeTruthy();
  });

  it("breaks the chosen window down by model and by project; the long window first", () => {
    setupBlock();
    const models = () => within(within(block()).getByRole("list", { name: /^Modeller/ })).getAllByRole("listitem").map((li) => li.textContent);
    const projects = () => within(within(block()).getByRole("list", { name: /^Projeler/ })).getAllByRole("listitem").map((li) => li.textContent);
    expect(within(block()).getByRole("button", { name: "Son 7 gün" }).getAttribute("aria-pressed")).toBe("true");
    expect(models()).toEqual(["Fable271,6 Mn"]);
    expect(projects()).toEqual(["Beta216 Mn", "serbest55,5 Mn"]);
    fireEvent.click(within(block()).getByRole("button", { name: "Son 5 saat" }));
    expect(within(block()).getByRole("button", { name: "Son 5 saat" }).getAttribute("aria-pressed")).toBe("true");
    expect(models()).toEqual(["Opus4,2 Mn", "Haiku111,1 B"]);
    expect(projects()).toEqual(["Alfa4,3 Mn"]);
    fireEvent.click(within(block()).getByRole("button", { name: "Bugün" }));
    expect(within(block()).queryByRole("list", { name: /^Modeller/ })).toBeNull();
  });

  it("an account without recorded use says so instead of an empty table", () => {
    const empty = window(ZERO);
    setupBlock(account({ windows: { session: empty, today: empty, week: empty } }));
    expect(within(block()).getByText("Son 7 günde bu Mac'te kayıtlı kullanım yok.")).toBeTruthy();
    expect(within(block()).queryByRole("table")).toBeNull();
  });

  it("shows Claude's own quota figures as meters with reset time and source — only when a source gave them", () => {
    setupBlock(account({ plan: PLAN }));
    const five = within(block()).getByRole("meter", { name: "5 saatlik kota" });
    expect(five.getAttribute("aria-valuenow")).toBe("23.5");
    expect(five.getAttribute("aria-valuetext")).toBe("%24");
    expect(within(block()).getByRole("meter", { name: "haftalık kota" }).getAttribute("aria-valuenow")).toBe("59");
    const text = block().textContent ?? "";
    expect(text).toContain(`sıfırlanma ${clock(PLAN.fiveHour.resetsAt)}`);
    expect(text).toContain(`durum satırı, ${clock(PLAN.fiveHour.capturedAt)}`);
    expect(text).toContain(`Claude'a soruldu, ${clock(PLAN.sevenDay.capturedAt)}`);
    cleanup();
    setupBlock();
    expect(within(block()).queryByRole("meter")).toBeNull();
    expect(within(block()).getByText(/Claude'un kendi kota yüzdesi bilinmiyor/)).toBeTruthy();
  });

  it("clamps a meter above 100 percent", () => {
    setupBlock(account({ plan: { fiveHour: { ...PLAN.fiveHour, usedPercent: 140 } } }));
    const m = within(block()).getByRole("meter", { name: "5 saatlik kota" });
    expect(m.getAttribute("aria-valuenow")).toBe("100");
    expect(m.getAttribute("aria-valuetext")).toBe("%140");
  });

  it("asks Claude only after an explicit confirmation that it spends a small request", async () => {
    const client = new FakeEngineClient();
    client.respond("claudeUsage.probe", ({ accountId }) => result([account({ accountId, plan: { sevenDay: PLAN.sevenDay } })]));
    const { onChanged } = setupBlock(account(), undefined, client);
    fireEvent.click(within(block()).getByRole("button", { name: "Claude'a sor: Work" }));
    expect(client.callsOf("claudeUsage.probe")).toEqual([]);
    expect(within(block()).getByText(/küçük bir istek/)).toBeTruthy();
    fireEvent.click(within(block()).getByRole("button", { name: "Vazgeç" }));
    expect(within(block()).queryByText(/küçük bir istek/)).toBeNull();
    fireEvent.click(within(block()).getByRole("button", { name: "Claude'a sor: Work" }));
    fireEvent.click(within(block()).getByRole("button", { name: "Sor" }));
    await flush();
    expect(client.callsOf("claudeUsage.probe")).toEqual([{ accountId: "work", confirm: true }]);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("shows why asking failed; offers no asking when the engine has it off", async () => {
    const client = new FakeEngineClient();
    client.fail("claudeUsage.probe", "CLAUDE_FAILED", "Claude kota bilgisi vermedi.");
    setupBlock(account(), undefined, client);
    fireEvent.click(within(block()).getByRole("button", { name: "Claude'a sor: Work" }));
    fireEvent.click(within(block()).getByRole("button", { name: "Sor" }));
    await flush();
    expect(within(block()).getByRole("alert").textContent).toContain("Claude kota bilgisi vermedi.");
    cleanup();
    const a = account();
    setupBlock(a, result([a], { probeAvailable: false }));
    expect(within(block()).queryByRole("button", { name: /Claude'a sor/ })).toBeNull();
  });

  it("Yenile asks the engine for a fresh pass", async () => {
    const { client, onChanged } = setupBlock();
    fireEvent.click(within(block()).getByRole("button", { name: "Kullanımı yenile: Work" }));
    await flush();
    expect(client.callsOf("claudeUsage.get")).toEqual([{ accountId: "work", refresh: true }]);
    expect(onChanged).toHaveBeenCalled();
  });

  it("shows reading, partial and error states", () => {
    const empty = window(ZERO);
    setupBlock(account({ indexing: true, updatedAt: undefined, windows: { session: empty, today: empty, week: empty } }));
    expect(within(block()).getByText("Oturum kayıtları okunuyor…")).toBeTruthy();
    expect(within(block()).queryByText(/kayıtlı kullanım yok/)).toBeNull();
    cleanup();
    setupBlock(account({ partial: true }));
    expect(within(block()).getByText(/alt sınırdır/)).toBeTruthy();
    cleanup();
    setupBlock(account({ error: "Oturum kayıtları okunamadı." }));
    expect(within(block()).getByRole("alert").textContent).toBe("Oturum kayıtları okunamadı.");
  });

  it("shows an estimated cost column only when the engine ships a dated price table", () => {
    const priced = account({ windows: { session: { ...SESSION, estimatedCostUsd: 1.5 }, today: TODAY, week: { ...WEEK, estimatedCostUsd: 1234.5 } } });
    setupBlock(priced, result([priced], { pricesAsOf: "2026-11-01" }));
    expect(within(block()).getAllByRole("columnheader").at(-1)!.textContent).toBe("Tahmini maliyet");
    expect(cells("Son 5 saat").at(-1)).toBe("$1,50");
    expect(cells("Bugün").at(-1)).toBe("—");
    expect(within(block()).getByText(/tahmini.*2026-11-01/i)).toBeTruthy();
  });
});

describe("ClaudeUsageList", () => {
  it("shows every account, the given one first, and re-reads on claudeUsage.changed and at the engine's interval", async () => {
    vi.useFakeTimers();
    const client = new FakeEngineClient();
    let session = 12;
    client.respond("claudeUsage.get", () =>
      result([account({ accountId: "benim", name: "Benim", isDefault: true }), account({ windows: { session: window(t(session, 0, 0, 0, 0)), today: TODAY, week: WEEK } })], { refreshIntervalMs: 5000 }),
    );
    render(<ClaudeUsageList client={client} locale={TR} firstAccountId="work" />);
    await flush();
    expect(screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["Claude kullanımı: Work", "Claude kullanımı: Benim"]);
    expect(screen.getByRole("heading", { name: "Work (bu projenin hesabı)" })).toBeTruthy();
    expect(cells("Son 5 saat").at(-1)).toBe("12");

    session = 13;
    client.emitEvent({ type: "event", name: "claudeUsage.changed" });
    await flush();
    expect(cells("Son 5 saat").at(-1)).toBe("13");

    const before = client.callsOf("claudeUsage.get").length;
    session = 14;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(client.callsOf("claudeUsage.get").length).toBe(before + 1);
    expect(cells("Son 5 saat").at(-1)).toBe("14");
  });

  it("shows the load error and an empty state", async () => {
    const client = new FakeEngineClient();
    client.fail("claudeUsage.get", "INVALID", "Claude kullanımı bu motorda etkin değil");
    render(<ClaudeUsageList client={client} locale={TR} />);
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("Claude kullanımı bu motorda etkin değil");
  });
});
