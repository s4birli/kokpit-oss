// In-memory PanelStateStore (values cloned like the persisted store's JSON). Used by tests, and by the
// Workbench to host panels until the layout host (İş L) provides the persisted one.
import type { PanelStateStore } from "../layout/contract.ts";

export class MemoryPanelState implements PanelStateStore {
  private readonly data = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    const v = this.data.get(key);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  set(key: string, value: unknown): void {
    this.data.set(key, structuredClone(value));
  }
}

/** One MemoryPanelState per scope key (project/card), created on first use. */
export function memoryStatesByScope(): (scope: string) => PanelStateStore {
  const states = new Map<string, MemoryPanelState>();
  return (scope) => {
    let s = states.get(scope);
    if (!s) {
      s = new MemoryPanelState();
      states.set(scope, s);
    }
    return s;
  };
}
