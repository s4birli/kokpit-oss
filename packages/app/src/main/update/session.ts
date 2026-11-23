// Kendini güncelleme: the updater's own short-lived connection to the engine, from the main process. It does not
// depend on the page: an app whose page no longer works against a newer engine can still fetch its update.
//
// Authentication is mutual (@kokpit/shared auth.ts): the key never crosses the wire, and the session is handed out —
// and the first request sent — only after the ENGINE proved it holds the key. A server that cannot prove it (an
// impostor at the engine's address, an engine from before the handshake) gets nothing else.
import {
  HANDSHAKE_MESSAGES,
  MAX_MESSAGE_BYTES,
  createClientHandshake,
  parseServerMessage,
  type BuildInfo,
  type Method,
  type ParamsOf,
  type ResultOf,
} from "@kokpit/shared";
import type { EngineSettings } from "../../renderer/engine/types.ts";
import { t } from "../../i18n/index.ts";

export type SessionErrorCode =
  | "unreachable"
  | "unauthorized"
  | "timeout"
  | "closed"
  | "engine"
  /** An engine from before the mutual handshake: it closed the connection without a challenge. */
  | "outdated"
  /** The server could not prove it holds the key: not the engine. */
  | "unverified";

export class SessionError extends Error {
  readonly code: SessionErrorCode;
  /** The engine's error code, for `engine`. */
  readonly engineCode: string | undefined;
  constructor(code: SessionErrorCode, message: string, engineCode?: string) {
    super(message);
    this.name = "SessionError";
    this.code = code;
    this.engineCode = engineCode;
  }
}

export interface EngineHello {
  version: string;
  build: BuildInfo;
  protocol: number;
}

export interface EngineSession {
  readonly engine: EngineHello;
  /** `http(s)://host:port` of the same listener. */
  readonly httpOrigin: string;
  request<M extends Method>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>>;
  close(): void;
}

export interface SessionOptions {
  handshakeTimeoutMs: number;
  requestTimeoutMs: number;
  WebSocketImpl?: typeof WebSocket;
}

const MAX_ENGINE_MESSAGE_CHARS = 300;
/** An engine's error text ends up in the window and the log: one bounded line, no control characters. */
function plainText(message: string): string {
  return message.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, MAX_ENGINE_MESSAGE_CHARS);
}

/** ws://host:port → http://host:port (wss → https). */
export function httpOriginOf(wsUrl: string): string {
  const u = new URL(wsUrl);
  return `${u.protocol === "wss:" ? "https:" : "http:"}//${u.host}`;
}

/** Connects, runs the mutual handshake and resolves once the engine proved itself. */
export function openSession(settings: EngineSettings, o: SessionOptions): Promise<EngineSession> {
  const Impl = o.WebSocketImpl ?? globalThis.WebSocket;
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new Impl(settings.url);
    } catch {
      reject(new SessionError("unreachable", t("update.session.unreachable")));
      return;
    }
    const handshake = createClientHandshake({ kind: "key", key: settings.key });
    let opened = false;
    let failed = false;
    let nextId = 1;
    /** Handshake frames are handled strictly in order, although each step is async (HMAC). */
    let steps = Promise.resolve();
    const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>();
    const failAll = (err: Error): void => {
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        pending.delete(id);
        p.reject(err);
      }
    };
    const fail = (err: SessionError): void => {
      if (opened || failed) return;
      failed = true;
      clearTimeout(timer);
      reject(err);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    };
    const timer = setTimeout(() => fail(new SessionError("timeout", t("update.session.timeout"))), o.handshakeTimeoutMs);

    ws.onopen = () => ws.send(JSON.stringify(handshake.hello()));
    ws.onerror = () => fail(new SessionError("unreachable", t("update.session.unreachable")));
    ws.onclose = (ev: CloseEvent) => {
      if (!opened) {
        const why = handshake.closed(ev.code);
        fail(
          why === "unauthorized"
            ? new SessionError("unauthorized", HANDSHAKE_MESSAGES.unauthorized)
            : why === "outdated-engine"
              ? new SessionError("outdated", HANDSHAKE_MESSAGES["outdated-engine"])
              : new SessionError("unreachable", t("update.session.unreachable")),
        );
      }
      failAll(new SessionError("closed", t("update.session.closed")));
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== "string") return;
      // Nothing larger than the protocol allows is parsed (or kept): the connection is dropped instead.
      if (ev.data.length > MAX_MESSAGE_BYTES) {
        fail(new SessionError("unreachable", t("update.session.frameTooLarge")));
        try {
          ws.close();
        } catch {
          /* already closed */
        }
        return;
      }
      const parsed = parseServerMessage(ev.data);
      if (!opened) {
        const frame = parsed.ok ? parsed.value : undefined;
        steps = steps.then(async () => {
          if (opened || failed) return;
          if (!frame) return fail(new SessionError("unverified", HANDSHAKE_MESSAGES.protocol));
          const step = await handshake.receive(frame);
          if (step.kind === "send") {
            ws.send(JSON.stringify(step.frame));
            return;
          }
          if (step.kind === "fail") return fail(new SessionError(step.reason === "unverified" ? "unverified" : "unreachable", HANDSHAKE_MESSAGES[step.reason]));
          opened = true;
          clearTimeout(timer);
          resolve({
            engine: { version: step.hello.engineVersion, build: step.hello.engineBuild, protocol: step.hello.protocol },
            httpOrigin: httpOriginOf(settings.url),
            request(method, params) {
              return new Promise((res, rej) => {
                const id = nextId++;
                const reqTimer = setTimeout(() => {
                  pending.delete(id);
                  rej(new SessionError("timeout", t("update.session.timeout")));
                }, o.requestTimeoutMs);
                pending.set(id, { resolve: res as (v: unknown) => void, reject: rej, timer: reqTimer });
                try {
                  ws.send(JSON.stringify({ type: "req", id, method, params }));
                } catch {
                  clearTimeout(reqTimer);
                  pending.delete(id);
                  rej(new SessionError("closed", t("update.session.closed")));
                }
              });
            },
            close() {
              failAll(new SessionError("closed", t("update.session.closed")));
              try {
                ws.close();
              } catch {
                /* already closed */
              }
            },
          });
        });
        return;
      }
      // Frames this build does not know (a newer engine's events) are not for the updater.
      if (!parsed.ok) return;
      const msg = parsed.value;
      if (msg.type !== "res") return;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new SessionError("engine", plainText(msg.error.message), msg.error.code));
    };
  });
}
