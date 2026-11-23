// Adım 9 İş A: a project's DevTools port is allocated once from the configured range, remembered in the store
// (so files that carry the address stay right across restarts) and re-allocated only when it is busy.
import { describe, expect, it } from "vitest";
import { createPortAllocator, preferredPort } from "./browser-ports.ts";
import type { BrowserPortStore, Logger } from "./contracts.ts";
import { createMemoryStore } from "./store.ts";

const BASE = 40000;
const SPAN = 10;

function setup(opts: { busy?: number[]; store?: BrowserPortStore } = {}) {
  const store = opts.store ?? createMemoryStore();
  const busy = new Set(opts.busy ?? []);
  const warnings: string[] = [];
  const logger: Logger = { info() {}, warn: (m) => warnings.push(m), error() {} };
  const ports = createPortAllocator({ base: BASE, span: SPAN, store, isPortFree: async (p) => !busy.has(p), logger });
  return { ports, store, busy, warnings };
}

describe("createPortAllocator", () => {
  it("allocates the preferred port once and stores it; a second allocator (restart) returns the same", () => {
    const { ports, store } = setup();
    const port = ports.portFor("Acme");
    expect(port).toBe(preferredPort("Acme", BASE, SPAN));
    expect(store.getBrowserPort("Acme")).toBe(port);
    expect(setup({ store }).ports.portFor("Acme")).toBe(port);
  });

  it("keeps a stored port even when it is not the preferred one", () => {
    const { ports, store } = setup();
    const other = BASE + ((preferredPort("Acme", BASE, SPAN) - BASE + 3) % SPAN);
    store.setBrowserPort("Acme", other);
    expect(ports.portFor("Acme")).toBe(other);
  });

  it("never hands two projects the same port, in any order and across restarts", () => {
    const { ports, store } = setup();
    const ids = Array.from({ length: SPAN }, (_, i) => `p${i}`);
    const got = ids.map((id) => ports.portFor(id));
    expect(new Set(got).size).toBe(SPAN);
    for (const p of got) expect(p).toBeGreaterThanOrEqual(BASE), expect(p).toBeLessThan(BASE + SPAN);
    const again = setup({ store }).ports;
    expect([...ids].reverse().map((id) => again.portFor(id))).toEqual([...got].reverse());
  });

  it("re-allocates a stored port that lies outside the configured range (config changed)", () => {
    const { ports, store } = setup();
    store.setBrowserPort("Acme", 39000);
    const port = ports.portFor("Acme");
    expect(port).toBe(preferredPort("Acme", BASE, SPAN));
    expect(store.getBrowserPort("Acme")).toBe(port);
  });

  it("freePortFor: the stored port when free", async () => {
    const { ports, warnings } = setup();
    const port = ports.portFor("Acme");
    expect(await ports.freePortFor("Acme")).toBe(port);
    expect(warnings).toEqual([]);
  });

  it("freePortFor: a busy port is replaced by the next free one not owned by another project, and stored", async () => {
    const { ports, store, busy, warnings } = setup();
    const first = ports.portFor("Acme");
    const next = BASE + ((first - BASE + 1) % SPAN);
    const afterNext = BASE + ((first - BASE + 2) % SPAN);
    store.setBrowserPort("other", next);
    busy.add(first);
    expect(await ports.freePortFor("Acme")).toBe(afterNext);
    expect(store.getBrowserPort("Acme")).toBe(afterNext);
    expect(ports.portFor("Acme")).toBe(afterNext);
    expect(store.getBrowserPort("other")).toBe(next);
    expect(warnings).toHaveLength(1);
  });

  it("freePortFor: throws when the whole range is busy", async () => {
    const { ports } = setup({ busy: Array.from({ length: SPAN }, (_, i) => BASE + i) });
    await expect(ports.freePortFor("Acme")).rejects.toThrow(/boş port/);
  });

  it("adopt: a Chrome already running for the project keeps its port (even outside the range)", () => {
    const { ports, store } = setup();
    ports.portFor("Acme");
    ports.adopt("Acme", 39000);
    expect(store.getBrowserPort("Acme")).toBe(39000);
  });

  it("a store that cannot write still yields a usable port", () => {
    const broken: BrowserPortStore = {
      getBrowserPort: () => undefined,
      listBrowserPorts: () => ({}),
      setBrowserPort: () => {
        throw new Error("disk full");
      },
    };
    const { ports, warnings } = setup({ store: broken });
    expect(ports.portFor("Acme")).toBe(preferredPort("Acme", BASE, SPAN));
    expect(warnings).toHaveLength(1);
  });
});
