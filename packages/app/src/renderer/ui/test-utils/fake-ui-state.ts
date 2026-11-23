// İş L: in-memory stand-in for window.kokpit.uiState (the main-process file).
import { vi, type Mock } from "vitest";
import type { UiStateBridge } from "../../engine/ui-state-ipc.ts";

/** In-memory bridge standing in for the preload (main process file). */
export interface FakeUiStateBridge extends UiStateBridge {
  load: Mock<() => Promise<unknown>>;
  save: Mock<(state: unknown) => Promise<void>>;
  saved: unknown[];
  stored: unknown;
}

export function fakeUiStateBridge(initial: unknown = null): FakeUiStateBridge {
  const b: FakeUiStateBridge = {
    saved: [] as unknown[],
    stored: initial,
    load: vi.fn(async (): Promise<unknown> => b.stored),
    save: vi.fn(async (s: unknown): Promise<void> => {
      b.saved.push(s);
      b.stored = JSON.parse(JSON.stringify(s));
    }),
  };
  return b;
}

