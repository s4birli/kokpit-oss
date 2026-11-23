// Adım 9 İş A: each project's DevTools port. Allocated once from the configured range and kept in the store, so
// everything that carries the address outside the engine (terminal env, the project's Claude settings file) stays
// right across browser and engine restarts. A port is replaced only when something else occupies it.
import { engineError, type BrowserPortStore, type Logger } from "./contracts.ts";

/** Stable preferred DevTools port of a project (FNV-1a of the id inside the configured range). */
export function preferredPort(projectId: string, base: number, span: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < projectId.length; i++) {
    h ^= projectId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return base + (h % span);
}

export interface PortAllocatorDeps {
  /** `browser.cdpPortBase` / `browser.cdpPortSpan`. */
  base: number;
  span: number;
  store: BrowserPortStore;
  /** Whether nothing listens on the loopback port right now. */
  isPortFree(port: number): Promise<boolean>;
  logger: Logger;
}

export interface PortAllocator {
  /** The project's port: the stored one, or a newly allocated (and stored) one. */
  portFor(projectId: string): number;
  /** Before starting Chrome: the project's port when free, otherwise the next free one in the range (stored). */
  freePortFor(projectId: string): Promise<number>;
  /** A Chrome already running for the project listens on `port`: that is the project's port now. */
  adopt(projectId: string, port: number): void;
}

export function createPortAllocator(deps: PortAllocatorDeps): PortAllocator {
  const { base, span, store, logger } = deps;
  const inRange = (port: number) => port >= base && port < base + span;
  const at = (start: number, offset: number) => base + ((start - base + offset) % span);

  function remember(projectId: string, port: number): void {
    try {
      store.setBrowserPort(projectId, port);
    } catch (err) {
      logger.warn("DevTools port could not be stored; it may change on the next start", {
        projectId,
        port,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function takenByOthers(projectId: string): Set<number> {
    return new Set(
      Object.entries(store.listBrowserPorts())
        .filter(([id]) => id !== projectId)
        .map(([, port]) => port),
    );
  }

  function portFor(projectId: string): number {
    const stored = store.getBrowserPort(projectId);
    if (stored !== undefined && inRange(stored)) return stored;
    const taken = takenByOthers(projectId);
    const pref = preferredPort(projectId, base, span);
    for (let i = 0; i < span; i++) {
      const port = at(pref, i);
      if (taken.has(port)) continue;
      remember(projectId, port);
      return port;
    }
    return pref;
  }

  async function freePortFor(projectId: string): Promise<number> {
    const first = portFor(projectId);
    if (await deps.isPortFree(first)) return first;
    const taken = takenByOthers(projectId);
    for (let i = 1; i < span; i++) {
      const port = at(first, i);
      if (taken.has(port)) continue;
      if (!(await deps.isPortFree(port))) continue;
      logger.warn("the project's DevTools port is busy; a new one is allocated (addresses handed out earlier are stale)", {
        projectId,
        busy: first,
        port,
      });
      remember(projectId, port);
      return port;
    }
    throw engineError("INTERNAL", "engine.browserPorts.noFreePort");
  }

  return {
    portFor,
    freePortFor,
    adopt: (projectId, port) => {
      if (store.getBrowserPort(projectId) !== port) remember(projectId, port);
    },
  };
}
