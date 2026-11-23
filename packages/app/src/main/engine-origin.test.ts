// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { EngineSettings } from "../renderer/engine/types.ts";
import { trackEngineOrigin } from "./engine-origin.ts";
import { SettingsError, type SettingsStore } from "./settings-store.ts";

/** An in-memory store that normalises like the real one may (trailing slash dropped) and refuses a bad URL. */
function memoryStore(initial: EngineSettings | null = null): SettingsStore {
  let saved = initial;
  return {
    load: async () => saved,
    locked: async () => null,
    save: async (input) => {
      const s = input as EngineSettings;
      if (!/^wss?:\/\//.test(s.url)) throw new SettingsError("Geçersiz adres.");
      saved = { url: s.url.replace(/\/$/, ""), key: s.key };
    },
    clear: async () => {
      saved = null;
    },
  };
}

describe("trackEngineOrigin", () => {
  it("knows no engine until settings were loaded or saved", async () => {
    const t = trackEngineOrigin(memoryStore({ url: "ws://127.0.0.1:7420", key: "k" }));
    expect(t.origin()).toBeNull();
    expect(await t.store.load()).toEqual({ url: "ws://127.0.0.1:7420", key: "k" });
    expect(t.origin()).toBe("http://127.0.0.1:7420");
  });

  it("follows a save, with what the store kept", async () => {
    const t = trackEngineOrigin(memoryStore());
    await t.store.load();
    expect(t.origin()).toBeNull();
    await t.store.save({ url: "wss://mini.tail.ts.net/", key: "k" });
    expect(t.origin()).toBe("https://mini.tail.ts.net");
    await t.store.save({ url: "ws://100.64.1.2:7420", key: "k" });
    expect(t.origin()).toBe("http://100.64.1.2:7420");
  });

  it("a refused save changes nothing", async () => {
    const t = trackEngineOrigin(memoryStore({ url: "ws://127.0.0.1:7420", key: "k" }));
    await t.store.load();
    await expect(t.store.save({ url: "http://evil.example", key: "k" })).rejects.toBeInstanceOf(SettingsError);
    expect(t.origin()).toBe("http://127.0.0.1:7420");
  });

  it("forgets the engine when the settings are cleared", async () => {
    const t = trackEngineOrigin(memoryStore({ url: "ws://127.0.0.1:7420", key: "k" }));
    await t.store.load();
    await t.store.clear();
    expect(t.origin()).toBeNull();
    expect(await t.store.load()).toBeNull();
  });
});
