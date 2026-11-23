// Scripts and tests: the client side of the mutual handshake (@kokpit/shared auth.ts) over a `ws` socket.
import type WebSocket from "ws";
import { createClientHandshake, parseGrantCredential, type AuthCredential, type HandshakeFailure, type HelloOkFrame } from "@kokpit/shared";

export class HandshakeError extends Error {
  readonly reason: HandshakeFailure | "timeout";
  readonly closeCode: number | undefined;
  constructor(reason: HandshakeFailure | "timeout", closeCode?: number) {
    super(`handshake failed: ${reason}${closeCode !== undefined ? ` (close ${closeCode})` : ""}`);
    this.name = "HandshakeError";
    this.reason = reason;
    this.closeCode = closeCode;
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const OPEN = 1;

/** A key string, a grant credential string (`<id>.<token>`), or an explicit credential. */
export function credentialOf(c: string | AuthCredential, kind: "key" | "grant" = "key"): AuthCredential {
  if (typeof c !== "string") return c;
  if (kind === "key") return { kind: "key", key: c };
  const g = parseGrantCredential(c);
  if (!g) throw new Error("not a grant credential");
  return g;
}

/**
 * Runs the handshake on `ws` (waits for it to open). Resolves with the engine's verified `hello.ok`; rejects with
 * HandshakeError. Frames after `hello.ok` are left to the caller's own listeners.
 */
export function authenticate(ws: WebSocket, credential: string | AuthCredential, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<HelloOkFrame> {
  const handshake = createClientHandshake(credentialOf(credential));
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err?: Error, hello?: HelloOkFrame): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("close", onClose);
      if (err) reject(err);
      else resolve(hello!);
    };
    const timer = setTimeout(() => finish(new HandshakeError("timeout")), timeoutMs);
    // Frames are handled strictly in order, although handling is async (HMAC).
    let queue = Promise.resolve();
    const onMessage = (data: WebSocket.RawData): void => {
      queue = queue.then(async () => {
        if (done) return;
        let frame: { type: string; [k: string]: unknown };
        try {
          frame = JSON.parse(data.toString()) as typeof frame;
        } catch {
          return finish(new HandshakeError("protocol"));
        }
        const step = await handshake.receive(frame);
        if (step.kind === "send") ws.send(JSON.stringify(step.frame));
        else if (step.kind === "ok") finish(undefined, step.hello);
        else finish(new HandshakeError(step.reason));
      });
    };
    const onClose = (code: number): void => finish(new HandshakeError(handshake.closed(code), code));
    ws.on("message", onMessage);
    ws.on("close", onClose);
    const start = (): void => ws.send(JSON.stringify(handshake.hello()));
    if (ws.readyState === OPEN) start();
    else ws.once("open", start);
  });
}
