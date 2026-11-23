// WebSocket client for the Kokpit engine: mutual authentication (@kokpit/shared auth.ts — the key never crosses
// the wire, and nothing else is sent until the engine proved it holds the key), reconnect with backoff, heartbeat,
// request/response.
import {
  ClientMessageSchema,
  createClientHandshake,
  type ClientHandshake,
  MAX_MESSAGE_BYTES,
  parseServerMessage,
  peekOutputTerminalId,
  type BrowserFrameMessage,
  type ClientMessage,
  type Method,
  type ParamsOf,
  type ResultOf,
  type ServerMessage,
} from "@kokpit/shared";
import { backoffDelay } from "./backoff.ts";
import { resolveClientOptions, type ClientOptions } from "./options.ts";
import { t, translateErrorText } from "../../i18n/index.ts";
import {
  EngineRequestError,
  type ConnectionState,
  type EngineClient,
  type EngineEvent,
  type EngineSettings,
  type TransportVerdict,
} from "./types.ts";

export type CreateClientOptions = Partial<ClientOptions> & {
  WebSocketImpl?: typeof WebSocket;
  /**
   * The transport gate, asked before EVERY socket (first and each reconnection): only on `ok` is a socket opened and
   * the key's handshake started. A throw counts as a refusal.
   */
  checkTransport?: (url: string) => Promise<TransportVerdict>;
};

const NORMAL_CLOSURE = 1000;
const HEARTBEAT_METHOD = "projects.list" satisfies Method;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: EngineRequestError) => void;
  timer: ReturnType<typeof setTimeout>;
}

type Timer = ReturnType<typeof setTimeout> | null;

/** Calls every listener; one throwing listener must not starve the others. */
function emit<A extends unknown[]>(listeners: Iterable<(...args: A) => void> | undefined, ...args: A): void {
  if (!listeners) return;
  for (const cb of [...listeners]) {
    try {
      cb(...args);
    } catch (err) {
      console.error("[kokpit] engine listener failed", err);
    }
  }
}

function subscribe<T>(set: Set<T>, cb: T): () => void {
  set.add(cb);
  return () => {
    set.delete(cb);
  };
}

function subscribeKeyed<T>(map: Map<string, Set<T>>, key: string, cb: T): () => void {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(cb);
  return () => {
    const s = map.get(key);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) map.delete(key);
  };
}

/** Splits `data` into pieces of at most `size` code units, never between a surrogate pair. */
function chunkString(data: string, size: number): string[] {
  const step = Math.max(2, Math.floor(size));
  const out: string[] = [];
  let i = 0;
  while (i < data.length) {
    let end = Math.min(i + step, data.length);
    const last = data.charCodeAt(end - 1);
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
    out.push(data.slice(i, end));
    i = end;
  }
  return out;
}

export function createEngineClient(settings: EngineSettings, opts: CreateClientOptions = {}): EngineClient {
  const { WebSocketImpl = globalThis.WebSocket, checkTransport, ...overrides } = opts;
  const o = resolveClientOptions(overrides);

  let state: ConnectionState = "connecting";
  let socket: WebSocket | null = null;
  let authenticated = false; // on the current socket
  let handshake: ClientHandshake | null = null; // of the current socket
  /** Handshake frames are handled strictly in order, although each step is async (HMAC). */
  let handshakeSteps: Promise<void> = Promise.resolve();
  let authenticatedBefore = false; // ever, on any socket
  let attempt = 0;
  let stopped = false;
  let nextId = 1;
  let reconnectTimer: Timer = null;
  let handshakeTimer: Timer = null;
  /** The last handshake failed because the server could not prove it is the engine. */
  let handshakeUnverified = false;
  let heartbeatTimer: Timer = null;
  /** Why the transport gate said no (while state is "insecure-transport"). */
  let transportMessage: string | undefined;
  /** Bumped by every connect(): a gate answer for an older attempt is ignored. */
  let connectSeq = 0;

  const pending = new Map<number, Pending>();
  const stateListeners = new Set<(s: ConnectionState) => void>();
  const eventListeners = new Set<(e: EngineEvent) => void>();
  const reconnectedListeners = new Set<() => void>();
  const outputListeners = new Map<string, Set<(data: string, replay: boolean, continued: boolean) => void>>();
  const outputLostListeners = new Map<string, Set<() => void>>();
  /**
   * Per terminal, where its history replay stands on this socket: the part expected next, or "lost" once a part
   * went missing (the rest of that replay is then dropped — half a history shown as if whole would be worse).
   */
  const replays = new Map<string, { next: number; total: number } | "lost">();
  /** Reasons already logged: an undecodable frame is reported once per reason, not once per frame. */
  const loggedBadFrames = new Set<string>();
  const exitListeners = new Map<string, Set<(code: number | null) => void>>();
  const browserFrameListeners = new Map<string, Set<(frame: BrowserFrameMessage) => void>>(); // İş B

  function setState(next: ConnectionState): void {
    if (state === next) return;
    state = next;
    emit(stateListeners, next);
  }

  function clearTimer(t: Timer): null {
    if (t !== null) clearTimeout(t);
    return null;
  }

  function isOpen(): boolean {
    return !stopped && authenticated && socket !== null;
  }

  /** Validates against the shared schema and sends; returns false if the frame was not sent. */
  function sendFrame(msg: ClientMessage): boolean {
    if (!socket || !ClientMessageSchema.safeParse(msg).success) return false;
    const raw = JSON.stringify(msg);
    if (raw.length > MAX_MESSAGE_BYTES) return false;
    try {
      socket.send(raw);
      return true;
    } catch {
      return false;
    }
  }

  function rejectAllPending(): void {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      pending.delete(id);
      p.reject(new EngineRequestError("DISCONNECTED", t("common.client.disconnected")));
    }
  }

  /** Tears down the current socket. `code` is the close code if the socket closed by itself. */
  function dropSocket(ws: WebSocket, code: number | undefined): void {
    if (ws !== socket) return; // stale event from an abandoned socket
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    if (code === undefined) {
      try {
        ws.close(NORMAL_CLOSURE);
      } catch {
        /* already closed */
      }
    }
    const authenticatedNow = authenticated;
    const handshakeOf = handshake ?? createClientHandshake({ kind: "key", key: settings.key });
    const unverified = handshakeUnverified;
    socket = null;
    authenticated = false;
    handshake = null;
    handshakeUnverified = false;
    replays.clear(); // a replay never continues on another socket
    handshakeTimer = clearTimer(handshakeTimer);
    heartbeatTimer = clearTimer(heartbeatTimer);
    rejectAllPending();
    if (stopped) return;
    // Before authentication, the handshake tells what a close meant: a refused key (no retry), or an engine from
    // before the handshake (retry: it may be updated). The key is never sent in clear as a fallback.
    const failed = !authenticatedNow && code !== undefined ? handshakeOf.closed(code) : undefined;
    if (failed === "unauthorized") {
      setState("unauthorized");
      return;
    }
    setState(failed === "outdated-engine" ? "outdated-engine" : unverified ? "engine-unverified" : "reconnecting");
    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    reconnectTimer = clearTimer(reconnectTimer);
    const delay = backoffDelay(attempt++, o.backoff);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect(): void {
    if (stopped) return;
    const seq = ++connectSeq;
    if (!checkTransport) {
      openSocket();
      return;
    }
    const refuse = (message: string): void => {
      transportMessage = message;
      setState("insecure-transport");
      scheduleReconnect();
    };
    checkTransport(settings.url).then(
      (v) => {
        if (stopped || seq !== connectSeq) return;
        if (v.ok) {
          transportMessage = undefined;
          openSocket();
        } else refuse(v.message);
      },
      () => {
        if (!stopped && seq === connectSeq) refuse(t("common.client.transportUnchecked"));
      },
    );
  }

  function openSocket(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocketImpl(settings.url);
    } catch {
      setState("reconnecting");
      scheduleReconnect();
      return;
    }
    socket = ws;
    authenticated = false;
    const hs = createClientHandshake({ kind: "key", key: settings.key });
    handshake = hs;
    handshakeSteps = Promise.resolve();
    handshakeTimer = setTimeout(() => dropSocket(ws, undefined), o.handshakeTimeoutMs);
    ws.onopen = () => {
      if (ws === socket) sendFrame(hs.hello());
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (ws === socket && typeof ev.data === "string") handleFrame(ev.data);
    };
    ws.onclose = (ev: CloseEvent) => dropSocket(ws, ev.code);
    // Browsers always follow `error` with `close`; reacting to the error starts recovery without waiting.
    ws.onerror = () => dropSocket(ws, undefined);
  }

  /**
   * A frame that could not be decoded (too large, malformed, unknown shape). Never silent: logged once per reason,
   * and when it carried terminal output, that terminal's panel is told so it can offer to load the history again.
   */
  function onBadFrame(raw: string, reason: string): void {
    const terminalId = peekOutputTerminalId(raw);
    if (!loggedBadFrames.has(reason)) {
      loggedBadFrames.add(reason);
      const about = terminalId === undefined ? "" : `, terminal ${terminalId}`;
      console.warn(`[kokpit] motordan gelen çerçeve atıldı: ${reason} (${raw.length} karakter, sınır ${MAX_MESSAGE_BYTES}${about})`);
    }
    if (terminalId === undefined) return;
    replays.set(terminalId, "lost");
    emit(outputLostListeners.get(terminalId));
  }

  function onOutput(msg: Extract<ServerMessage, { type: "output" }>): void {
    const { terminalId, data } = msg;
    if (msg.replay !== true) {
      emit(outputListeners.get(terminalId), data, false, false);
      return;
    }
    // No `part`: the whole replay in this one frame (engines that do not split).
    const part = msg.part ?? { index: 0, total: 1 };
    if (part.index === 0) {
      if (part.total > 1) replays.set(terminalId, { next: 1, total: part.total });
      else replays.delete(terminalId);
      emit(outputListeners.get(terminalId), data, true, false);
      return;
    }
    const at = replays.get(terminalId);
    if (at === "lost") return;
    if (at === undefined || at.next !== part.index || at.total !== part.total) {
      replays.set(terminalId, "lost");
      emit(outputLostListeners.get(terminalId));
      return;
    }
    if (part.index + 1 < part.total) at.next = part.index + 1;
    else replays.delete(terminalId);
    emit(outputListeners.get(terminalId), data, true, true);
  }

  function handleFrame(raw: string): void {
    const parsed = parseServerMessage(raw);
    if (!parsed.ok) {
      onBadFrame(raw, parsed.error);
      return;
    }
    const msg: ServerMessage = parsed.value;

    if (!authenticated) {
      const ws = socket;
      const hs = handshake;
      if (!ws || !hs) return;
      handshakeSteps = handshakeSteps.then(async () => {
        if (ws !== socket || authenticated) return;
        const step = await hs.receive(msg);
        if (ws !== socket) return;
        if (step.kind === "send") sendFrame(step.frame);
        else if (step.kind === "ok") onAuthenticated();
        else {
          // Not the engine (or out of order): leave without sending anything else.
          console.warn(`[kokpit] motor el sıkışması başarısız: ${step.reason}`);
          handshakeUnverified = step.reason === "unverified";
          dropSocket(ws, undefined);
        }
      });
      return;
    }

    switch (msg.type) {
      case "res": {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new EngineRequestError(msg.error.code, translateErrorText(msg.error)));
        return;
      }
      case "output":
        onOutput(msg);
        return;
      case "exit":
        emit(exitListeners.get(msg.terminalId), msg.exitCode);
        return;
      case "event":
        emit(eventListeners, msg);
        return;
      case "hello.ok":
        return;
      case "browser.frame":
        emit(browserFrameListeners.get(msg.projectId), msg);
        return;
    }
  }

  function onAuthenticated(): void {
    authenticated = true;
    attempt = 0;
    handshakeTimer = clearTimer(handshakeTimer);
    setState("open");
    scheduleHeartbeat();
    if (authenticatedBefore) emit(reconnectedListeners);
    authenticatedBefore = true;
  }

  function scheduleHeartbeat(): void {
    heartbeatTimer = clearTimer(heartbeatTimer);
    const ws = socket;
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = null;
      if (!ws || ws !== socket || !isOpen()) return;
      sendRequest(HEARTBEAT_METHOD, {}, o.heartbeatTimeoutMs).then(
        () => {
          if (ws === socket && isOpen()) scheduleHeartbeat();
        },
        (err: unknown) => {
          if (ws !== socket) return;
          if (err instanceof EngineRequestError && err.code === "TIMEOUT") dropSocket(ws, undefined);
          else if (isOpen()) scheduleHeartbeat(); // engine answered with an error: link is alive
        },
      );
    }, o.heartbeatIntervalMs);
  }

  function sendRequest<M extends Method>(method: M, params: ParamsOf<M>, timeoutMs: number): Promise<ResultOf<M>> {
    if (!isOpen()) {
      return Promise.reject(new EngineRequestError("DISCONNECTED", t("common.client.notConnected")));
    }
    const id = nextId++;
    const frame = { type: "req", id, method, params } as ClientMessage;
    if (!ClientMessageSchema.safeParse(frame).success) {
      return Promise.reject(new EngineRequestError("INVALID", t("common.client.invalidRequest", { method })));
    }
    return new Promise<ResultOf<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new EngineRequestError("TIMEOUT", t("common.client.timeout", { method })));
      }, timeoutMs);
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      if (!sendFrame(frame)) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new EngineRequestError("DISCONNECTED", t("common.client.notConnected")));
      }
    });
  }

  connect();

  return {
    get transportMessage() {
      return state === "insecure-transport" ? transportMessage : undefined;
    },
    get state() {
      return state;
    },
    onState: (cb) => subscribe(stateListeners, cb),
    request: (method, params) => sendRequest(method, params, o.methodTimeoutsMs[method] ?? o.requestTimeoutMs),
    sendInput(terminalId, data) {
      if (!isOpen() || typeof data !== "string") return;
      for (const piece of chunkString(data, o.inputChunkSize)) {
        if (!sendFrame({ type: "input", terminalId, data: piece })) return;
      }
    },
    sendResize(terminalId, cols, rows) {
      if (!isOpen()) return;
      sendFrame({ type: "resize", terminalId, cols, rows });
    },
    onOutput: (terminalId, cb) => subscribeKeyed(outputListeners, terminalId, cb),
    onOutputLost: (terminalId, cb) => subscribeKeyed(outputLostListeners, terminalId, cb),
    onExit: (terminalId, cb) => subscribeKeyed(exitListeners, terminalId, cb),
    onEvent: (cb) => subscribe(eventListeners, cb),
    onReconnected: (cb) => subscribe(reconnectedListeners, cb),
    onBrowserFrame: (projectId, cb) => subscribeKeyed(browserFrameListeners, projectId, cb),
    sendBrowserInput(projectId, event) {
      if (isOpen()) sendFrame({ type: "browser.input", projectId, event });
    },
    sendBrowserAck(projectId, frameId) {
      if (isOpen()) sendFrame({ type: "browser.ack", projectId, frameId });
    },
    close() {
      if (stopped) return;
      stopped = true;
      reconnectTimer = clearTimer(reconnectTimer);
      if (socket) dropSocket(socket, undefined);
      rejectAllPending();
    },
  };
}
