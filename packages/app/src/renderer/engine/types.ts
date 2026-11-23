// Contract between the renderer's connection layer (engine/*) and the UI (ui/*).
import type {
  BrowserFrameMessage,
  BrowserInputEvent,
  Method,
  ParamsOf,
  ProtocolError,
  ResultOf,
  ServerMessage,
} from "@kokpit/shared";

export type ConnectionState =
  | "connecting"
  | "open"
  /** Lost the socket; retrying with backoff. UI shows a banner, keeps panels. */
  | "reconnecting"
  /** Engine rejected the key. No retry until settings change. */
  | "unauthorized"
  /**
   * The server closed the connection before it ever sent a challenge: an engine from before the mutual handshake.
   * The key was NOT sent. Retried with backoff (the engine may get updated meanwhile).
   */
  | "outdated-engine"
  /**
   * The server at this address could not prove it holds the key (its `hello.ok` carried no valid proof). Nothing
   * but the handshake was sent — not the key, not a request. Retried with backoff.
   */
  | "engine-unverified"
  /**
   * The address is not reached over a protected transport (this Mac, Tailscale up, wss://) and the user has not
   * opted in for it: no socket was opened, nothing was sent. Asked again on every retry (`transportMessage` says why).
   */
  | "insecure-transport";

/** The transport gate's answer (main process, connection-gate.ts). */
export type TransportVerdict = { ok: true } | { ok: false; message: string };

export interface EngineSettings {
  /** ws:// URL of the engine, e.g. ws://127.0.0.1:<port> or ws://<tailscale-ip>:<port>. */
  url: string;
  key: string;
}

export class EngineRequestError extends Error {
  readonly code: ProtocolError["code"] | "DISCONNECTED" | "TIMEOUT";
  constructor(code: EngineRequestError["code"], message: string) {
    super(message);
    this.name = "EngineRequestError";
    this.code = code;
  }
}

export type EngineEvent = Extract<ServerMessage, { type: "event" }>;

export interface EngineClient {
  readonly state: ConnectionState;
  /** While `state` is "insecure-transport": why (the gate's text). Otherwise undefined. */
  readonly transportMessage: string | undefined;
  onState(cb: (state: ConnectionState) => void): () => void;

  /** Rejects with EngineRequestError. While not open, rejects immediately with DISCONNECTED. */
  request<M extends Method>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>>;

  sendInput(terminalId: string, data: string): void;
  sendResize(terminalId: string, cols: number, rows: number): void;

  /**
   * `replay` is true for the buffered history sent right after attach. A long history comes in several calls, in
   * order: the first has `continued` false — the panel must reset before writing it — the rest have it true.
   */
  onOutput(terminalId: string, cb: (data: string, replay: boolean, continued: boolean) => void): () => void;
  /**
   * Output of this terminal arrived but could not be used: a frame was too large or malformed, or part of a history
   * replay went missing. What the panel shows may be incomplete; `terminal.attach` again asks for the history anew.
   */
  onOutputLost(terminalId: string, cb: () => void): () => void;
  onExit(terminalId: string, cb: (exitCode: number | null) => void): () => void;
  onEvent(cb: (event: EngineEvent) => void): () => void;

  /** Fires after every successful re-authentication (not the first). Panels re-attach here. */
  onReconnected(cb: () => void): () => void;

  // İş B: browser screencast. Frames arrive after `browser.screencast.start`; each must be acked once shown.
  onBrowserFrame(projectId: string, cb: (frame: BrowserFrameMessage) => void): () => void;
  /** Dropped silently while not open, and when the event is not valid for the protocol. */
  sendBrowserInput(projectId: string, event: BrowserInputEvent): void;
  sendBrowserAck(projectId: string, frameId: number): void;



  close(): void;
}

/** Exposed by the preload script as window.kokpit. Settings are encrypted with Electron safeStorage. */
export interface SettingsBridge {
  load(): Promise<EngineSettings | null>;
  save(settings: EngineSettings): Promise<void>;
  clear(): Promise<void>;
  /**
   * Kendini güncelleme: when `load` gave null although settings are stored (their key cannot be decrypted by this
   * build), the stored address. Absent in bridges that predate it.
   */
  locked?(): Promise<{ url: string } | null>;
  /** The transport gate (connection-gate.ts in main). Absent in bridges that predate it. */
  connection?: ConnectionBridge;
}

/** Main's transport gate, seen from the renderer. */
export interface ConnectionBridge {
  check(url: string): Promise<TransportVerdict>;
  insecureAllowed(url: string): Promise<boolean>;
  setInsecure(url: string, on: boolean): Promise<void>;
}
