// Yerel bağlantı: contract between the renderer, the preload and Electron main for connecting to an engine
// running on this Mac. The key never travels over these channels: main detects and saves it itself.

export const LOCAL_ENGINE_IPC = {
  detect: "localEngine:detect",
  connect: "localEngine:connect",
} as const;

/** What the renderer may know about a detected engine: where it is, not how to get in. */
export interface LocalEngineInfo {
  /** "127.0.0.1:<port>", shown as a hint under the button. */
  address: string;
}

/** Exposed as `window.kokpit.localEngine`. */
export interface LocalEngineBridge {
  /** A reachable engine on this Mac, or null. */
  detect(): Promise<LocalEngineInfo | null>;
  /** Detects again and saves its url + key as the engine settings (in main). Throws a user-facing error. */
  connect(): Promise<void>;
}
