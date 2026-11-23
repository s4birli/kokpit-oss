// Monkey test: random interleavings of events, output, connection state and card switches.
import type { Method } from "@kokpit/shared";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workbench } from "./Workbench.tsx";
import {
  FakeEngineClient,
  makeCard,
  makeHost,
  makeProject,
  makeProjectTerminal,
  makeSshProject,
  makeTerminal,
  makeTool,
} from "./test-utils/fake-client.ts";
import { FakeResizeObserver, makeFakeViewFactory, type FakeTerminalView } from "./test-utils/fake-view.ts";

/** mulberry32: small seeded PRNG so failures are reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** jsdom renders (the dock included) are slow when the whole suite runs in parallel. */
const MONKEY_TIMEOUT_MS = 30_000;
const NASTY = ["", "\u0000", "\x1b[2J\x1b[H", "🚀çğış", "x".repeat(5000), "\r\n", "<script>alert(1)</script>"];
const FAILABLE: Method[] = [
  "cards.list",
  "terminals.list",
  "terminal.attach",
  "terminal.detach",
  "projects.list",
  "tools.list",
  "sshHosts.list",
  "terminal.open",
];

beforeEach(() => {
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function terminalIdOf(view: FakeTerminalView): string | undefined {
  const label = view.container?.closest("section")?.getAttribute("aria-label") ?? "";
  return label.startsWith("Terminal: ") ? label.slice("Terminal: ".length) : undefined;
}

describe("Workbench monkey", () => {
  for (const seed of [1, 7, 42, 1337, 2024, 9001]) {
    it(`survives random interleavings (seed ${seed})`, async () => {
      const rnd = prng(seed);
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;

      const client = new FakeEngineClient({
        projects: [
          makeProject("p1", "Alfa", { defaultToolId: "t1" }),
          makeProject("p2", "Beta"),
          makeSshProject("p3", "Uzak", "h1"),
          makeProject("home", "Ev", { builtin: true }),
        ],
        cards: [makeCard("a", "p1", "Kart A"), makeCard("b", "p1", "Kart B"), makeCard("c", "p2", "Kart C")],
        terminals: [
          makeTerminal("ta1", "a", "ta1", "p1"),
          makeTerminal("ta2", "a", "ta2", "p1"),
          makeTerminal("tb1", "b", "tb1", "p1"),
          makeTerminal("tc1", "c", "tc1", "p2"),
          makeProjectTerminal("tp1", "p1"),
          makeProjectTerminal("tq1", "p3"),
        ],
        hosts: [makeHost("h1", "oracle")],
        tools: [makeTool("t1", "Birinci")],
      });
      const views = makeFakeViewFactory();
      const { unmount } = render(<Workbench client={client} onOpenSettings={() => {}} createView={views.factory} />);
      await act(async () => {});

      const allTerminalIds = () => client.terminals.map((t) => t.id).concat(["ghost"]);
      let extra = 0;

      for (let step = 0; step < 150; step++) {
        const action = Math.floor(rnd() * 19);
        await act(async () => {
          switch (action) {
            case 0:
            case 1: {
              const buttons = within(screen.getByRole("navigation"))
                .queryAllByRole("button")
                .filter((b) => b.className.includes("kp-card"));
              if (buttons.length) fireEvent.click(pick(buttons));
              break;
            }
            case 2:
            case 3: {
              const id = pick(allTerminalIds());
              client.emitOutput(id, `[${id}]${pick(NASTY)}`, rnd() < 0.3);
              break;
            }
            case 4:
              client.emitExit(pick(allTerminalIds()), rnd() < 0.5 ? null : Math.floor(rnd() * 256));
              break;
            case 5:
              client.emitEvent({ type: "event", name: "cards.changed", projectId: pick(["p1", "p2", "nope"]) });
              break;
            case 6:
              client.emitEvent({ type: "event", name: "terminals.changed", projectId: pick(["p1", "p2"]), cardId: pick(["a", "b", "c", "nope"]) });
              break;
            case 7:
              client.setState(pick(["reconnecting", "connecting", "open", "unauthorized"] as const));
              break;
            case 8:
              client.emitReconnected();
              break;
            case 9: {
              const cardId = pick(["a", "b", "c"]);
              client.terminals.push(makeTerminal(`x${++extra}`, cardId));
              break;
            }
            case 10:
              if (client.terminals.length) client.terminals.splice(Math.floor(rnd() * client.terminals.length), 1);
              break;
            case 11: {
              const m = pick(FAILABLE);
              if (rnd() < 0.5) client.fail(m, "INTERNAL", `bozuk ${m}`);
              else client.restore(m);
              break;
            }
            case 12:
              fireEvent.click(screen.getByRole("button", { name: rnd() < 0.5 ? "Çalışma" : "Yapılacaklar" }));
              break;
            case 13:
              FakeResizeObserver.triggerAll();
              views.dims = { cols: 1 + Math.floor(rnd() * 300), rows: 1 + Math.floor(rnd() * 100) };
              for (const v of views.views) v.dims = views.dims;
              break;
            case 14:
            case 15: {
              const buttons = Array.from(screen.getByRole("navigation").querySelectorAll<HTMLElement>(".kp-project__name"));
              if (buttons.length) fireEvent.click(pick(buttons));
              break;
            }
            case 16: {
              const r = rnd();
              if (r < 0.4) {
                client.emitEvent({ type: "event", name: "terminals.changed", projectId: pick(["p1", "p2", "p3", "nope"]) });
              } else if (r < 0.6) {
                client.terminals.push(makeProjectTerminal(`y${++extra}`, pick(["p1", "p2", "p3", "home"])));
              } else {
                client.emitEvent({ type: "event", name: pick(["projects.changed", "tools.changed", "sshHosts.changed"] as const) });
              }
              break;
            }
            case 17: {
              // Open a plain-shell terminal (title = id, so the output check below still holds).
              // The launcher is the Terminal panel's: its menu, or the empty panel's own.
              const toggle = screen.queryByRole("button", { name: "+ Yeni terminal ▾" });
              if (toggle && !screen.queryByRole("group", { name: "Yeni terminal" })) fireEvent.click(toggle);
              const launcher = screen.queryByRole("group", { name: "Yeni terminal" });
              if (launcher) {
                fireEvent.change(within(launcher).getByLabelText("Araç"), { target: { value: "" } });
                fireEvent.click(within(launcher).getByRole("button", { name: "Yeni terminal" }));
              }
              break;
            }
            case 18: {
              // İş T: switch terminal tabs, or toggle "böl".
              const tabs = screen.queryByRole("tablist", { name: "Terminal sekmeleri" });
              const split = screen.queryByRole("button", { name: "Böl" });
              const targets = [...(tabs ? within(tabs).queryAllByRole("tab") : []), ...(split ? [split] : [])];
              if (targets.length) fireEvent.click(pick(targets));
              break;
            }
          }
        });
        await act(async () => {});

        for (const v of views.views) {
          expect(v.writesAfterDispose).toEqual([]);
          if (v.disposed) continue;
          const id = terminalIdOf(v);
          expect(id).toBeDefined();
          for (const w of v.writes) expect(w.startsWith(`[${id}]`)).toBe(true);
        }
      }

      unmount();
      await act(async () => {});
      expect(views.views.every((v) => v.disposed)).toBe(true);
      expect(views.views.every((v) => v.writesAfterDispose.length === 0)).toBe(true);
      expect(client.listenerCounts()).toEqual({ state: 0, event: 0, reconnect: 0, output: 0, exit: 0 });
    }, MONKEY_TIMEOUT_MS);
  }
});
