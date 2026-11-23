// Flow control shared by every JPEG stream the engine relays (İş B browser screencast, Adım 9 screen stream).
/**
 * Screencast backpressure (the browser screencast and every other relayed JPEG stream). Each client may have `window`
 * frames it has not acked yet; a client without room skips frames. The source (Chrome, the screen helper) sends
 * the next frame only after an ack, so the ack for a frame is held while no client has room, and released by the
 * first client ack (or removal) that makes room.
 *
 * A skipped frame is not lost: the newest frame a client skipped is resent once its ack makes room. Chrome
 * can send a frame before the held ack (it did while a second CDP client attached), and when that frame is
 * the last one before the page goes idle, Chrome sends nothing newer: dropping it would leave the viewer on
 * a stale picture for good.
 */
export class FrameGate {
  private readonly lastSent = new Map<object, number[]>();
  /** Per client: the newest frame it skipped for lack of room, not yet resent. */
  private readonly skipped = new Map<object, number>();
  private held = false;
  private readonly window: number;

  constructor(window: number) {
    this.window = window;
  }

  get size(): number {
    return this.lastSent.size;
  }

  get pendingAck(): boolean {
    return this.held;
  }

  has(sub: object): boolean {
    return this.lastSent.has(sub);
  }

  inFlight(sub: object): number {
    return this.lastSent.get(sub)?.length ?? 0;
  }

  add(sub: object): void {
    if (!this.lastSent.has(sub)) this.lastSent.set(sub, []);
  }

  /**
   * Adds a client that was handed frame `sent` right away (the newest one, so a late joiner is not left with an
   * empty picture); it counts as in flight. Returns true when a held source ack must be sent now.
   */
  join(sub: object, sent: number): boolean {
    if (!this.lastSent.has(sub)) this.lastSent.set(sub, [sent]);
    return this.release();
  }

  private hasRoom(): boolean {
    if (this.lastSent.size === 0) return true;
    for (const list of this.lastSent.values()) if (list.length < this.window) return true;
    return false;
  }

  /** Returns true when a held Chrome ack must be sent now. */
  private release(): boolean {
    if (this.held && this.hasRoom()) {
      this.held = false;
      return true;
    }
    return false;
  }

  remove(sub: object): boolean {
    this.lastSent.delete(sub);
    this.skipped.delete(sub);
    return this.release();
  }

  onFrame(frameId: number): { deliverTo: object[]; ackNow: boolean } {
    const deliverTo: object[] = [];
    for (const [sub, list] of this.lastSent) {
      if (list.length >= this.window) {
        this.skipped.set(sub, frameId);
        continue;
      }
      list.push(frameId);
      this.skipped.delete(sub);
      deliverTo.push(sub);
    }
    const ackNow = this.hasRoom();
    this.held = !ackNow;
    return { deliverTo, ackNow };
  }

  /**
   * The client has shown `frameId` (and so every earlier frame). `resend`: the newest frame it skipped, to be
   * sent to it now (counted in flight already). `ackChrome`: send the held Chrome ack now.
   */
  onAck(sub: object, frameId: number): { ackChrome: boolean; resend: number | undefined } {
    const list = this.lastSent.get(sub);
    if (!list) return { ackChrome: false, resend: undefined };
    const left = list.filter((f) => f > frameId);
    const resend = left.length < this.window ? this.skipped.get(sub) : undefined;
    if (resend !== undefined) {
      left.push(resend);
      this.skipped.delete(sub);
    }
    this.lastSent.set(sub, left);
    return { ackChrome: this.release(), resend };
  }

  reset(): void {
    for (const sub of this.lastSent.keys()) this.lastSent.set(sub, []);
    this.skipped.clear();
    this.held = false;
  }
}
