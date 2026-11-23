// Test helper: an in-memory stand-in for the browser WebSocket, driven from the "server" side by the test.
import { AUTH_LABELS, authProof, keySecret, newNonce, PROTOCOL_VERSION } from "@kokpit/shared";

/** Real timers, captured before a test fakes them: the client's handshake HMACs (WebCrypto) settle on the event loop. */
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => realSetTimeout(resolve, 0));

export const FAKE_ENGINE_BUILD = { buildId: "0.0.0+20260101000000.fake", version: "0.0.0", commit: "fake", builtAt: "2026-01-01T00:00:00.000Z" };

type Handler<E> = ((ev: E) => void) | null;

export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  /** Every socket constructed since the last reset(), in order. */
  static instances: FakeWebSocket[] = [];
  static reset(): void {
    FakeWebSocket.instances = [];
  }
  static get last(): FakeWebSocket {
    const ws = FakeWebSocket.instances.at(-1);
    if (!ws) throw new Error("no FakeWebSocket constructed yet");
    return ws;
  }

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  /** Raw frames the client sent. */
  readonly sent: string[] = [];
  /** Set when the client called close(). */
  closedByClient: { code?: number; reason?: string } | null = null;

  onopen: Handler<Event> = null;
  onmessage: Handler<MessageEvent> = null;
  onclose: Handler<CloseEvent> = null;
  onerror: Handler<Event> = null;

  constructor(url: string | URL) {
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  /** Parsed frames the client sent. */
  get sentJson(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }

  send(data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("InvalidStateError: socket not open");
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.closedByClient = { code, reason };
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: code ?? 1005, reason: reason ?? "", wasClean: true } as CloseEvent);
  }

  // ---- server side ----

  serverOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({} as Event);
  }

  serverSend(msg: unknown): void {
    const data = typeof msg === "string" ? msg : JSON.stringify(msg);
    this.onmessage?.({ data } as MessageEvent);
  }

  /** Delivers a non-string payload (e.g. binary), which the client must ignore. */
  serverSendRaw(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  serverClose(code = 1006, reason = ""): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean: code !== 1006 } as CloseEvent);
  }

  serverError(): void {
    this.onerror?.({} as Event);
  }

  /** Lets the client's async handshake steps run (they finish on the real event loop, also under fake timers). */
  async settle(rounds = 5): Promise<void> {
    for (let i = 0; i < rounds; i++) await yieldToEventLoop();
  }

  /** Waits until the client has sent a frame of `type`; returns it. */
  async waitForSent(type: string, rounds = 200): Promise<Record<string, unknown>> {
    for (let i = 0; i < rounds; i++) {
      const hit = this.sentJson.find((m) => m.type === type);
      if (hit) return hit;
      await yieldToEventLoop();
    }
    throw new Error(`the client never sent ${type}`);
  }

  /**
   * Plays the engine's side of the mutual handshake (@kokpit/shared auth.ts) with `key`: challenge, check the
   * client's proof (a wrong one closes 4401, like the engine), then `hello.ok` with the engine's proof.
   * `engineProof: "bogus"` plays an impostor that does not hold the key.
   */
  async serverAuthenticate(key: string, opts: { engineProof?: "valid" | "bogus"; until?: () => boolean } = {}): Promise<void> {
    const hello = await this.waitForSent("auth.hello");
    const serverNonce = newNonce();
    this.serverSend({ type: "auth.challenge", nonce: serverNonce });
    const { proof } = (await this.waitForSent("auth.proof")) as { proof: string };
    const expected = await authProof(keySecret(key), AUTH_LABELS.client, serverNonce, hello.nonce as string);
    if (proof !== expected) {
      this.serverClose(4401);
      return;
    }
    const engineProof = opts.engineProof === "bogus" ? newNonce() : await authProof(keySecret(key), AUTH_LABELS.engine, hello.nonce as string, serverNonce);
    this.serverSend({ type: "hello.ok", engineVersion: "0.0.0", engineBuild: FAKE_ENGINE_BUILD, protocol: PROTOCOL_VERSION, proof: engineProof });
    // The client checks the engine's proof asynchronously: wait until it says it is done (on a loaded machine
    // a fixed number of turns is not enough).
    await this.settleUntil(opts.until);
  }

  /** Yields to the event loop until `done()` holds (or a few turns when there is nothing to wait for). */
  async settleUntil(done?: () => boolean, rounds = 500): Promise<void> {
    if (!done) return this.settle();
    for (let i = 0; i < rounds && !done(); i++) await yieldToEventLoop();
    if (!done()) throw new Error("the client never got there");
  }
}
