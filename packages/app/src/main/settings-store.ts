// Engine settings on disk: the URL in clear, the key encrypted with Electron safeStorage (macOS Keychain).
import { readFile, rename, rm, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { validateEngineSettings, validateNewEngineSettings } from "../renderer/engine/options.ts";
import type { EngineSettings } from "../renderer/engine/types.ts";
import { t } from "../i18n/index.ts";

/** The subset of Electron's `safeStorage` we use; injectable for tests. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface SettingsStoreDeps {
  filePath: string;
  safeStorage: SafeStorageLike;
}

export interface SettingsStore {
  load(): Promise<EngineSettings | null>;
  /** Validates untrusted input; throws SettingsError with a user-facing (Turkish) message. */
  save(input: unknown): Promise<void>;
  clear(): Promise<void>;
  /**
   * Kendini güncelleme: settings ARE stored but their key cannot be decrypted right now (the Keychain refused this
   * build, or encryption is unavailable) → the address, so the connect screen can keep it. Null in every other
   * case. Nothing is written or removed: the stored file stays for a build that can read it.
   */
  locked(): Promise<{ url: string } | null>;
}

/** An error whose message is safe and meant to be shown in the UI. */
export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

const FILE_VERSION = 1;
const FILE_MODE = 0o600;

interface StoredFile {
  version: typeof FILE_VERSION;
  url: string;
  keyEncrypted: string;
}

function isStoredFile(v: unknown): v is StoredFile {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return o.version === FILE_VERSION && typeof o.url === "string" && typeof o.keyEncrypted === "string";
}

export function createSettingsStore({ filePath, safeStorage }: SettingsStoreDeps): SettingsStore {
  async function readStored(): Promise<StoredFile | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
      return isStoredFile(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  return {
    async locked() {
      const stored = await readStored();
      if (!stored) return null;
      // Only an address that would be accepted as one is handed on.
      const url = validateEngineSettings({ url: stored.url, key: "x" });
      if (!url.ok) return null;
      try {
        if (safeStorage.isEncryptionAvailable()) {
          const key = safeStorage.decryptString(Buffer.from(stored.keyEncrypted, "base64"));
          if (validateEngineSettings({ url: stored.url, key }).ok) return null;
        }
      } catch {
        // Falls through: stored, but not readable by this build.
      }
      return { url: url.value.url };
    },

    async load() {
      let raw: string;
      try {
        raw = await readFile(filePath, "utf8");
      } catch {
        return null;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!isStoredFile(parsed)) return null;
        if (!safeStorage.isEncryptionAvailable()) return null;
        const key = safeStorage.decryptString(Buffer.from(parsed.keyEncrypted, "base64"));
        const v = validateEngineSettings({ url: parsed.url, key });
        return v.ok ? v.value : null;
      } catch {
        return null;
      }
    },

    async save(input) {
      const v = validateNewEngineSettings(input);
      if (!v.ok) throw new SettingsError(v.errors.url ?? v.errors.key ?? t("main.settings.invalid"));
      if (!safeStorage.isEncryptionAvailable()) {
        throw new SettingsError(t("main.settings.noEncryption"));
      }
      const stored: StoredFile = {
        version: FILE_VERSION,
        url: v.value.url,
        keyEncrypted: safeStorage.encryptString(v.value.key).toString("base64"),
      };
      await mkdir(dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(stored), { mode: FILE_MODE });
      await rename(tmp, filePath);
    },

    async clear() {
      await rm(filePath, { force: true });
    },
  };
}
