import { beforeEach, describe, expect, it } from "vitest";
import type { Tool } from "@kokpit/shared";
import { EngineError, type Logger } from "./contracts.ts";
import { createSettingsService } from "./settings.ts";
import { createMemoryStore } from "./store.ts";

const silentLogger: Logger = { info() {}, warn() {}, error() {} };
const tool = (id: string): Tool => ({ id, name: `T ${id}`, command: id });

describe("SettingsService", () => {
  let store: ReturnType<typeof createMemoryStore>;

  const service = (initialDefaultToolId = "a") =>
    createSettingsService({ store, logger: silentLogger, tools: { get: (id) => store.getTool(id) }, initialDefaultToolId });

  beforeEach(() => {
    store = createMemoryStore();
    store.upsertTool(tool("a"));
    store.upsertTool(tool("b"));
  });

  it("init seeds the initial default tool once", () => {
    const s = service();
    s.init();
    expect(s.get()).toEqual({ defaultToolId: "a" });
    expect(store.isSeeded("default-settings")).toBe(true);
  });

  it("init never overrides a user choice, including an explicit plain shell", () => {
    const s = service();
    s.init();
    s.update({ defaultToolId: null });
    service().init();
    expect(s.get()).toEqual({});
    expect(store.getSettings()).toEqual({ defaultToolId: null });
  });

  it("init keeps a value set before seeding", () => {
    store.updateSettings({ defaultToolId: "b" });
    service().init();
    expect(service().get()).toEqual({ defaultToolId: "b" });
  });

  it("init skips the seed when the initial tool no longer exists", () => {
    store.removeTool("a");
    const s = service();
    s.init();
    expect(s.get()).toEqual({});
    expect(store.isSeeded("default-settings")).toBe(true);
  });

  it("update sets a tool or null; unknown tool → NOT_FOUND and nothing changes", () => {
    const s = service();
    s.init();
    expect(s.update({ defaultToolId: "b" })).toEqual({ defaultToolId: "b" });
    expect(s.update({ defaultToolId: null })).toEqual({});
    try {
      s.update({ defaultToolId: "zz" });
      throw new Error("expected NOT_FOUND");
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      expect((err as EngineError).code).toBe("NOT_FOUND");
    }
    expect(store.getSettings()).toEqual({ defaultToolId: null });
  });

  it("get leaves out a default whose tool is gone", () => {
    const s = service();
    s.init();
    store.removeTool("a");
    expect(s.get()).toEqual({});
  });
});
