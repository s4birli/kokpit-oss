// İş A (Adım 7) — arka plan ajanları: Ajanlar panel sections, actions, rail "Seni bekleyen" and counters.
import type { BgAgentSession } from "@kokpit/shared";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workbench } from "./Workbench.tsx";
import { FakeEngineClient, makeBgAgent, makeCard, makeProject, makeProjectTerminal } from "./test-utils/fake-client.ts";
import { FakeResizeObserver, makeFakeViewFactory, type FakeViewFactory } from "./test-utils/fake-view.ts";

const flush = () => act(async () => {});
const NOW = Date.parse("2026-11-16T10:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MONKEY_STEPS = 120;
const MONKEY_TIMEOUT_MS = 30_000;

function seed(extra: BgAgentSession[] = []) {
  return new FakeEngineClient({
    projects: [makeProject("mac", "Mac mini", { builtin: true }), makeProject("p1", "Alfa"), makeProject("p2", "Beta")],
    cards: [makeCard("k1", "p1", "Kart A")],
    terminals: [makeProjectTerminal("tp1", "p1", "zsh")],
    bgAgents: [
      makeBgAgent("w-onay", "waiting", { name: "Testleri düzelt", projectId: "p1", startedAt: ago(10 * 60_000) }),
      makeBgAgent("w-sira", "waiting", { name: "Kart işi", projectId: "p1", cardId: "k1", waitingReason: "input", startedAt: ago(3 * 60_000) }),
      makeBgAgent("r1", "running", { name: "Derleme", projectId: "p1", startedAt: ago(42_000) }),
      makeBgAgent("d1", "done", { name: "Eski iş", projectId: "p1", startedAt: ago(2 * 3_600_000) }),
      makeBgAgent("b1", "running", { name: "Beta işi", projectId: "p2" }),
      makeBgAgent("x1", "waiting", { name: "Başıboş", startedAt: ago(60 * 60_000) }),
      ...extra,
    ],
  });
}

let views: FakeViewFactory;

async function setup(client = seed()) {
  views = makeFakeViewFactory();
  render(<Workbench client={client} onOpenSettings={() => {}} createView={views.factory} />);
  await flush();
  return client;
}

const rail = () => screen.getByRole("navigation");
const main = () => screen.getByRole("main");
const agentsPanel = () => within(main()).getByRole("region", { name: "Ajanlar" });
const bgSection = () => within(agentsPanel()).getByRole("region", { name: "Arka plan ajanları" });
const group = (title: string) => within(bgSection()).getByRole("list", { name: title });
const rowOf = (id: string) => bgSection().querySelector<HTMLElement>(`[data-bg-agent-id="${id}"]`);
const waitingSection = () => within(rail()).getByRole("region", { name: "Seni bekleyen" });
const headerTitle = () => document.querySelector(".kp-header__title")?.textContent;

async function selectProject(name: string) {
  fireEvent.click(within(rail()).getByRole("button", { name }));
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Ajanlar: Terminaller and Arka plan ajanları", () => {
  it("shows both sections; background sessions of the selected project grouped, Bitti collapsed", async () => {
    await setup();
    await selectProject("Alfa");
    expect(within(agentsPanel()).getByRole("heading", { name: "Terminaller" })).toBeTruthy();
    expect(within(agentsPanel()).getByRole("list", { name: "Terminaller" }).textContent).toContain("zsh");
    expect(within(group("Seni bekliyor")).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      expect.stringMatching(/Kart işi.*sıra sende.*3 dk önce/),
      expect.stringMatching(/Testleri düzelt.*onay bekliyor.*10 dk önce/),
    ]);
    expect(within(group("Çalışıyor")).getAllByRole("listitem")).toHaveLength(1);
    // Kopyalama: right click on a row offers the session id.
    for (const li of within(group("Seni bekliyor")).getAllByRole("listitem")) {
      expect(li.getAttribute("data-copy")).toBeTruthy();
      expect(li.getAttribute("data-copy")).toBe(li.getAttribute("data-bg-agent-id"));
    }
    const bitti = within(bgSection()).getByRole("button", { name: "Bitti (1)" });
    expect(bitti.getAttribute("aria-expanded")).toBe("false");
    expect(within(bgSection()).queryByRole("list", { name: "Bitti" })).toBeNull();
    fireEvent.click(bitti);
    expect(within(group("Bitti")).getByText("Eski iş")).toBeTruthy();
    // Done sessions cannot be stopped.
    expect(within(group("Bitti")).queryByRole("button", { name: /Durdur/ })).toBeNull();
    expect(bgSection().textContent).not.toContain("Beta işi");
    expect(bgSection().textContent).not.toContain("Başıboş");
  });

  it("Tüm projeler lists every session with its place; unmatched ones under Diğer", async () => {
    await setup();
    await selectProject("Alfa");
    fireEvent.click(within(bgSection()).getByRole("checkbox", { name: "Tüm projeler" }));
    expect(rowOf("b1")!.textContent).toContain("Beta");
    expect(rowOf("x1")!.textContent).toContain("Diğer");
    expect(rowOf("w-sira")!.textContent).toContain("Alfa › Kart A");
  });

  it("says so when the project has no background agents", async () => {
    const client = seed();
    client.bgAgents = [];
    await setup(client);
    await selectProject("Beta");
    expect(within(bgSection()).getByText("Bu projede arka plan ajanı yok.")).toBeTruthy();
  });

  it("Bağlan opens a terminal with `claude attach <id>` in the session's card and focuses it", async () => {
    const client = await setup();
    await selectProject("Alfa");
    fireEvent.click(within(bgSection()).getByRole("button", { name: "Bağlan: Kart işi" }));
    await flush();
    expect(client.callsOf("bgAgents.attach")).toEqual([{ id: "w-sira", cols: 80, rows: 24 }]);
    const opened = client.terminals.at(-1)!;
    expect(opened).toMatchObject({ projectId: "p1", cardId: "k1", command: "claude attach w-sira" });
    expect(within(rail()).getByRole("button", { name: "Kart A" }).getAttribute("aria-current")).toBe("true");
    await flush();
    const view = views.views.find((v) => !v.disposed && v.container?.closest(`[data-terminal-id="${opened.id}"]`));
    expect(view?.focuses).toBe(1);
  });

  it("Bağlan errors are shown on the row", async () => {
    const client = await setup();
    client.fail("bgAgents.attach", "CLAUDE_FAILED", "claude bu makinede bulunamadı (claude).");
    await selectProject("Alfa");
    fireEvent.click(within(bgSection()).getByRole("button", { name: "Bağlan: Derleme" }));
    await flush();
    expect(within(rowOf("r1")!).getByRole("alert").textContent).toBe("Bağlanılamadı: claude bu makinede bulunamadı (claude).");
  });

  it("Kayıtlar opens a drawer with the text; Kapat closes it", async () => {
    const client = await setup();
    client.bgAgentLogs["r1"] = "satır 1\nsatır 2";
    await selectProject("Alfa");
    fireEvent.click(within(bgSection()).getByRole("button", { name: "Kayıtlar: Derleme" }));
    await flush();
    const drawer = within(bgSection()).getByRole("dialog", { name: "Kayıtlar: Derleme" });
    expect(drawer.querySelector("pre")!.textContent).toBe("satır 1\nsatır 2");
    fireEvent.click(within(drawer).getByRole("button", { name: "Kapat" }));
    expect(within(bgSection()).queryByRole("dialog")).toBeNull();
  });

  it("Kayıtlar shows engine errors", async () => {
    const client = await setup();
    client.fail("bgAgents.logs", "CLAUDE_FAILED", "claude 15 saniyede yanıt vermedi.");
    await selectProject("Alfa");
    fireEvent.click(within(bgSection()).getByRole("button", { name: "Kayıtlar: Derleme" }));
    await flush();
    expect(within(bgSection()).getByRole("dialog").textContent).toContain("Kayıtlar alınamadı: claude 15 saniyede yanıt vermedi.");
  });

  it("Durdur asks first; Vazgeç does nothing, Evet stops", async () => {
    const client = await setup();
    await selectProject("Alfa");
    fireEvent.click(within(bgSection()).getByRole("button", { name: "Durdur: Derleme" }));
    fireEvent.click(within(rowOf("r1")!).getByRole("button", { name: "Vazgeç" }));
    expect(client.callsOf("bgAgents.stop")).toEqual([]);
    fireEvent.click(within(bgSection()).getByRole("button", { name: "Durdur: Derleme" }));
    expect(within(rowOf("r1")!).getByText("Durdurulsun mu?")).toBeTruthy();
    fireEvent.click(within(rowOf("r1")!).getByRole("button", { name: "Evet, durdur" }));
    await flush();
    expect(client.callsOf("bgAgents.stop")).toEqual([{ id: "r1" }]);
  });

  it("reloads on bgAgents.changed and shows the engine's list error", async () => {
    const client = await setup();
    await selectProject("Beta");
    client.bgAgents.push(makeBgAgent("b2", "waiting", { name: "Yeni Beta", projectId: "p2" }));
    client.bgAgentsError = "claude bu makinede bulunamadı (claude).";
    act(() => client.emitEvent({ type: "event", name: "bgAgents.changed" }));
    await flush();
    expect(within(group("Seni bekliyor")).getByText("Yeni Beta")).toBeTruthy();
    expect(within(bgSection()).getByRole("alert").textContent).toBe("claude bu makinede bulunamadı (claude).");
  });
});

describe("rail with background agents", () => {
  it("counters include background agents", async () => {
    await setup();
    // Alfa: r1 running; w-onay + w-sira waiting (terminal tp1 has no activity).
    expect(within(rail()).getByLabelText("Alfa: 1 çalışıyor, 2 seni bekliyor")).toBeTruthy();
    expect(within(rail()).getByLabelText("Beta: 1 çalışıyor, 0 seni bekliyor")).toBeTruthy();
  });

  it("Seni bekleyen lists waiting background agents with their reason, longest waiting first", async () => {
    await setup();
    const items = within(waitingSection()).getAllByRole("button");
    expect(items.map((b) => b.textContent)).toEqual([
      expect.stringMatching(/Başıboş.*Diğer · onay bekliyor/),
      expect.stringMatching(/Testleri düzelt.*Alfa · onay bekliyor/),
      expect.stringMatching(/Kart işi.*Alfa › Kart A · sıra sende/),
    ]);
  });

  it("clicking one selects its project and offers Bağlan (marked and focused)", async () => {
    await setup();
    fireEvent.click(within(waitingSection()).getByRole("button", { name: /Testleri düzelt/ }));
    await flush();
    expect(headerTitle()).toBe("Alfa");
    const row = rowOf("w-onay")!;
    expect(row.className).toContain("kp-bga__row--marked");
    expect(document.activeElement).toBe(within(row).getByRole("button", { name: "Bağlan: Testleri düzelt" }));
  });

  it("an unmatched one selects the built-in project and switches to Tüm projeler", async () => {
    await setup();
    fireEvent.click(within(waitingSection()).getByRole("button", { name: /Başıboş/ }));
    await flush();
    expect(headerTitle()).toBe("Mac mini");
    expect((within(bgSection()).getByRole("checkbox", { name: "Tüm projeler" }) as HTMLInputElement).checked).toBe(true);
    expect(document.activeElement).toBe(within(rowOf("x1")!).getByRole("button", { name: "Bağlan: Başıboş" }));
  });
});

describe("background agents monkey", () => {
  it("random lists, events and clicks never crash and the waiting list matches the sessions", async () => {
    let s = 11;
    const rnd = (n: number) => {
      s = (s * 1103515245 + 12345) % 2 ** 31;
      return s % n;
    };
    const states = ["running", "waiting", "done"] as const;
    const names = ["", "x", "🚀çğış", "<b>kalın</b>", "a".repeat(500), "\u0000"];
    const projectIds = [undefined, "p1", "p2", "yok"];
    const client = await setup();
    for (let step = 0; step < MONKEY_STEPS; step++) {
      const r = rnd(10);
      await act(async () => {
        if (r < 4) {
          client.bgAgents = Array.from({ length: rnd(6) }, (_, i) => {
            const state = states[rnd(states.length)]!;
            const projectId = projectIds[rnd(projectIds.length)];
            return makeBgAgent(`m${step}-${i}`, state, {
              name: names[rnd(names.length)]!,
              ...(projectId !== undefined ? { projectId } : {}),
              ...(rnd(2) ? { startedAt: ago(rnd(10_000_000)) } : { startedAt: "bozuk" }),
              ...(state === "waiting" ? { waitingReason: rnd(2) ? "approval" : "input" } : {}),
            });
          });
          client.emitEvent({ type: "event", name: "bgAgents.changed" });
        } else {
          const buttons = [
            ...within(rail()).queryAllByRole("button"),
            ...within(main()).queryAllByRole("button"),
            ...within(main()).queryAllByRole("checkbox"),
          ].filter((b) => !/Ayarlar|Yapılacaklar|Yeni kart|Yeni terminal|Kartı sil/.test(b.textContent ?? ""));
          if (buttons.length) fireEvent.click(buttons[rnd(buttons.length)]!);
        }
      });
      await flush();
      const waiting = client.bgAgents.filter((x) => x.state === "waiting").length;
      // Expanded, the sessions are listed; collapsed, the rail shows only their number (no badge when none waits).
      const badge = within(rail()).queryByRole("button", { name: /oturum seni bekliyor$/ });
      const listed = within(rail()).queryAllByRole("region", { name: "Seni bekleyen" }).length
        ? waitingSection().querySelectorAll("[data-bg-agent-id]").length
        : Number(badge?.textContent ?? 0);
      expect(listed).toBe(waiting);
    }
  }, MONKEY_TIMEOUT_MS);
});
