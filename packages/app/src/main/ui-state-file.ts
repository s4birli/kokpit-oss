// İş L: the renderer's UI state (layout, per-panel state, selection) as one JSON file in userData.
// Untrusted input from IPC: shape- and size-checked, stored as data, never executed.
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { checkUiState, UI_STATE_LIMITS, type UiStateLimits } from "../renderer/engine/ui-state-ipc.ts";

export interface UiStateFileDeps {
  filePath: string;
  limits?: UiStateLimits;
}

export interface UiStateFile {
  /** The stored state, or null when missing, corrupt, oversized or wrongly shaped. */
  load(): Promise<unknown>;
  /** Throws UiStateError (user-facing message) for invalid input. */
  save(input: unknown): Promise<void>;
}

export class UiStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UiStateError";
  }
}

const FILE_MODE = 0o600;

export function createUiStateFile({ filePath, limits = UI_STATE_LIMITS }: UiStateFileDeps): UiStateFile {
  return {
    async load() {
      try {
        if ((await stat(filePath)).size > limits.maxBytes) return null;
        const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
        return checkUiState(parsed, limits).ok ? parsed : null;
      } catch {
        return null;
      }
    },

    async save(input) {
      const check = checkUiState(input, limits);
      if (!check.ok) throw new UiStateError(check.error);
      await mkdir(dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.tmp`;
      await writeFile(tmp, check.json, { mode: FILE_MODE });
      await rename(tmp, filePath);
    },
  };
}
