// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSettingsStore, SettingsError, type SafeStorageLike } from "./settings-store.ts";
import { validateEngineSettings } from "../renderer/engine/options.ts";

// XOR "encryption": reversible, and the ciphertext never contains the plaintext.
function fakeSafeStorage(available = true): SafeStorageLike {
  const xor = (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a));
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => xor(Buffer.from(s, "utf8")),
    decryptString: (b) => xor(b).toString("utf8"),
  };
}

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kokpit-settings-"));
  file = join(dir, "settings.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const good = { url: "ws://100.64.0.1:7420", key: "c3VwZXItc2VjcmV0LWtleS0xMjMtMDEyMzQ1Njc4OWFiY2RlZg" };

describe("settings-store", () => {
  it("refuses to save a weak key (not 32 random bytes) and says how to make one", async () => {
    const store = createSettingsStore({ filePath: file, safeStorage: fakeSafeStorage() });
    for (const key of ["super-secret-key-123", "ab".repeat(24)]) {
      const err = await store.save({ url: good.url, key }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SettingsError);
      expect((err as Error).message).toMatch(/32/);
    }
    expect(existsSync(file)).toBe(false);
  });

  it("returns null when nothing is saved", async () => {
    expect(await createSettingsStore({ filePath: file, safeStorage: fakeSafeStorage() }).load()).toBeNull();
  });

  it("round-trips settings", async () => {
    const store = createSettingsStore({ filePath: file, safeStorage: fakeSafeStorage() });
    await store.save(good);
    expect(await store.load()).toEqual(good);
    // A fresh store instance (new app launch) reads the same file.
    expect(await createSettingsStore({ filePath: file, safeStorage: fakeSafeStorage() }).load()).toEqual(good);
  });

  it("never writes the plaintext key to disk", async () => {
    await createSettingsStore({ filePath: file, safeStorage: fakeSafeStorage() }).save(good);
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain(good.key);
    expect(raw).toContain(good.url);
  });

  it("writes the file owner-only", async () => {
    await createSettingsStore({ filePath: file, safeStorage: fakeSafeStorage() }).save(good);
    expect(statSync(file).mode & 0o077).toBe(0);
  });

  it("refuses to save when encryption is unavailable", async () => {
    const store = createSettingsStore({ filePath: file, safeStorage: fakeSafeStorage(false) });
    await expect(store.save(good)).rejects.toBeInstanceOf(SettingsError);
    expect(existsSync(file)).toBe(false);
  });

  it("load returns null when encryption is unavailable", async () => {
    await createSettingsStore({ filePath: file, safeStorage: fakeSafeStorage() }).save(good);
    expect(await createSettingsStore({ filePath: file, safeStorage: fakeSafeStorage(false) }).load()).toBeNull();
  });

  it.each([
    ["non-object", "nope"],
    ["null", null],
    ["http url", { url: "http://host:1", key: "k" }],
    ["file url", { url: "file:///etc/passwd", key: "k" }],
    ["unparseable url", { url: "ws://", key: "k" }],
    ["empty key", { url: "ws://h:1", key: "" }],
    ["blank key", { url: "ws://h:1", key: "   " }],
    ["huge key", { url: "ws://h:1", key: "k".repeat(5000) }],
    ["huge url", { url: `ws://h:1/${"a".repeat(5000)}`, key: "k" }],
    ["numeric key", { url: "ws://h:1", key: 42 }],
  ])("rejects bad input: %s", async (_name, input) => {
    const store = createSettingsStore({ filePath: file, safeStorage: fakeSafeStorage() });
    await expect(store.save(input)).rejects.toBeInstanceOf(SettingsError);
    expect(existsSync(file)).toBe(false);
  });

  it("drops extra fields", async () => {
    const store = createSettingsStore({ filePath: file, safeStorage: fakeSafeStorage() });
    await store.save({ ...good, evil: "x" });
    expect(await store.load()).toEqual(good);
  });

  it.each([["garbage"], ["{}"], ['{"version":1,"url":"ws://h:1","keyEncrypted":42}'], ["[]"]])(
    "load returns null for a corrupt file: %s",
    async (content) => {
      writeFileSync(file, content);
      expect(await createSettingsStore({ filePath: file, safeStorage: fakeSafeStorage() }).load()).toBeNull();
    },
  );

  it("clear removes saved settings and is idempotent", async () => {
    const store = createSettingsStore({ filePath: file, safeStorage: fakeSafeStorage() });
    await store.save(good);
    await store.clear();
    expect(await store.load()).toBeNull();
    await expect(store.clear()).resolves.toBeUndefined();
  });
});

// Kendini güncelleme: after an update the Keychain may refuse the new build ("Kokpit Safe Storage" is bound to the
// code that created it; an ad-hoc signed build has a different identity every time).
describe("settings-store: the key cannot be decrypted by this build", () => {
  /** Encrypts like the working fake; decrypting throws, as Electron does when the Keychain denies the key. */
  function deniedSafeStorage(): SafeStorageLike {
    return {
      ...fakeSafeStorage(),
      decryptString: () => {
        throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
      },
    };
  }

  it("load gives null, locked gives the stored address, and the stored file is left exactly as it was", async () => {
    await createSettingsStore({ filePath: file, safeStorage: fakeSafeStorage() }).save(good);
    const before = readFileSync(file);
    const store = createSettingsStore({ filePath: file, safeStorage: deniedSafeStorage() });
    expect(await store.load()).toBeNull();
    expect(await store.locked()).toEqual({ url: good.url });
    expect(readFileSync(file).equals(before)).toBe(true);
    // A build the Keychain accepts (e.g. after a rollback) still reads the same file.
    expect(await createSettingsStore({ filePath: file, safeStorage: fakeSafeStorage() }).load()).toEqual(good);
  });

  it("entering the key once makes it work again", async () => {
    await createSettingsStore({ filePath: file, safeStorage: fakeSafeStorage() }).save(good);
    // The new build's own encryption works (it has its own key); only the old ciphertext is unreadable to it.
    const other = (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x33));
    const newBuild: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: (s) => other(Buffer.from(s, "utf8")),
      decryptString: (b) => {
        const text = other(b).toString("utf8");
        if (!/^[\x20-\x7e]+$/.test(text)) throw new Error("decrypt failed");
        return text;
      },
    };
    const store = createSettingsStore({ filePath: file, safeStorage: newBuild });
    expect(await store.load()).toBeNull();
    expect(await store.locked()).toEqual({ url: good.url });
    await store.save({ url: good.url, key: good.key });
    expect(await store.load()).toEqual(good);
    expect(await store.locked()).toBeNull();
  });

  it("encryption unavailable altogether is the same case", async () => {
    await createSettingsStore({ filePath: file, safeStorage: fakeSafeStorage() }).save(good);
    const store = createSettingsStore({ filePath: file, safeStorage: fakeSafeStorage(false) });
    expect(await store.load()).toBeNull();
    expect(await store.locked()).toEqual({ url: good.url });
  });

  it("locked is null when nothing is stored, when the file is not ours, and when the key reads fine", async () => {
    const store = createSettingsStore({ filePath: file, safeStorage: deniedSafeStorage() });
    expect(await store.locked()).toBeNull();
    writeFileSync(file, "{ not json");
    expect(await store.locked()).toBeNull();
    writeFileSync(file, JSON.stringify({ version: 1, url: "javascript:alert(1)", keyEncrypted: "AAAA" }));
    expect(await store.locked()).toBeNull();
    const fine = createSettingsStore({ filePath: file, safeStorage: fakeSafeStorage() });
    await fine.save(good);
    expect(await fine.locked()).toBeNull();
  });
});

describe("validateEngineSettings", () => {
  it("accepts ws and wss", () => {
    expect(validateEngineSettings(good).ok).toBe(true);
    expect(validateEngineSettings({ url: "wss://example.ts.net", key: "k" }).ok).toBe(true);
  });

  it("reports the offending field", () => {
    const r = validateEngineSettings({ url: "http://x", key: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.url).toBeTruthy();
      expect(r.errors.key).toBeTruthy();
    }
  });

  it("trims the url but not the key", () => {
    const r = validateEngineSettings({ url: "  ws://h:1  ", key: " k " });
    expect(r.ok && r.value).toEqual({ url: "ws://h:1", key: " k " });
  });
});
