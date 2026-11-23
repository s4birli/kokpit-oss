import type { TerminalInfo } from "@kokpit/shared";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workbench } from "./Workbench.tsx";
import { defaultUiConfig } from "./config.ts";
import { FakeEngineClient, makeCard, makeProject, makeTerminal } from "./test-utils/fake-client.ts";
import { FakeResizeObserver, makeFakeViewFactory } from "./test-utils/fake-view.ts";
import { activeTerminalTitle, launchTerminal, showTerminal, terminalTabTitles } from "./test-utils/terminal-tabs.ts";
import { menuToggle } from "./test-utils/fake-menu.ts";

const flush = () => act(async () => {});

function seed() {
  return new FakeEngineClient({
    projects: [makeProject("p1", "Alfa"), makeProject("p2", "Beta")],
    cards: [makeCard("a", "p1", "Kart A"), makeCard("b", "p1", "Kart B"), makeCard("c", "p2", "Kart C")],
    terminals: [makeTerminal("ta1", "a", "A-1"), makeTerminal("ta2", "a", "A-2"), makeTerminal("tb1", "b", "B-1")],
  });
}

async function setup(client = seed()) {
  const views = makeFakeViewFactory();
  const onOpenSettings = vi.fn();
  render(<Workbench client={client} onOpenSettings={onOpenSettings} createView={views.factory} />);
  await flush();
  return { client, views, onOpenSettings };
}

const rail = () => screen.getByRole("navigation");
const cardButton = (name: string) => within(rail()).getByRole("button", { name });
async function selectCard(name: string) {
  fireEvent.click(cardButton(name));
  await flush();
}

beforeEach(() => {
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Workbench", () => {
  it("rail lists projects with their cards nested", async () => {
    const { client } = await setup();
    expect(client.callsOf("projects.list")).toHaveLength(1);
    expect(client.callsOf("cards.list")).toEqual([{ projectId: "p1" }, { projectId: "p2" }]);
    const alfa = within(rail()).getByRole("group", { name: "Alfa" });
    expect(within(alfa).getByRole("button", { name: "Kart A" })).toBeTruthy();
    expect(within(alfa).getByRole("button", { name: "Kart B" })).toBeTruthy();
    const beta = within(rail()).getByRole("group", { name: "Beta" });
    expect(within(beta).getByRole("button", { name: "Kart C" })).toBeTruthy();
    expect(within(rail()).getByText("Kokpit")).toBeTruthy();
    expect(within(rail()).getByText("Projeler")).toBeTruthy();
  });

  it("selecting a card shows its header and one tab per terminal, every terminal attached", async () => {
    const { client, views } = await setup();
    await selectCard("Kart A");
    expect(cardButton("Kart A").getAttribute("aria-current")).toBe("true");
    const main = screen.getByRole("main");
    expect(within(main).getByRole("heading", { name: "Kart A" })).toBeTruthy();
    expect(within(main).getByText("Alfa / kokpit/a")).toBeTruthy();
    // The card's line is part of the tab strip's row and carries no launcher; no header row follows it.
    const bar = within(main).getByRole("group", { name: "Seçili kart" });
    expect(bar.parentElement?.classList.contains("kp-topbar")).toBe(true);
    expect(within(bar).getByRole("heading", { name: "Kart A" })).toBeTruthy();
    expect(bar.querySelector("form")).toBeNull();
    expect(document.querySelector(".kp-header")).toBeNull();
    expect(client.callsOf("terminals.list")).toEqual([{ cardId: "a" }]);
    expect(terminalTabTitles()).toEqual(["A-1", "A-2"]);
    // The first tab is on screen; the other one is mounted and attached, only hidden.
    expect(screen.getByRole("region", { name: "Terminal: A-1" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Terminal: A-2" })).toBeNull();
    expect(views.views).toHaveLength(2);
    expect(client.callsOf("terminal.attach").map((p) => p.terminalId).sort()).toEqual(["ta1", "ta2"]);
    await showTerminal("A-2");
    expect(screen.getByRole("region", { name: "Terminal: A-2" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Terminal: A-1" })).toBeNull();
    // Switching tabs neither creates views nor re-attaches.
    expect(views.views).toHaveLength(2);
    expect(client.callsOf("terminal.attach")).toHaveLength(2);
  });

  it("creates a card inline and selects it", async () => {
    const { client } = await setup();
    fireEvent.click(within(rail()).getByRole("button", { name: "Yeni kart: Alfa" }));
    const confirm = within(rail()).getByRole("button", { name: "Oluştur" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(rail()).getByLabelText("Kart adı"), { target: { value: "  Yeni iş " } });
    fireEvent.click(confirm);
    await flush();
    expect(client.callsOf("cards.create")).toEqual([{ projectId: "p1", name: "Yeni iş" }]);
    expect(cardButton("Yeni iş").getAttribute("aria-current")).toBe("true");
    expect(within(screen.getByRole("main")).getByRole("heading", { name: "Yeni iş" })).toBeTruthy();
  });

  it("shows create errors inline", async () => {
    const client = seed();
    client.fail("cards.create", "GIT_FAILED", "branch zaten var");
    await setup(client);
    fireEvent.click(within(rail()).getByRole("button", { name: "Yeni kart: Alfa" }));
    fireEvent.change(within(rail()).getByLabelText("Kart adı"), { target: { value: "x" } });
    fireEvent.click(within(rail()).getByRole("button", { name: "Oluştur" }));
    await flush();
    expect(within(rail()).getByRole("alert").textContent).toContain("branch zaten var");
  });

  it("delete asks for confirmation; a dirty worktree keeps the card and shows the engine message", async () => {
    const client = seed();
    client.fail("cards.delete", "DIRTY_WORKTREE", "Commit edilmemiş değişiklikler var: src/a.ts");
    await setup(client);
    await selectCard("Kart A");
    fireEvent.click(screen.getByRole("button", { name: "Kartı sil" }));
    expect(client.callsOf("cards.delete")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Silmeyi onayla" }));
    await flush();
    expect(client.callsOf("cards.delete")).toEqual([{ cardId: "a" }]);
    expect(screen.getByText("Commit edilmemiş değişiklikler var: src/a.ts")).toBeTruthy();
    expect(cardButton("Kart A")).toBeTruthy();
  });

  it("successful delete removes the card and clears the selection", async () => {
    const { client } = await setup();
    await selectCard("Kart B");
    fireEvent.click(screen.getByRole("button", { name: "Kartı sil" }));
    fireEvent.click(screen.getByRole("button", { name: "Silmeyi onayla" }));
    await flush();
    expect(client.callsOf("cards.delete")).toEqual([{ cardId: "b" }]);
    expect(within(rail()).queryByRole("button", { name: "Kart B" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Terminal: B-1" })).toBeNull();
  });

  it("new terminal sends command and initial size, and becomes the active tab; empty command is omitted", async () => {
    const { client } = await setup();
    await selectCard("Kart B");
    await launchTerminal("  benim-aracim --x ");
    expect(activeTerminalTitle()).toBe("benim-aracim --x");
    expect(screen.getByRole("region", { name: "Terminal: benim-aracim --x" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Terminal: B-1" })).toBeNull();
    await launchTerminal("   ");
    const opens = client.callsOf("terminal.open");
    expect(opens[0]).toEqual({ cardId: "b", ...defaultUiConfig.fallbackDims, command: "benim-aracim --x" });
    // No tool chosen ("Yalnız kabuk") → explicit plain shell, so the engine's defaults do not apply.
    expect(opens[1]).toEqual({ cardId: "b", ...defaultUiConfig.fallbackDims, toolId: null });
    expect(Object.hasOwn(opens[1]!, "command")).toBe(false);
    const second = client.terminals.at(-1)!;
    expect(terminalTabTitles()).toEqual(["B-1", "benim-aracim --x", second.title]);
    expect(activeTerminalTitle()).toBe(second.title);
    expect(screen.getAllByRole("region", { name: /^Terminal: / })).toHaveLength(1);
  });

  it("switching cards unmounts the old panels and never writes A's output into B", async () => {
    const { client, views } = await setup();
    await selectCard("Kart A");
    const aViews = [...views.views];
    await selectCard("Kart B");
    expect(aViews.every((v) => v.disposed)).toBe(true);
    expect(client.callsOf("terminal.detach").map((p) => p.terminalId).sort()).toEqual(["ta1", "ta2"]);
    const bView = views.views[2]!;
    act(() => {
      client.emitOutput("ta1", "A-çıktısı");
      client.emitOutput("tb1", "B-çıktısı");
    });
    expect(bView.screen).toBe("B-çıktısı");
    expect(aViews.every((v) => v.writesAfterDispose.length === 0 && v.screen === "")).toBe(true);
  });

  it("a slow terminals.list for the previous card does not leak into the new one", async () => {
    const client = seed();
    let releaseA: (t: { terminals: TerminalInfo[] }) => void = () => {};
    client.respond("terminals.list", ({ cardId }) =>
      cardId === "a"
        ? new Promise((res) => {
            releaseA = res;
          })
        : { terminals: client.terminals.filter((t) => t.cardId === cardId) },
    );
    await setup(client);
    await selectCard("Kart A");
    await selectCard("Kart B");
    await act(async () => releaseA({ terminals: [makeTerminal("ta1", "a", "A-1")] }));
    expect(screen.queryByRole("region", { name: "Terminal: A-1" })).toBeNull();
    expect(screen.getByRole("region", { name: "Terminal: B-1" })).toBeTruthy();
  });

  it("shows the reconnect banner, keeps panels mounted and re-attaches on reconnect", async () => {
    const { client, views } = await setup();
    await selectCard("Kart B");
    act(() => client.setState("reconnecting"));
    expect(screen.getByRole("status").textContent).toContain("Motora ulaşılamıyor");
    expect(views.views[0]!.disposed).toBe(false);
    act(() => client.emitReconnected());
    await flush();
    expect(screen.queryByRole("status")).toBeNull();
    expect(client.callsOf("terminal.attach").filter((p) => p.terminalId === "tb1")).toHaveLength(2);
    expect(client.callsOf("projects.list")).toHaveLength(2);
    expect(views.views).toHaveLength(1);
  });

  it("shows a connecting banner and loads once connected", async () => {
    const client = seed();
    client.state = "connecting";
    await setup(client);
    expect(screen.getByRole("status").textContent).toContain("Bağlanıyor");
    act(() => client.setState("open"));
    await flush();
    expect(cardButton("Kart A")).toBeTruthy();
  });

  it("cards.changed reloads that project's cards", async () => {
    const { client } = await setup();
    client.cards.push(makeCard("d", "p2", "Kart D"));
    act(() => client.emitEvent({ type: "event", name: "cards.changed", projectId: "p2" }));
    await flush();
    expect(cardButton("Kart D")).toBeTruthy();
    expect(client.callsOf("cards.list").at(-1)).toEqual({ projectId: "p2" });
  });

  it("terminals.changed reloads terminals of the selected card only", async () => {
    const { client } = await setup();
    await selectCard("Kart B");
    client.terminals.push(makeTerminal("tb2", "b", "B-2"));
    act(() => client.emitEvent({ type: "event", name: "terminals.changed", projectId: "p1", cardId: "a" }));
    await flush();
    expect(client.callsOf("terminals.list")).toHaveLength(1);
    act(() => client.emitEvent({ type: "event", name: "terminals.changed", projectId: "p1", cardId: "b" }));
    await flush();
    expect(terminalTabTitles()).toEqual(["B-1", "B-2"]);
    await showTerminal("B-2");
    expect(screen.getByRole("region", { name: "Terminal: B-2" })).toBeTruthy();
  });

  it("shows request errors inline with the engine message", async () => {
    const client = seed();
    client.fail("projects.list", "INTERNAL", "ayar dosyası okunamadı");
    await setup(client);
    expect(screen.getByRole("alert").textContent).toContain("ayar dosyası okunamadı");
  });

  it("settings button calls onOpenSettings", async () => {
    const { onOpenSettings } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Ayarlar" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("shows placeholders, and the second view's placeholders", async () => {
    await setup();
    await selectCard("Kart A");
    // İş A: "Görev akışı" became the Ajanlar panel. İş L: Dosyalar is open.
    for (const title of ["Ajanlar", "Tarayıcı", "Dosyalar"]) {
      // The dock tab shows the name; the panel keeps it for assistive tech only (no title row).
      const heading = screen.getByRole("heading", { name: title });
      expect(heading.classList.contains("kp-visually-hidden")).toBe(true);
      expect(heading.closest(".kp-panel__head")).toBeNull();
      expect(screen.getByRole("region", { name: title })).toBeTruthy();
    }
    // No dock panel has a title row; Ajanlar (no actions) has no bar at all.
    expect(document.querySelector(".kp-dock-panel .kp-panel__head")).toBeNull();
    expect(document.querySelector('.kp-dock-panel[data-panel-id="agents"] .kp-panel__bar')).toBeNull();
    expect(screen.getByRole("button", { name: "Tarayıcıyı aç" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Yapılacaklar" }));
    expect(screen.getByRole("heading", { name: "Yapılacaklar" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Çalışma" }));
    // Tarayıcı is still there, one tab away.
    expect(screen.getByRole("tab", { name: "Tarayıcı" })).toBeTruthy();
  });

  it("does not render out-of-scope features", async () => {
    await setup();
    await selectCard("Kart A");
    const text = document.body.textContent ?? "";
    for (const s of ["⌘K", "Hepsini duraklat", "Seni bekleyen", "Değişiklikler"]) {
      expect(text).not.toContain(s);
    }
  });
});
