// Monkey test at the app level: project/card switches interleaved with opening, navigating and
// closing the settings screen, engine events and connection drops.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.tsx";
import type { SettingsBridge } from "./engine/types.ts";
import {
  FakeEngineClient,
  makeCard,
  makeHost,
  makeProject,
  makeProjectTerminal,
  makeSshProject,
  makeTerminal,
  makeTool,
} from "./ui/test-utils/fake-client.ts";
import { FakeResizeObserver, makeFakeViewFactory } from "./ui/test-utils/fake-view.ts";

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

beforeEach(() => {
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("App monkey", () => {
  for (const seed of [3, 11, 99, 2025]) {
    it(`survives project switches and settings open/close (seed ${seed})`, async () => {
      const rnd = prng(seed);
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
      const client = new FakeEngineClient({
        projects: [
          makeProject("p1", "Alfa", { defaultToolId: "t1" }),
          makeSshProject("p3", "Uzak", "h1"),
          makeProject("home", "Ev", { builtin: true }),
        ],
        cards: [makeCard("a", "p1", "Kart A")],
        terminals: [makeTerminal("ta1", "a", "ta1", "p1"), makeProjectTerminal("tp1", "p1"), makeProjectTerminal("tq1", "p3")],
        hosts: [makeHost("h1", "oracle"), makeHost("cfg", "cfg", { source: "ssh-config" })],
        keys: ["id_ed25519"],
        tools: [makeTool("t1", "Birinci", { installCommand: "kur" })],
        toolStatuses: [{ toolId: "t1", installed: false }],
      });
      const bridge: SettingsBridge = {
        load: async () => ({ url: "ws://e.test:1", key: "k" }),
        save: async () => {},
        clear: async () => {},
      };
      const views = makeFakeViewFactory();
      const { unmount } = render(<App bridge={bridge} createClient={() => client} createView={views.factory} />);
      await act(async () => {});
      await act(async () => {});

      for (let step = 0; step < 120; step++) {
        const action = Math.floor(rnd() * 10);
        await act(async () => {
          const nav = screen.queryByRole("navigation", { name: "Kokpit" });
          switch (action) {
            case 0:
            case 1: {
              const buttons = nav ? Array.from(nav.querySelectorAll<HTMLElement>(".kp-project__name, .kp-card")) : [];
              if (buttons.length) fireEvent.click(pick(buttons));
              break;
            }
            case 2: {
              const open = nav ? screen.queryByRole("button", { name: "Ayarlar" }) : null;
              if (open) fireEvent.click(open);
              break;
            }
            case 3: {
              const tabs = screen.queryAllByRole("tab");
              if (tabs.length) fireEvent.click(pick(tabs));
              break;
            }
            case 4: {
              const back = screen.queryByRole("button", { name: "Geri" });
              if (back) fireEvent.click(back);
              break;
            }
            case 5: {
              // The settings tab panel (the dock's panels are tabpanels too).
              const panel = document.querySelector<HTMLElement>(".kp-settings__panel");
              const buttons = panel
                ? Array.from(panel.querySelectorAll<HTMLButtonElement>("button")).filter((b) => b.textContent !== "Bağlan")
                : [];
              if (buttons.length) fireEvent.click(pick(buttons));
              break;
            }
            case 6:
              client.emitEvent(
                pick([
                  { type: "event", name: "projects.changed" },
                  { type: "event", name: "tools.changed" },
                  { type: "event", name: "sshHosts.changed" },
                  { type: "event", name: "terminals.changed", projectId: pick(["p1", "p3", "home"]) },
                  { type: "event", name: "cards.changed", projectId: "p1" },
                ] as const),
              );
              break;
            case 7:
              client.setState(pick(["reconnecting", "connecting", "open"] as const));
              break;
            case 8:
              client.emitReconnected();
              break;
            case 9:
              for (const t of client.terminals) client.emitOutput(t.id, `[${t.id}]x`);
              break;
          }
        });
        await act(async () => {});
        for (const v of views.views) expect(v.writesAfterDispose).toEqual([]);
        // Exactly one of the two screens is visible.
        const settingsOpen = document.querySelector(".kp-settings__panel") !== null;
        expect(settingsOpen).toBe(screen.queryByRole("navigation", { name: "Kokpit" }) === null);
      }

      unmount();
      await act(async () => {});
      expect(views.views.every((v) => v.disposed)).toBe(true);
      expect(client.closed).toBe(true);
      expect(client.listenerCounts()).toEqual({ state: 0, event: 0, reconnect: 0, output: 0, exit: 0 });
    }, MONKEY_TIMEOUT_MS);
  }
});
