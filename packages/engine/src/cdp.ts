// Minimal Chrome DevTools Protocol client over one WebSocket (the browser endpoint), with flattened
// target sessions (`sessionId` on commands and events). Only what the browser module needs.
import WebSocket from "ws";

export type CdpListener = (method: string, params: Record<string, unknown>, sessionId: string | undefined) => void;

export interface CdpConnection {
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>;
  /** Every event; returns unsubscribe. */
  on(listener: CdpListener): () => void;
  onClose(cb: () => void): void;
  readonly closed: boolean;
  close(): void;
}

export class CdpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CdpError";
  }
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: NodeJS.Timeout;
}

/** Connects to a `ws://127.0.0.1:<port>/devtools/browser/<id>` URL. Only loopback URLs are accepted. */
export function connectCdp(wsUrl: string, opts: { timeoutMs: number }): Promise<CdpConnection> {
  let url: URL;
  try {
    url = new URL(wsUrl);
  } catch {
    return Promise.reject(new CdpError("invalid DevTools URL"));
  }
  if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1") {
    return Promise.reject(new CdpError("DevTools URL must be ws://127.0.0.1"));
  }
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { handshakeTimeout: opts.timeoutMs, perMessageDeflate: false });
    const pending = new Map<number, Pending>();
    const listeners = new Set<CdpListener>();
    const closeCbs: (() => void)[] = [];
    let nextId = 1;
    let closed = false;

    const shutdown = (reason: string) => {
      if (closed) return;
      closed = true;
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new CdpError(reason));
      }
      pending.clear();
      for (const cb of closeCbs.splice(0)) {
        try {
          cb();
        } catch {
          /* listener bug must not break shutdown */
        }
      }
    };

    ws.on("message", (data) => {
      let msg: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: unknown; sessionId?: string };
      try {
        msg = JSON.parse(data.toString()) as typeof msg;
      } catch {
        return;
      }
      if (typeof msg.id === "number") {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new CdpError(msg.error.message ?? "CDP error"));
        else p.resolve(msg.result ?? {});
        return;
      }
      if (typeof msg.method === "string") {
        const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;
        for (const l of [...listeners]) {
          try {
            l(msg.method, params, msg.sessionId);
          } catch {
            /* one listener's bug must not stop the others */
          }
        }
      }
    });
    ws.on("close", () => shutdown("CDP connection closed"));
    ws.on("error", (err) => {
      if (ws.readyState === WebSocket.CONNECTING) reject(new CdpError(`CDP connect failed: ${err.message}`));
      shutdown(`CDP error: ${err.message}`);
    });
    ws.once("open", () => {
      const conn: CdpConnection = {
        send(method, params = {}, sessionId) {
          if (closed || ws.readyState !== WebSocket.OPEN) return Promise.reject(new CdpError("CDP connection closed"));
          const id = nextId++;
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new CdpError(`CDP ${method} timed out`));
            }, opts.timeoutMs);
            pending.set(id, { resolve: res as (v: unknown) => void, reject: rej, timer });
            ws.send(JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }));
          });
        },
        on(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        onClose(cb) {
          if (closed) cb();
          else closeCbs.push(cb);
        },
        get closed() {
          return closed;
        },
        close() {
          shutdown("CDP connection closed");
          ws.terminate();
        },
      };
      resolve(conn);
    });
  });
}
