// İş C (Adım 8) — Claude paneli: skill/ajan/komut sekmeleri, arama, kaynak rozetleri, önizleme, Rehber.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Card, ClaudeInventoryItem, ClaudeInventoryResult, Project } from "@kokpit/shared";
import { defaultUiConfig } from "../config.ts";
import type { PanelContext } from "../layout/contract.ts";
import { FakeEngineClient, makeCard, makeProject, makeSshProject } from "../test-utils/fake-client.ts";
import { makeFakeViewFactory } from "../test-utils/fake-view.ts";
import { claudeGuide } from "./claude-guide.ts";
import { CLAUDE_HELP_TAB, claudePanel, revealClaudeHelp } from "./ClaudePanel.tsx";
import { MemoryPanelState } from "./memory-state.ts";

const flush = () => act(async () => {});
const project = makeProject("p1", "Alfa");

const item = (kind: ClaudeInventoryItem["kind"], source: ClaudeInventoryItem["source"], name: string, description?: string): ClaudeInventoryItem => ({
  kind,
  source,
  name,
  ...(description !== undefined ? { description } : {}),
  path: `${source}/${name}.md`,
  id: `${source}:${kind}/${name}.md`,
});

const INVENTORY: ClaudeInventoryResult = {
  items: [
    item("skill", "project", "derle", "Projeyi derler"),
    item("skill", "user", "gunluk", "Günlük özet çıkarır"),
    item("skill", "plugin", "guc:tdd", "Önce test"),
    item("agent", "user", "denetci", "Kodu denetler"),
    item("command", "project", "yayinla", "Sürüm yayınlar"),
    item("command", "user", "selam"),
  ],
  truncated: false,
  claudeMd: { project: true, user: true },
};

function setup(opts: { project?: Project | null; card?: Card | null; state?: MemoryPanelState; inventory?: ClaudeInventoryResult; client?: FakeEngineClient } = {}) {
  const client = opts.client ?? new FakeEngineClient({ projects: [project] });
  if (!opts.client) {
    client.respond("claude.inventory", () => opts.inventory ?? INVENTORY);
    client.respond("claude.inventory.read", ({ id }) => ({ text: `# ${id}\niçerik\n`, size: 20, truncated: false }));
  }
  const state = opts.state ?? new MemoryPanelState();
  const ctx: PanelContext = {
    client,
    config: defaultUiConfig,
    createView: makeFakeViewFactory().factory,
    project: opts.project === undefined ? project : opts.project,
    card: opts.card ?? null,
    state,
    reveal: () => {},
    select: () => {},
  };
  const utils = render(claudePanel.render(ctx));
  const rerenderWith = (patch: Partial<PanelContext>) => utils.rerender(claudePanel.render({ ...ctx, ...patch }));
  return { client, state, ctx, rerenderWith, ...utils };
}

const panel = () => screen.getByRole("region", { name: "Claude" });
const tab = (name: string) => within(panel()).getByRole("tab", { name: new RegExp(`^${name}`) });
const list = () => within(panel()).getByRole("list", { name: "Öğeler" });
const names = () => within(list()).queryAllByRole("button").map((b) => b.querySelector(".kp-claude__name")?.textContent);
const search = () => within(panel()).getByRole("searchbox", { name: "Ara" });

afterEach(cleanup);

describe("claudePanel definition", () => {
  it("is the 'claude' panel titled Claude, available even without a project (Rehber)", () => {
    expect(claudePanel.id).toBe("claude");
    expect(claudePanel.title).toBe("Claude");
    expect(claudePanel.available({ project: null, card: null })).toBe(true);
  });

  it("revealClaudeHelp asks the host for the Rehber tab", () => {
    const calls: unknown[] = [];
    revealClaudeHelp({ reveal: (...a) => calls.push(a) });
    expect(calls).toEqual([["claude", { tab: CLAUDE_HELP_TAB }]]);
  });
});


const usageWindow = (messages: number, cacheRead: number) => ({ totals: { messages, input: 0, output: 0, cacheWrite: 0, cacheRead }, byModel: [], topProjects: [] });
const usageAccount = (accountId: string, name: string, session: number) => ({
  accountId,
  name,
  windows: { session: usageWindow(3, session), today: usageWindow(5, 3_400_000), week: usageWindow(9, 30_000_000) },
  updatedAt: "2026-11-18T12:00:00.000Z",
  indexing: false,
});
const USAGE = {
  accounts: [usageAccount("benim", "Benim", 500), usageAccount("work", "Work", 1_200_000)],
  sessionWindowHours: 5,
  longWindowDays: 7,
  refreshIntervalMs: 60_000,
  probeAvailable: false,
};

describe("ClaudePanel — Kullanım", () => {
  it("has a Kullanım tab listing every account's usage, the project's account first; no inventory chrome", async () => {
    const client = new FakeEngineClient({ projects: [makeProject("p1", "Alfa", { claudeAccountId: "work" })] });
    client.respond("claudeUsage.get", () => USAGE);
    setup({ client, project: makeProject("p1", "Alfa", { claudeAccountId: "work" }) });
    await flush();
    expect(client.callsOf("claudeUsage.get")).toEqual([]); // nothing is read until the tab is opened
    fireEvent.click(tab("Kullanım"));
    await flush();
    expect(tab("Kullanım").getAttribute("aria-selected")).toBe("true");
    expect(within(panel()).getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["Claude kullanımı: Work", "Claude kullanımı: Benim"]);
    expect(within(panel()).getByRole("heading", { name: "Work (bu projenin hesabı)" })).toBeTruthy();
    expect(within(panel()).queryByRole("searchbox")).toBeNull();
    expect(within(panel()).queryByText(/^CLAUDE\.md/)).toBeNull();
    expect(tab("Kullanım").textContent).toBe("Kullanım");
  });

  it("a project on the default account puts the default account first; works without a project", async () => {
    const client = new FakeEngineClient({ projects: [project] });
    client.respond("claudeUsage.get", () => ({ ...USAGE, accounts: [USAGE.accounts[1]!, { ...USAGE.accounts[0]!, isDefault: true }] }));
    const { rerenderWith } = setup({ client });
    fireEvent.click(tab("Kullanım"));
    await flush();
    expect(within(panel()).getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["Claude kullanımı: Benim", "Claude kullanımı: Work"]);
    rerenderWith({ project: null });
    await flush();
    fireEvent.click(tab("Kullanım"));
    await flush();
    expect(within(panel()).getAllByRole("group")).toHaveLength(2);
    expect(within(panel()).queryByText("Proje seçilmedi.")).toBeNull();
  });
});

describe("ClaudePanel", () => {
  it("loads the project's inventory and shows skills with source badges", async () => {
    const { client } = setup();
    await flush();
    expect(client.calls.find((c) => c.method === "claude.inventory")?.params).toEqual({ projectId: "p1" });
    expect(tab("Skill'ler").getAttribute("aria-selected")).toBe("true");
    expect(names()).toEqual(["derle", "gunluk", "guc:tdd"]);
    // Kopyalama: right click on an item offers its file path.
    for (const b of within(list()).getAllByRole("button")) {
      expect(b.getAttribute("data-copy")).toBeTruthy();
      expect(b.getAttribute("data-copy")).toBe(b.getAttribute("title"));
    }
    const badges = within(list()).getAllByText(/^(Proje|Hesap|Plugin)$/).map((b) => b.textContent);
    expect(badges).toEqual(["Proje", "Hesap", "Plugin"]);
    expect(within(list()).getByText("Günlük özet çıkarır")).toBeTruthy();
    expect(tab("Skill'ler").textContent).toContain("3");
  });

  it("switches tabs and remembers the tab", async () => {
    const { state } = setup();
    await flush();
    fireEvent.click(tab("Ajanlar"));
    expect(names()).toEqual(["denetci"]);
    fireEvent.click(tab("Komutlar"));
    expect(names()).toEqual(["/yayinla", "/selam"]);
    expect(state.get("tab")).toBe("command");
    cleanup();
    setup({ state });
    await flush();
    expect(tab("Komutlar").getAttribute("aria-selected")).toBe("true");
  });

  it("searches names and descriptions (Turkish-insensitive)", async () => {
    setup();
    await flush();
    fireEvent.change(search(), { target: { value: "GÜNLÜK" } });
    expect(names()).toEqual(["gunluk"]);
    fireEvent.change(search(), { target: { value: "yok-böyle" } });
    expect(within(panel()).getByText("Eşleşen öğe yok.")).toBeTruthy();
  });

  it("previews an item read-only", async () => {
    const { client } = setup();
    await flush();
    fireEvent.click(within(list()).getByRole("button", { name: /gunluk/ }));
    await flush();
    expect(client.calls.find((c) => c.method === "claude.inventory.read")?.params).toEqual({ projectId: "p1", id: "user:skill/gunluk.md" });
    const preview = within(panel()).getByRole("region", { name: "Önizleme" });
    expect(within(preview).getByText("user/gunluk.md")).toBeTruthy();
    expect(preview.querySelector("code")?.textContent).toBe("# user:skill/gunluk.md\niçerik\n");
  });

  it("shows a preview error", async () => {
    const { client } = setup();
    await flush();
    client.fail("claude.inventory.read", "INVALID", "Yalnız markdown dosyaları önizlenir");
    fireEvent.click(within(list()).getByRole("button", { name: /derle/ }));
    await flush();
    expect(within(panel()).getByRole("alert").textContent).toBe("Yalnız markdown dosyaları önizlenir");
  });

  it("Rehber: CLI version, searchable slash commands/flags and the project's own commands", async () => {
    setup();
    await flush();
    fireEvent.click(tab("Rehber"));
    expect(within(panel()).getByText(new RegExp(claudeGuide().cliVersion.replace(/\./g, "\\.")))).toBeTruthy();
    expect(within(panel()).getByText("/compact")).toBeTruthy();
    expect(within(panel()).getByText("/yayinla")).toBeTruthy();
    fireEvent.change(search(), { target: { value: "worktree" } });
    expect(within(panel()).queryByText("/compact")).toBeNull();
    expect(within(panel()).getByText("-w, --worktree [ad]")).toBeTruthy();
    expect(within(panel()).queryByText("/yayinla")).toBeNull();
    fireEvent.change(search(), { target: { value: "yayınla" } });
    expect(within(panel()).getByText("/yayinla")).toBeTruthy();
  });

  it("a reveal with tab 'rehber' opens Rehber (again on each new request)", async () => {
    const { rerenderWith } = setup();
    await flush();
    rerenderWith({ focus: { tab: CLAUDE_HELP_TAB, seq: 1 } });
    expect(tab("Rehber").getAttribute("aria-selected")).toBe("true");
    fireEvent.click(tab("Skill'ler"));
    rerenderWith({ focus: { tab: CLAUDE_HELP_TAB, seq: 1 } });
    expect(tab("Skill'ler").getAttribute("aria-selected")).toBe("true");
    rerenderWith({ focus: { tab: CLAUDE_HELP_TAB, seq: 2 } });
    expect(tab("Rehber").getAttribute("aria-selected")).toBe("true");
  });

  it("card: asks for the card's inventory", async () => {
    const { client } = setup({ card: makeCard("c1", "p1") });
    await flush();
    expect(client.calls.find((c) => c.method === "claude.inventory")?.params).toEqual({ cardId: "c1" });
  });

  it("shows the engine's note (SSH) and truncation", async () => {
    setup({
      project: makeSshProject("s1", "Uzak", "h1"),
      inventory: { ...INVENTORY, truncated: true, note: "SSH projesi: yalnız hesap düzeyi gösteriliyor." },
    });
    await flush();
    expect(within(panel()).getByText("SSH projesi: yalnız hesap düzeyi gösteriliyor.")).toBeTruthy();
    expect(within(panel()).getByText(/daha çok öğe var/)).toBeTruthy();
  });

  it("an engine error is shown; Rehber still works", async () => {
    const client = new FakeEngineClient({ projects: [project] });
    client.fail("claude.inventory", "INVALID", "Claude envanteri bu motorda kapalı");
    setup({ client });
    await flush();
    expect(within(panel()).getByRole("alert").textContent).toBe("Claude envanteri bu motorda kapalı");
    fireEvent.click(tab("Rehber"));
    expect(within(panel()).getByText("/help")).toBeTruthy();
  });

  it("without a project: inventory tabs say so, Rehber works", async () => {
    const { client } = setup({ project: null });
    await flush();
    expect(client.calls.some((c) => c.method === "claude.inventory")).toBe(false);
    expect(within(panel()).getByText("Proje seçilmedi.")).toBeTruthy();
    fireEvent.click(tab("Rehber"));
    expect(within(panel()).getByText("/help")).toBeTruthy();
  });

  it("monkey: odd search input and a junk persisted tab never break it", async () => {
    const state = new MemoryPanelState();
    state.set("tab", { evil: true });
    setup({ state });
    await flush();
    expect(tab("Skill'ler").getAttribute("aria-selected")).toBe("true");
    for (const q of ["(", "[", "\\", "*", "\u0000", "🙂", "a".repeat(5000)]) {
      fireEvent.change(search(), { target: { value: q } });
    }
    fireEvent.click(tab("Rehber"));
    fireEvent.change(search(), { target: { value: "((" } });
    expect(panel()).toBeTruthy();
  });
});
