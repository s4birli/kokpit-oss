// One LIVE tab of a Chrome: the CDP session the engine holds on it, and everything that makes it a picture the app
// can use — the page's viewport (picture ÷ zoom, §7A), the screencast to every viewer with its backpressure gate,
// the self-healing of a lost size, the input queue, and page evaluation for the clipboard. A project's Chrome has
// one (its active tab, which moves with tab switches); the Masaüstü's Chrome has one per open window, all live at
// once. Chrome itself — start, adoption, tabs, close — stays in browser.ts.
import { BROWSER_LIMITS, type BrowserFrameMetadata, type BrowserInputEvent, type BrowserModifiers } from "@kokpit/shared";
import type { BrowserConfig } from "./browser-config.ts";
import type { CdpConnection } from "./cdp.ts";
import { engineError, type Logger } from "./contracts.ts";
import { FrameGate } from "./frame-gate.ts";

/** The picture area of an app panel or desktop window that shows the page (CSS px). */
export interface PanelView {
  width: number;
  height: number;
}

export interface ScreencastOptions {
  maxWidth: number;
  maxHeight: number;
  quality: number;
}

/** Log line of a tab coming into view; the app's e2e tab trace picks "browser tab …" lines out. */
export const TAB_ACTIVATED_LOG = "browser tab activated";

/**
 * Chrome reports a title-only change (`document.title = …` without navigation) to no CDP event, so a live tab
 * gets a tiny watcher that calls this binding when the title changes; the engine then announces a change.
 */
export const TITLE_BINDING = "__kokpitTitleChanged";
export const TITLE_WATCHER = `(() => {
  const notify = globalThis[${JSON.stringify(TITLE_BINDING)}];
  if (typeof notify !== "function" || globalThis.__kokpitTitleWatch) return;
  globalThis.__kokpitTitleWatch = true;
  let last = document.title;
  new MutationObserver(() => {
    if (document.title === last) return;
    last = document.title;
    notify("");
  }).observe(document, { subtree: true, childList: true, characterData: true });
})();`;

// ---------- pure helpers ----------

/** CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8. */
export function modifierBits(m: BrowserModifiers | undefined): number {
  if (!m) return 0;
  return (m.alt ? 1 : 0) | (m.ctrl ? 2 : 0) | (m.meta ? 4 : 0) | (m.shift ? 8 : 0);
}

export interface CdpCall {
  method: string;
  params: Record<string, unknown>;
}

const MOUSE_TYPES = { move: "mouseMoved", down: "mousePressed", up: "mouseReleased" } as const;

/** Text a key press types, if any: one character (no Ctrl/Meta shortcut) or Enter's "\r". */
function keyText(key: string, mods: BrowserModifiers | undefined): string | undefined {
  if (key === "Enter") return "\r";
  if (mods?.ctrl || mods?.meta) return undefined;
  return [...key].length === 1 ? key : undefined;
}

/** A validated app input event → the CDP Input.* calls that reproduce it. */
export function toCdpInput(ev: BrowserInputEvent): CdpCall[] {
  switch (ev.type) {
    case "mouse": {
      const moving = ev.action === "move";
      return [
        {
          method: "Input.dispatchMouseEvent",
          params: {
            type: MOUSE_TYPES[ev.action],
            x: ev.x,
            y: ev.y,
            button: ev.button ?? (moving ? "none" : "left"),
            clickCount: ev.clickCount ?? (moving ? 0 : 1),
            modifiers: modifierBits(ev.modifiers),
          },
        },
      ];
    }
    case "wheel":
      return [
        {
          method: "Input.dispatchMouseEvent",
          params: { type: "mouseWheel", x: ev.x, y: ev.y, deltaX: ev.deltaX, deltaY: ev.deltaY, modifiers: modifierBits(ev.modifiers) },
        },
      ];
    case "key": {
      const common: Record<string, unknown> = {
        key: ev.key,
        code: ev.code,
        ...(ev.keyCode !== undefined ? { windowsVirtualKeyCode: ev.keyCode } : {}),
        modifiers: modifierBits(ev.modifiers),
        ...(ev.location !== undefined ? { location: ev.location } : {}),
        ...(ev.repeat ? { autoRepeat: true } : {}),
      };
      if (ev.action === "up") return [{ method: "Input.dispatchKeyEvent", params: { type: "keyUp", ...common } }];
      if (ev.action === "char") return [{ method: "Input.dispatchKeyEvent", params: { type: "char", ...common, text: ev.key } }];
      const text = keyText(ev.key, ev.modifiers);
      return [
        {
          method: "Input.dispatchKeyEvent",
          params: text === undefined ? { type: "rawKeyDown", ...common } : { type: "keyDown", ...common, text, unmodifiedText: text },
        },
      ];
    }
    case "text":
      return [{ method: "Input.insertText", params: { text: ev.text } }];
  }
}

/** Page expression resolving after two animation frames (layout + paint done), or after `maxMs` (hidden tab). */
export function afterPaint(maxMs: number): string {
  const ms = Number.isFinite(maxMs) && maxMs >= 0 ? Math.floor(maxMs) : 0;
  return `new Promise((r) => { setTimeout(() => r(false), ${ms}); requestAnimationFrame(() => requestAnimationFrame(() => r(true))); })`;
}

export interface DeviceMetricsOverride {
  width: number;
  height: number;
  /** 0 = keep the real device scale factor (frames stay as sharp as the window). */
  deviceScaleFactor: 0;
  mobile: false;
}

/**
 * The page renders at `zoom` when its CSS viewport is the window's size / zoom (more CSS px fit at < 1).
 * Screencast frames then show that whole viewport and their metadata reports it as device CSS px, which is
 * exactly what the app's coordinate mapping (and Input.dispatch*) uses — so clicks stay exact. 1 = no override.
 */
export function zoomOverride(viewport: { width: number; height: number }, zoom: number): DeviceMetricsOverride | null {
  const { width, height } = viewport;
  if (![width, height, zoom].every(Number.isFinite) || width <= 0 || height <= 0 || zoom <= 0 || zoom === 1) return null;
  return { width: Math.max(1, Math.round(width / zoom)), height: Math.max(1, Math.round(height / zoom)), deviceScaleFactor: 0, mobile: false };
}

/** Sanity bound of an emulated viewport. */
const maxViewportDim = BROWSER_LIMITS.maxViewportDim;
const clampInt = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

/**
 * The page's layout viewport follows the picture: picture CSS px / zoom, so the picture has the panel's aspect
 * (it always fits; nothing to crop or scroll) whatever size Chrome's own window has. The device scale factor stays
 * Chrome's own (0): a screencast frame has viewport px × the real scale factor whatever is emulated, so emulating
 * one would only change what pages and agents read as devicePixelRatio. Frame metadata reports the viewport as
 * device CSS px, which is what the app's coordinate mapping uses, so clicks stay exact. Null = unusable input.
 */
export function panelOverride(view: PanelView, zoom: number, maxDim: number = maxViewportDim): DeviceMetricsOverride | null {
  const { width, height } = view;
  if (![width, height, zoom].every(Number.isFinite) || width <= 0 || height <= 0 || zoom <= 0) return null;
  return {
    width: clampInt(width / zoom, 1, maxDim),
    height: clampInt(height / zoom, 1, maxDim),
    deviceScaleFactor: 0,
    mobile: false,
  };
}

/**
 * One screencast serves every viewer: bounded by the largest picture in each direction and the best quality asked,
 * so no viewer's (re)start makes another's picture coarser. Undefined = nobody watches.
 */
export function mergeScreencast(all: Iterable<ScreencastOptions>): ScreencastOptions | undefined {
  let out: ScreencastOptions | undefined;
  for (const o of all) {
    out = out
      ? { maxWidth: Math.max(out.maxWidth, o.maxWidth), maxHeight: Math.max(out.maxHeight, o.maxHeight), quality: Math.max(out.quality, o.quality) }
      : { ...o };
  }
  return out;
}

/** `p`, or a rejection with `what` timed out after `ms` (p keeps running; its later outcome is ignored). */
export function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    timer.unref?.();
  });
  p.catch(() => {});
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------- the live tab ----------

/** A frame message as it goes to a viewer (browser.frame, desktop.frame). */
export interface LiveFrame {
  frameId: number;
  metadata: BrowserFrameMetadata;
}

interface Subscriber<M> {
  send(msg: M): void;
  /** What this viewer asked of the screencast (see mergeScreencast). */
  opts: ScreencastOptions;
}

export interface LiveTabDeps<M extends LiveFrame> {
  cdp: CdpConnection;
  config: BrowserConfig;
  logger: Logger;
  /** Log fields naming this live tab, e.g. `{ projectId }` (never page content). */
  label: Record<string, unknown>;
  /** The picture the page follows (the viewport owner's; undefined = none reported) and its zoom, read at each apply. */
  view(): PanelView | undefined;
  zoom(): number;
  /** The frame message for the viewers. */
  frame(frameId: number, data: string, metadata: BrowserFrameMetadata): M;
  /** The page's title or address changed, or the tab came into view: the viewers re-read the state. */
  changed(): void;
  /** Whether Chrome still lists the tab (a session Chrome dropped is attached again only then). */
  hasTab(tabId: string): boolean;
  /** Whether the browser this tab belongs to is still the running one. */
  current(): boolean;
  /** "Page.bringToFront" + "Target.activateTarget" on attach (a project's tab switch; harmless in headless). */
  bringToFront: boolean;
  /** Install the title watcher (a binding and a script in the page). Default true; false leaves the page untouched. */
  watchTitle?: boolean;
}

export class LiveTab<M extends LiveFrame> {
  /** The tab shown, and the engine's session on it (both undefined = none). */
  tabId: string | undefined;
  sessionId: string | undefined;
  readonly subscribers = new Map<object, Subscriber<M>>();
  readonly gate: FrameGate;
  screencast: ScreencastOptions | undefined;
  /** Gone: its browser is closing or the window was closed. */
  closing = false;
  /** Serializes attaches, zoom and viewport changes. */
  queue: Promise<void> = Promise.resolve();
  /** Settles when every input event received so far has been delivered to the page (or failed). */
  inputs: Promise<void> = Promise.resolve();
  /** The newest frame, kept to resend to a viewer that skipped it (FrameGate). */
  lastFrame: M | undefined;
  private heldAck: { sessionId: string; ackId: number } | undefined;
  private frameSeq = 0;
  /** When the page's size was last applied, and how often in a row a wrong-sized frame made the engine do it. */
  private appliedAt = 0;
  /**
   * Size/zoom applies queued or running (reapply). Frames arriving meanwhile were painted before the new size took
   * effect: they are not a sign that Chrome lost the size, and must not trigger a heal of their own.
   */
  private pendingApplies = 0;
  private healTries = 0;
  private healTimer: ReturnType<typeof setTimeout> | undefined;
  private warnedBigFrame = false;

  private readonly deps: LiveTabDeps<M>;

  constructor(deps: LiveTabDeps<M>) {
    this.deps = deps;
    this.gate = new FrameGate(deps.config.frameWindow);
  }

  /** The page's title or address changed: the viewers re-read the state. */
  changed(): void {
    this.deps.changed();
  }

  private get cdp(): CdpConnection {
    return this.deps.cdp;
  }

  /** Runs `fn` after everything queued on this tab (attaches, zoom and viewport changes): one at a time. */
  serial(fn: () => Promise<void>): Promise<void> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => {});
    return next;
  }

  /**
   * One step that the page has to answer and that the caller can do without: bounded by tabStepTimeoutMs, a failure
   * or timeout is given up silently.
   */
  private softStep(method: string, params: Record<string, unknown>, sessionId?: string): Promise<void> {
    return within(this.cdp.send(method, params, sessionId), this.deps.config.tabStepTimeoutMs, method).then(
      () => {},
      () => {},
    );
  }

  /**
   * Attach to `tabId`, bring it to front, size it and move the screencast there. The new tab is attached BEFORE the
   * old session is let go: a tab that is gone (closed meanwhile) fails with NOT_FOUND and leaves this live tab on
   * the tab it showed, with a session Chrome still has — never on a detached one. Callers run it on `serial`.
   */
  async attach(tabId: string): Promise<void> {
    const { config, logger, label } = this.deps;
    let sessionId: string;
    try {
      ({ sessionId } = await this.cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: tabId, flatten: true }));
    } catch (err) {
      logger.warn("browser tab switch failed", { ...label, tabId, err: errText(err) });
      // The strip may still show the tab: it is re-read and re-sent.
      this.deps.changed();
      throw engineError("NOT_FOUND", "engine.browser.tabNotFound");
    }
    const old = this.sessionId;
    this.sessionId = sessionId;
    this.tabId = tabId;
    if (old && old !== sessionId) {
      await this.softStep("Page.stopScreencast", {}, old);
      await this.softStep("Target.detachFromTarget", { sessionId: old });
    }
    await within(this.cdp.send("Page.enable", {}, sessionId), config.tabStepTimeoutMs, "Page.enable").catch((err: unknown) =>
      logger.warn("browser page events not enabled", { ...label, err: errText(err) }),
    );
    if (this.deps.watchTitle !== false) await this.watchTitle(sessionId);
    // Focus/caret behave as if the window had focus even when nobody looks at the Mac mini's screen.
    await this.softStep("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
    if (this.deps.bringToFront) {
      // Visible tabs paint (and so produce screencast frames); background ones do not.
      await this.softStep("Page.bringToFront", {}, sessionId);
      await this.softStep("Target.activateTarget", { targetId: tabId });
    }
    // The size AFTER the tab is in front, and the screencast only once the page has painted at it: a tab sized
    // while still in the background showed its first frame in the window's shape (measured: every second switch),
    // and on a static page that frame stayed.
    await this.applySize(sessionId, this.subscribers.size > 0);
    if (this.subscribers.size > 0) await this.startScreencast();
    logger.info(TAB_ACTIVATED_LOG, { ...label, tabId });
    this.deps.changed();
  }

  /** Title-only changes → changed() (best effort: some pages refuse scripts). */
  private async watchTitle(sessionId: string): Promise<void> {
    try {
      // Chrome delivers Runtime.bindingCalled only to sessions with the Runtime domain enabled.
      const send = (method: string, params: Record<string, unknown>) =>
        within(this.cdp.send(method, params, sessionId), this.deps.config.tabStepTimeoutMs, method);
      await send("Runtime.enable", {});
      await send("Runtime.addBinding", { name: TITLE_BINDING });
      await send("Page.addScriptToEvaluateOnNewDocument", { source: TITLE_WATCHER });
      await send("Runtime.evaluate", { expression: TITLE_WATCHER });
    } catch (err) {
      this.deps.logger.warn("title watcher not installed", { ...this.deps.label, err: errText(err) });
    }
  }

  /**
   * Makes the tab render at the picture's size and zoom (best effort: a failure leaves it as it was). With
   * `waitPaint`, also waits (at most `zoomPaintWaitMs`) until the page has laid out and painted at the new size, so
   * the next screencast frame already shows it. Callers run it on `serial`: two of these interleaving left the page
   * at an older zoom than the one asked last.
   */
  async applySize(sessionId: string, waitPaint: boolean): Promise<void> {
    const { config, logger, label } = this.deps;
    const zoom = this.deps.zoom();
    const view = this.deps.view();
    // An explicit apply starts the self-healing over (heal restores its own count afterwards).
    this.healTries = 0;
    try {
      // A page that cannot answer (a JavaScript dialog open) must not hold the queue for the whole CDP timeout.
      const send = <T,>(method: string, params: Record<string, unknown>) =>
        within(this.cdp.send<T>(method, params, sessionId), config.tabStepTimeoutMs, method);
      const panel = view ? panelOverride(view, zoom, maxViewportDim) : null;
      if (panel) {
        // Explicit size: independent of Chrome's own window and of whatever override was there before.
        await send("Emulation.setDeviceMetricsOverride", { ...panel });
      } else {
        // Measure the real viewport (the window), not a previous override.
        await send("Emulation.clearDeviceMetricsOverride", {});
        if (zoom !== 1) {
          const { result } = await send<{ result: { value?: unknown } }>("Runtime.evaluate", {
            expression: "[window.innerWidth, window.innerHeight]",
            returnByValue: true,
          });
          const [width, height] = Array.isArray(result.value) ? (result.value as unknown[]) : [];
          const metrics = zoomOverride({ width: Number(width), height: Number(height) }, zoom);
          if (metrics) await send("Emulation.setDeviceMetricsOverride", { ...metrics });
        }
      }
      if (waitPaint) {
        // The page's own timer ends the wait after zoomPaintWaitMs — unless the page runs no script at all (CSP
        // `sandbox`, e.g. an expired preview's 404 page): its timers never fire and the evaluation would wait for
        // the whole CDP timeout (measured: 15 s per switch). So the engine bounds the wait itself.
        await within(
          this.cdp.send("Runtime.evaluate", { expression: afterPaint(config.zoomPaintWaitMs), awaitPromise: true, returnByValue: true }, sessionId),
          config.zoomPaintWaitMs,
          "waiting for the page to paint",
        ).catch(() => {});
      }
    } catch (err) {
      logger.warn("applying the browser zoom failed", { ...label, zoom, err: errText(err) });
    } finally {
      this.appliedAt = Date.now();
    }
  }

  /**
   * Re-applies the current zoom and picture size. Reads them when its turn comes, so of several queued changes the
   * last one wins; `changed` false (an identical size sent again) skips the screencast restart. Input received
   * before the change is delivered first: a click was aimed at the page as it was (a passive viewer's click, which
   * makes it the owner, must land before the page takes that viewer's size).
   */
  reapply(changed: boolean): Promise<void> {
    const inputs = this.inputs;
    // Counted from the moment the new size is known, not only while it runs: the queue may be busy.
    this.pendingApplies++;
    return this.serial(async () => {
      try {
        await inputs;
        if (this.closing || !this.sessionId) return;
        await this.applySize(this.sessionId, changed);
        // A fresh frame at once, so the viewer does not wait for the page to repaint on its own.
        if (changed && this.subscribers.size > 0) await this.startScreencast();
      } finally {
        this.pendingApplies--;
      }
    });
  }

  async startScreencast(): Promise<void> {
    if (!this.sessionId || !this.screencast) return;
    const sid = this.sessionId;
    await this.cdp.send("Page.stopScreencast", {}, sid).catch(() => {});
    this.gate.reset();
    this.heldAck = undefined;
    this.lastFrame = undefined;
    await this.cdp.send("Page.startScreencast", { format: "jpeg", everyNthFrame: this.deps.config.screencastEveryNthFrame, ...this.screencast }, sid);
  }

  private sendAck(ack: { sessionId: string; ackId: number }): void {
    this.cdp.send("Page.screencastFrameAck", { sessionId: ack.ackId }, ack.sessionId).catch(() => {});
  }

  /** A Page.screencastFrame of this tab's session (one of an older session is only acknowledged). */
  onFrame(params: Record<string, unknown>, sessionId: string | undefined): void {
    const ackId = params.sessionId;
    if (typeof ackId !== "number" || sessionId === undefined) return;
    const ack = { sessionId, ackId };
    const data = params.data;
    if (sessionId !== this.sessionId || typeof data !== "string") {
      this.sendAck(ack);
      return;
    }
    if (data.length > this.deps.config.maxFrameChars) {
      if (!this.warnedBigFrame) this.deps.logger.warn("screencast frame too large; dropped", { ...this.deps.label, chars: data.length });
      this.warnedBigFrame = true;
      this.sendAck(ack);
      return;
    }
    const metadata = params.metadata as BrowserFrameMetadata;
    this.heal(metadata);
    const frameId = ++this.frameSeq;
    const { deliverTo, ackNow } = this.gate.onFrame(frameId);
    const msg = this.deps.frame(frameId, data, metadata);
    this.lastFrame = msg;
    for (const key of deliverTo) this.sendFrame(key, msg);
    if (ackNow) this.sendAck(ack);
    else this.heldAck = ack;
  }

  /**
   * A frame that is not the size the picture asked for means the override no longer holds — e.g. Chrome resized the
   * page's view to its own window (the user or macOS moved/resized it): the frame is then the window's size with
   * the page in a corner, and clicks map wrongly. Apply the picture's size again, by itself. Bounded
   * (`viewportHealIntervalMs`, `viewportHealMaxTries`), so a client that deliberately holds another viewport is
   * not fought forever; any explicit change (picture, zoom, tab, screencast start) starts over.
   */
  private heal(metadata: BrowserFrameMetadata | undefined): void {
    const { config, logger, label } = this.deps;
    const view = this.deps.view();
    const want = view ? panelOverride(view, this.deps.zoom(), maxViewportDim) : null;
    if (!want || !metadata) return;
    // The new size is still being applied: this frame predates it (once applied, `appliedAt` gives it the interval).
    if (this.pendingApplies > 0) return;
    if (Math.abs(metadata.deviceWidth - want.width) <= 1 && Math.abs(metadata.deviceHeight - want.height) <= 1) {
      this.healTries = 0;
      return;
    }
    if (this.healTries >= config.viewportHealMaxTries) return;
    const wait = this.appliedAt + config.viewportHealIntervalMs - Date.now();
    if (wait > 0) {
      // Too soon after the last apply (this may be a frame from before it). Look again later: the page may be
      // static, so no further frame would bring us back here.
      if (this.healTimer === undefined) {
        this.healTimer = setTimeout(() => {
          this.healTimer = undefined;
          if (!this.closing && this.deps.current()) this.heal(this.lastFrame?.metadata);
        }, wait);
        this.healTimer.unref?.();
      }
      return;
    }
    this.healTries++;
    // Counts as applied now, so frames arriving before its turn do not queue more.
    this.appliedAt = Date.now();
    logger.info("browser frame is not the panel's size; applying it again", {
      ...label,
      frame: `${metadata.deviceWidth}x${metadata.deviceHeight}`,
      want: `${want.width}x${want.height}`,
    });
    const tries = this.healTries;
    this.serial(async () => {
      if (this.closing || !this.sessionId) return;
      await this.applySize(this.sessionId, true);
      this.healTries = tries;
      // The viewers still hold the wrong-sized frame, and a static page paints no new one by itself — the size may
      // even have been right all along and only that frame old (taken while the tab came to the front). Restart:
      // Chrome sends a fresh frame at once; if that one is wrong too, it brings the next try (bounded by healTries).
      if (this.subscribers.size > 0) await this.startScreencast();
    }).catch(() => {});
  }

  private sendFrame(key: object, msg: M): void {
    try {
      this.subscribers.get(key)?.send(msg);
    } catch (err) {
      this.deps.logger.warn("sending a frame failed", { ...this.deps.label, err: errText(err) });
    }
  }

  private releaseHeld(): void {
    const held = this.heldAck;
    this.heldAck = undefined;
    if (held) this.sendAck(held);
  }

  /** Frames of this tab go to `send` (one subscriber per key) until unsubscribe. */
  async subscribe(key: object, opts: ScreencastOptions, send: (msg: M) => void): Promise<void> {
    this.subscribers.set(key, { send, opts: { ...opts } });
    this.gate.add(key);
    this.screencast = mergeScreencast([...this.subscribers.values()].map((s) => s.opts));
    // A viewer (re)appears: assert the page's size again (heals an override something else cleared), then
    // restart — that makes Chrome send a frame right away, so the new viewer is not left blank.
    await this.serial(async () => {
      if (this.closing || !this.subscribers.has(key)) return;
      if (this.sessionId) await this.applySize(this.sessionId, false);
      await this.startScreencast();
    });
  }

  /** `key` stops watching; the screencast stops with the last viewer. False = it was not watching. */
  unsubscribe(key: object): boolean {
    if (!this.subscribers.delete(key)) return false;
    this.screencast = mergeScreencast([...this.subscribers.values()].map((s) => s.opts));
    if (this.gate.remove(key)) this.releaseHeld();
    if (this.subscribers.size === 0 && this.sessionId) {
      this.cdp.send("Page.stopScreencast", {}, this.sessionId).catch(() => {});
      this.heldAck = undefined;
      this.lastFrame = undefined;
    }
    return true;
  }

  ack(key: object, frameId: number): void {
    const { ackChrome, resend } = this.gate.onAck(key, frameId);
    if (resend !== undefined && this.lastFrame?.frameId === resend) this.sendFrame(key, this.lastFrame);
    if (ackChrome) this.releaseHeld();
  }

  /** Delivers one input event to the page (dropped when no session is held). */
  async input(event: BrowserInputEvent): Promise<void> {
    const sid = this.sessionId;
    if (!sid) return;
    const delivered = (async () => {
      for (const call of toCdpInput(event)) await this.cdp.send(call.method, call.params, sid);
    })();
    // Zoom and viewport changes wait for this (see reapply); a failed event must not hold them up.
    const settled = delivered.catch(() => {});
    this.inputs = Promise.all([this.inputs, settled]).then(() => {});
    await delivered;
  }

  /** The session once the queued attaches / size changes are done; NOT_FOUND when none. */
  async readySession(): Promise<string> {
    await this.queue;
    if (!this.sessionId) throw engineError("NOT_FOUND", "engine.browser.noActiveTab");
    return this.sessionId;
  }

  /**
   * Kopyalama: runs one of browser-clipboard.ts's expressions in the page and returns its (untrusted) value. A page
   * error is reported without the page's own message: it could quote what was selected.
   */
  async evaluate(expression: string): Promise<unknown> {
    const sid = await this.readySession();
    const r = await this.cdp.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
      "Runtime.evaluate",
      { expression, returnByValue: true, userGesture: true },
      sid,
    );
    if (r.exceptionDetails !== undefined) throw engineError("INVALID", "engine.browserLive.noSelection");
    return r.result?.value;
  }

  /** One CDP command on the page's session (navigation, history), once queued attaches are done. */
  async command<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const sid = await this.readySession();
    return this.cdp.send<T>(method, params, sid);
  }

  /** Kopyalama: inserts text at the page's caret. */
  async insertText(text: string): Promise<void> {
    const sid = await this.readySession();
    await this.cdp.send("Input.insertText", { text }, sid);
  }

  /**
   * Chrome let go of this tab's session without the engine asking (the engine detaches an old session only after
   * the new one is in place): attach again, so zoom, size, screencast and input never go to a dead session.
   */
  onDetached(sessionId: string): void {
    if (sessionId !== this.sessionId || this.closing) return;
    const tabId = this.tabId;
    this.sessionId = undefined;
    this.deps.logger.warn("browser tab session lost; attaching again", { ...this.deps.label, tabId });
    if (tabId === undefined || !this.deps.hasTab(tabId)) return;
    void this.serial(async () => {
      if (!this.sessionId && this.tabId === tabId && !this.closing) await this.attach(tabId);
    }).catch((err: unknown) => this.deps.logger.warn("attaching to the tab again failed", { ...this.deps.label, err: errText(err) }));
  }

  /** The tab is gone (closed, destroyed): nothing is shown until the next attach. */
  forgetTab(): void {
    this.tabId = undefined;
    this.sessionId = undefined;
  }

  /** The browser or window goes: no heal is pending, nothing is applied any more. */
  dispose(): void {
    this.closing = true;
    clearTimeout(this.healTimer);
    this.healTimer = undefined;
  }
}
