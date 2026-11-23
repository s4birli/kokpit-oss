// A streamed page of a Chrome on the engine machine — the Tarayıcı panel's project page and every Masaüstü window
// show it the same way. The page arrives as a CDP screencast on a canvas; mouse, wheel, keyboard (with IME), the
// clipboard, the right-click menu and the zoom gestures go back to it. What differs between the two surfaces is only
// how a request names the page (`browser.*` with a project, `desktop.*` with an app): that is the `PageChannel`.
//
// Kopyalama: the page lives on the engine machine, the clipboard the user means is THIS machine's. While the
// picture has focus, copy / cut / paste become engine requests: `copy` returns what is selected in the remote page
// (written to the local clipboard by main), `paste` inserts the local clipboard's text at the remote caret. Cmd+C /
// Cmd+X are handled on the key itself; the Düzen menu, the right-click menu and Cmd+V (the menu's key equivalent)
// arrive as the browser's `copy` / `cut` / `paste` events on the canvas. Nothing is read from either side except on
// such a gesture.
// Right click: the page's own context menu is not streamed, so a right click opens a native Kokpit menu (Kopyala,
// Yapıştır, Bağlantıyı kopyala, Adresi kopyala) and is NOT sent to the page. With the pass modifier held
// (clipboard.defaults.json `pageContextPassModifier`, ⌥ Option) it goes to the page instead — for pages that
// handle `contextmenu` themselves.
import {
  BROWSER_LIMITS,
  CLIPBOARD_LIMITS,
  type BrowserContextInfo,
  type BrowserFrameMetadata,
  type BrowserInputEvent,
} from "@kokpit/shared";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactElement } from "react";
import { clipboardConfig, type ClipboardBridge } from "../engine/clipboard-ipc.ts";
import type { EngineClient } from "../engine/types.ts";
import { userDrivenNow, watchActivity } from "./browser-activity.ts";
import { createPinchZoom, createZoomBubble } from "./browser-zoom-gestures.ts";
import { attachCanvasClipboard } from "./canvas-clipboard.ts";
import {
  clipboardShortcut,
  keyEventFrom,
  modifiersOf,
  panelViewport,
  rightClickGoesToPage,
  screencastSize,
  toPagePoint,
  wheelEventFrom,
  type Size,
} from "./browser-input.ts";
import type { UiConfig } from "./config.ts";
import { useStreamVisible } from "./stream-visibility.ts";
import { base64ToBytes } from "./base64.ts";
import { errorMessage, isDisconnected } from "./errors.ts";
import { useT } from "../../i18n/index.ts";
import { fitSize } from "./fit-size.ts";
import { onViewCommand, shortcutStep, zoomAfter, zoomLabel, type Step } from "./view-prefs.ts";
import { routeKey, type SurfaceAction } from "./page-keys.ts";

/** Draws one base64 JPEG on the canvas; resolves with the image size (null = not drawn). */
export type FrameDrawer = (canvas: HTMLCanvasElement, data: string) => Promise<Size | null>;

export const drawJpegFrame: FrameDrawer = async (canvas, data) => {
  const bitmap = await createImageBitmap(new Blob([base64ToBytes(data) as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }));
  try {
    if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
    if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
};

/** One screencast frame, whichever surface it belongs to. */
export interface PageFrame {
  frameId: number;
  data: string;
  metadata: BrowserFrameMetadata;
}

/**
 * How one streamed page is reached: the project's active tab (`browser.*`) or a desktop window (`desktop.*`). Every
 * method sends exactly one engine request or frame; the engine decides (owner of the viewport, zoom, …).
 */
export interface PageChannel {
  /** Unique per page and connection: panels showing the same page share one engine subscription. */
  key: string;
  onFrame(cb: (frame: PageFrame) => void): () => void;
  ack(frameId: number): void;
  input(event: BrowserInputEvent): void;
  startCast(size: { maxWidth: number; maxHeight: number; quality: number }): Promise<unknown>;
  stopCast(): Promise<unknown>;
  /** `interaction`: the user just used this page (claims its viewport). */
  setViewport(size: Size, interaction: boolean): Promise<{ applied: boolean }>;
  /** A user's zoom step; null = the engine's default. */
  setZoom(zoom: number | null): Promise<{ zoom: number }>;
  copy(cut: boolean): Promise<{ text: string }>;
  paste(text: string): Promise<unknown>;
  context(at: { x: number; y: number }): Promise<BrowserContextInfo>;
  /** The engine announced a change of this page (its tab switched, its browser restarted…). */
  onChanged(cb: () => void): () => void;
}

export type PageClipboard = Pick<ClipboardBridge, "writeText" | "pageMenu">;

export function defaultClipboard(): PageClipboard | null {
  return typeof window === "undefined" ? null : (window.kokpit?.clipboard ?? null);
}

/**
 * Panels showing one page's screencast, per engine connection. The engine has one subscription per connection and
 * page: a panel that goes away must not stop the stream another one (e.g. its replacement, mounted before the old
 * one's cleanup ran) still shows.
 */
const viewers = new WeakMap<EngineClient, Map<string, number>>();
function addViewer(client: EngineClient, key: string, delta: 1 | -1): number {
  let counts = viewers.get(client);
  if (!counts) viewers.set(client, (counts = new Map()));
  const n = Math.max(0, (counts.get(key) ?? 0) + delta);
  if (n === 0) counts.delete(key);
  else counts.set(key, n);
  return n;
}

const RIGHT_BUTTON = 2;
const BUTTONS = ["left", "middle", "right"] as const;

export interface PageViewOptions {
  client: EngineClient;
  channel: PageChannel;
  config: UiConfig;
  /** The page's browser runs: frames are asked for (while the view is visible). */
  running: boolean;
  drawFrame: FrameDrawer;
  clipboard: PageClipboard | null;
  isMac: boolean;
  /** The page's address (the right-click menu's "Adresi kopyala"). */
  pageUrl: string;
  /** Shows (or clears, null) a line about a failed request. */
  onError(message: string | null): void;
  /** Re-reads the page's state from the engine (after a refused zoom, a won viewport). */
  reload(): Promise<void>;
  /** Görünüm › Tarayıcıyı yakınlaştır/uzaklaştır also zoom this page. */
  menuZoom: boolean;
  /** The canvas's accessible name. */
  label?: string;
  /** Extra attributes of the picture area (tests and e2e find a page by them). */
  viewAttrs?: Record<string, string>;
  /**
   * Masaüstü faz 2 — a Mac window instead of a page: false = no page zoom (⌘ − / = / 0 and Ctrl + wheel / pinch go to
   * the app like any key and wheel), and the right click goes to the app (its own menu) instead of Kokpit's menu.
   */
  pageZoom?: boolean;
  rightClick?: "menu" | "app";
  /**
   * The browser's own shortcuts (page-keys.ts: address bar, tabs, reload, back / forward, find) pressed anywhere in
   * the surface. Returns whether the surface did it; a key it does not handle goes on to the page.
   */
  onShortcut?(action: SurfaceAction): boolean;
}

export interface PageView {
  /** The picture area: canvas + zoom bubble. */
  element: ReactElement;
  /**
   * Capture-phase key handler for the whole surface: Cmd/Ctrl + − / = / 0 zoom the page and the browser's own
   * shortcuts go to `onShortcut` instead of reaching the page (their key-ups too).
   */
  onSurfaceKey(e: KeyboardEvent<HTMLElement>): void;
  /** The engine's word on the page: its zoom and whether this connection drives its viewport. */
  engineZoom(zoom: number | undefined): void;
  engineOwner(owner: boolean): void;
  zoom: number;
}

export function usePageView(o: PageViewOptions): PageView {
  const t = useT();
  const { client, channel, config, running } = o;
  const mac = o.isMac;
  const clip = o.clipboard;
  const viewRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** Last drawn frame: what pointer coordinates are mapped against. */
  const frameRef = useRef<{ image: Size; metadata: BrowserFrameMetadata } | null>(null);
  /** Frames drawn; written to the canvas's data-frames directly (Performans: a frame re-renders nothing). */
  const framesDrawn = useRef(0);
  /** The size last put in `frameSize`. */
  const sizeRef = useRef<Size | null>(null);
  /** The picture area (CSS px) and the last frame's pixel size: the canvas is fitted into the one in the other's shape. */
  const [box, setBox] = useState<Size | null>(null);
  const [frameSize, setFrameSize] = useState<Size | null>(null);
  const configRef = useRef(config);
  configRef.current = config;
  const drawRef = useRef(o.drawFrame);
  drawRef.current = o.drawFrame;
  const errorRef = useRef(o.onError);
  errorRef.current = o.onError;
  const reloadRef = useRef(o.reload);
  reloadRef.current = o.reload;
  const setError = useCallback((m: string | null) => errorRef.current(m), []);

  // ---- İş Z: page zoom ----
  // The zoom is the engine's (one value per page for every app, persisted there and reported in every state). This
  // view shows it and sends the user's steps; it never pushes a copy of its own — a view that is mounted,
  // reconnects or gets focus only READS.
  /** Until the engine reports the page's zoom: the default. */
  const [zoom, setZoom] = useState(config.browserZoom);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  /** The user's zoom steps the engine has not answered yet: until then its reports are older than their choice. */
  const zoomPending = useRef(0);
  const engineZoom = useCallback((z: number | undefined) => {
    if (zoomPending.current > 0 || typeof z !== "number" || !Number.isFinite(z) || z <= 0) return;
    zoomRef.current = z;
    setZoom(z);
  }, []);
  /**
   * Whether this view drives the page's viewport. Several apps may show the page in views of different sizes; the
   * engine lets ONE of them size the page — the one whose user last used its view — and the others fit the frames
   * they get. The engine says who (`viewportOwner`) in every state.
   */
  const [owner, setOwner] = useState(false);
  const ownerRef = useRef(owner);
  const engineOwner = useCallback((value: boolean) => {
    ownerRef.current = value;
    setOwner(value);
  }, []);
  /** Set by the screencast effect: "the user is working in this view" (takes the viewport over if needed). */
  const claimRef = useRef<(() => void) | null>(null);
  /** Chrome's zoom bubble: "%80 − + Sıfırla", top right, for a while after this user's zoom change. */
  const [bubbleShown, setBubbleShown] = useState(false);
  const bubble = useMemo(() => createZoomBubble(() => configRef.current.browserZoomBubbleMs, setBubbleShown), []);
  useEffect(() => () => bubble.dispose(), [bubble]);
  // The bubble goes with the page view (browser closed): no mouseleave will come, so it is not hovered any more.
  useEffect(() => {
    if (!running) bubble.hover(false);
  }, [running, bubble]);
  const stepZoom = useCallback(
    (step: Step) => {
      const next = zoomAfter(step, zoomRef.current, configRef.current);
      bubble.show();
      // At either end of the levels a step changes nothing: nothing to tell the engine (as in Chrome).
      if (step !== "reset" && next === zoomRef.current) return;
      // Shown at once; the engine's answer (and its announcement to every app) confirms it.
      zoomRef.current = next;
      setZoom(next);
      // The user zooms what they see here: this view's size goes first, the engine applies both in order.
      claimRef.current?.();
      zoomPending.current++;
      setError(null);
      channel.setZoom(step === "reset" ? null : next).then(
        (r) => {
          zoomPending.current--;
          engineZoom(r.zoom);
        },
        (err: unknown) => {
          zoomPending.current--;
          if (isDisconnected(err)) return;
          setError(errorMessage(err));
          // Back to what the engine has.
          void reloadRef.current();
        },
      );
    },
    [channel, engineZoom, bubble, setError],
  );
  const stepZoomRef = useRef(stepZoom);
  stepZoomRef.current = stepZoom;
  /** Trackpad pinch / Ctrl + wheel → zoom steps (browser-zoom-gestures.ts). */
  const pinch = useMemo(() => createPinchZoom(() => configRef.current), []);
  const menuZoom = o.menuZoom;
  useEffect(() => {
    if (!menuZoom) return;
    return onViewCommand((cmd) => {
      if (cmd === "browser.zoom.in") stepZoom("larger");
      else if (cmd === "browser.zoom.out") stepZoom("smaller");
      else if (cmd === "browser.zoom.reset") stepZoom("reset");
    });
  }, [stepZoom, menuZoom]);
  /** Codes of surface shortcut keys (zoom, page-keys.ts) still down: their key-up is not the page's (also when Cmd came up first). */
  const surfaceKeys = useRef(new Set<string>());
  const pageZoom = o.pageZoom !== false;
  /** A web page follows Chrome's key rule (page-keys.ts); a Mac window (Masaüstü faz 2) gets every key, as before. */
  const chromeKeys = pageZoom;
  const rightToApp = o.rightClick === "app";
  const onShortcutRef = useRef(o.onShortcut);
  onShortcutRef.current = o.onShortcut;
  const onSurfaceKey = (e: KeyboardEvent<HTMLElement>) => {
    const keep = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.type === "keyup") {
      if (surfaceKeys.current.delete(e.code) || (pageZoom && shortcutStep(e))) keep();
      return;
    }
    if (e.type !== "keydown" || e.nativeEvent.isComposing) return;
    const step = pageZoom ? shortcutStep(e) : null;
    if (step) {
      surfaceKeys.current.add(e.code);
      keep();
      stepZoom(step);
      return;
    }
    if (!chromeKeys) return;
    const route = routeKey(e, mac);
    if (route.to !== "surface") return;
    // Held down: the action ran once; the repeats are nobody's.
    if (e.repeat && surfaceKeys.current.has(e.code)) {
      keep();
      return;
    }
    if (onShortcutRef.current?.(route.action) !== true) return;
    surfaceKeys.current.add(e.code);
    keep();
  };

  // Screencast lifecycle: subscribe while running; restart on reconnect and when the viewer is resized.
  /** Performans: frames only while someone can see the view; agents drive the page over CDP regardless. */
  const visible = useStreamVisible(viewRef, running, config.streamHideGraceMs);

  useEffect(() => {
    if (!running || !visible) return;
    let disposed = false;
    let drawing = false;
    let pending: PageFrame | null = null;
    let lastSize = "";

    const drawNext = async (): Promise<void> => {
      const canvas = canvasRef.current;
      if (drawing || !pending || !canvas) return;
      const frame = pending;
      pending = null;
      drawing = true;
      try {
        const image = await drawRef.current(canvas, frame.data);
        if (disposed) return;
        if (image) {
          frameRef.current = { image, metadata: frame.metadata };
          canvas.setAttribute("data-frames", String(++framesDrawn.current));
          // The page size this picture shows — what a click on it is mapped against (tests wait for the new one).
          canvas.setAttribute("data-frame-size", `${frame.metadata.deviceWidth}x${frame.metadata.deviceHeight}`);
          // Only a new size is state: setting the same one still costs React a render of the view per frame.
          if (sizeRef.current?.width !== image.width || sizeRef.current?.height !== image.height) {
            sizeRef.current = { width: image.width, height: image.height };
            setFrameSize(sizeRef.current);
          }
        }
      } catch {
        /* a broken frame is skipped; the ack below lets the next one come */
      } finally {
        drawing = false;
      }
      // Acking the newest drawn frame also covers every frame skipped in between.
      channel.ack(frame.frameId);
      if (!disposed) void drawNext();
    };
    const offFrame = channel.onFrame((frame) => {
      if (disposed) return;
      if (pending) channel.ack(pending.frameId);
      pending = frame;
      void drawNext();
    });

    /** The picture area, or null while the view is hidden / too small to be of use. */
    const measure = (): Size | null => {
      const view = viewRef.current;
      return view ? panelViewport({ width: view.clientWidth, height: view.clientHeight }, configRef.current.browserMinViewport) : null;
    };
    let lastView = "";
    let hidden = false;
    /** A claim the engine has not answered yet (a stream of wheel events sends one, not one each). */
    let claiming = false;
    /**
     * A mouse button is held down on the view. Until it is released no size is reported: the page must not change
     * under a click (the release has to land on what the press hit) — e.g. when the click itself brings the window
     * to the front, which would report the size at once. `deferred`: a report is due after the release.
     */
    let pressed = false;
    let deferred = false;
    /**
     * Tells the engine the picture area's size: the page's layout viewport becomes that ÷ zoom, so the picture has
     * the view's shape. Sent when it changes — and again (`force`) on mount, reconnect, when the view is shown
     * again and when the window gets focus, so a stale size heals itself. Never sent for a hidden (0×0) view or a
     * window nobody can see: the page — which an agent may be driving — keeps its last real size.
     * The engine uses the size only if this view drives the page's viewport (or nobody does). `used` — the user
     * just used this view — and a report caused by the user working in this window carry the claim that makes it
     * the driver; an unattended view's reports never do, so it cannot take the page from the app in use.
     */
    const sendViewport = (force: boolean, used = false) => {
      if (pressed) {
        deferred = true;
        return;
      }
      const size = document.visibilityState === "hidden" ? null : measure();
      if (!size) {
        hidden = true;
        return;
      }
      const key = `${size.width}x${size.height}`;
      const again = force || hidden;
      hidden = false;
      if (!again && key === lastView) return;
      lastView = key;
      const interaction = used || userDrivenNow(configRef.current.browserInteractionMs);
      if (interaction) claiming = true;
      // Best effort: an engine that does not know the request still streams, and the picture is fitted anyway.
      channel.setViewport(size, interaction).then(
        (r) => {
          if (interaction) claiming = false;
          if (disposed) return;
          // "Not used" is certain at once. "Used" may already be out of date when the answer arrives (another
          // app's user was quicker): who drives is read from the engine's state, never assumed.
          if (r.applied === false) engineOwner(false);
          else if (r.applied === true && !ownerRef.current) void reloadRef.current();
        },
        () => {
          if (interaction) claiming = false;
        },
      );
    };
    /** The user works in this view: if another viewer drives the page's size, take over. */
    const claim = () => {
      if (!ownerRef.current && !claiming) sendViewport(true, true);
    };
    claimRef.current = claim;
    watchActivity();
    /**
     * Input in the surface (the page, its tabs, its address bar or title bar). Heard on the window, i.e. after the
     * surface's own handlers sent the event to the page: a click was aimed at the page as it looked, so it goes
     * first and the engine delivers it before it resizes the page for this view. The press alone does not claim —
     * the release must still land on the element the press hit.
     */
    const inPanel = (e: Event): boolean => {
      const panel = viewRef.current?.parentElement;
      return panel !== null && panel !== undefined && e.target instanceof Node && panel.contains(e.target);
    };
    const onUsed = (e: Event) => {
      if (inPanel(e)) claim();
    };
    const released = () => {
      pressed = false;
      const due = deferred;
      deferred = false;
      if (!ownerRef.current) claim();
      else if (due) sendViewport(true);
    };
    const onDown = (e: Event) => {
      if (inPanel(e)) pressed = true;
    };
    const onUp = (e: Event) => {
      if (pressed) released();
      else onUsed(e);
    };
    /** A release this window never saw (the button came up outside it): the next movement shows no button. */
    const onMove = (e: globalThis.MouseEvent) => {
      if (pressed && e.buttons === 0) released();
    };
    const USED = ["keydown", "wheel"] as const;
    for (const name of USED) window.addEventListener(name, onUsed, { passive: true });
    // The press is noted before anything else can react to it (capture); the release after the view sent it.
    window.addEventListener("mousedown", onDown, { capture: true, passive: true });
    window.addEventListener("mouseup", onUp, { passive: true });
    window.addEventListener("mousemove", onMove, { passive: true });
    /**
     * The engine refused the screencast (e.g. its tab was going away under it): asked again when the engine next
     * announces a change of this page (tab switched, attached again) — the picture must not stay dead.
     */
    let castFailed = false;
    const start = (force: boolean) => {
      // The engine applies these in order: the size first, then the screencast starts at that size.
      sendViewport(force);
      const area = measure();
      // Hidden: nothing changes until it is shown again.
      if (!area && !force) return;
      // Mounted while unmeasurable: bounded by the window until the view has a size.
      const size = screencastSize(area ?? { width: window.innerWidth, height: window.innerHeight }, window.devicePixelRatio, BROWSER_LIMITS.maxScreencastDim);
      const key = `${size.maxWidth}x${size.maxHeight}`;
      if (!force && key === lastSize) return;
      lastSize = key;
      const retry = castFailed;
      castFailed = false;
      channel.startCast({ ...size, quality: configRef.current.browserQuality }).then(
        () => {
          if (retry && !disposed) setError(null);
        },
        (err: unknown) => {
          if (disposed || isDisconnected(err)) return;
          castFailed = true;
          setError(errorMessage(err));
        },
      );
    };
    const offChanged = channel.onChanged(() => {
      if (castFailed && !disposed) start(true);
    });
    addViewer(client, channel.key, 1);
    start(true);
    const offReconnect = client.onReconnected(() => start(true));
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const readBox = () => {
      const view = viewRef.current;
      if (view) setBox((old) => (old && old.width === view.clientWidth && old.height === view.clientHeight ? old : { width: view.clientWidth, height: view.clientHeight }));
    };
    readBox();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      // The picture is refitted at once; the engine hears about the new size when the resize settles.
      readBox();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => start(false), configRef.current.resizeDebounceMs);
    });
    if (observer && viewRef.current) observer.observe(viewRef.current);
    // Back in front of the user: assert the size. The screencast restarts only if its bounds changed (the window
    // moved to a screen with another pixel ratio).
    const onShown = () => {
      if (document.visibilityState === "hidden") return;
      sendViewport(true);
      start(false);
    };
    window.addEventListener("focus", onShown);
    document.addEventListener("visibilitychange", onShown);

    return () => {
      disposed = true;
      clearTimeout(resizeTimer);
      observer?.disconnect();
      window.removeEventListener("focus", onShown);
      document.removeEventListener("visibilitychange", onShown);
      for (const name of USED) window.removeEventListener(name, onUsed);
      window.removeEventListener("mousedown", onDown, { capture: true });
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("mousemove", onMove);
      if (claimRef.current === claim) claimRef.current = null;
      offFrame();
      offReconnect();
      offChanged();
      frameRef.current = null;
      sizeRef.current = null;
      setFrameSize(null);
      if (addViewer(client, channel.key, -1) === 0) channel.stopCast().catch(() => {});
    };
  }, [client, channel, running, visible, engineOwner, setError]);

  // ---------- input ----------

  const send = useCallback((event: BrowserInputEvent) => channel.input(event), [channel]);

  const pagePoint = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const frame = frameRef.current;
    if (!canvas || !frame) return null;
    const r = canvas.getBoundingClientRect();
    return toPagePoint({ x: clientX - r.left, y: clientY - r.top }, { width: r.width, height: r.height }, frame.image, frame.metadata);
  }, []);

  const moveRef = useRef<{ x: number; y: number; mods: ReturnType<typeof modifiersOf> } | null>(null);
  const moveFrame = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (moveFrame.current !== null) cancelAnimationFrame(moveFrame.current);
    },
    [],
  );

  const onMouseButton = (action: "down" | "up") => (e: MouseEvent<HTMLCanvasElement>) => {
    // Map the point BEFORE focusing, and focus without scrolling: nothing may move under the pointer between
    // the press and its mapping.
    const p = pagePoint(e.clientX, e.clientY);
    if (action === "down") e.currentTarget.focus({ preventScroll: true });
    if (!p) return;
    e.preventDefault();
    // A right click opens Kokpit's menu (onContextMenu) and stays here, unless the pass modifier is held.
    if (e.button === RIGHT_BUTTON && !rightToApp && !rightClickGoesToPage(e, clipboardConfig.pageContextPassModifier)) return;
    send({
      type: "mouse",
      action,
      ...p,
      button: BUTTONS[e.button] ?? "left",
      clickCount: Math.min(3, Math.max(1, e.detail || 1)),
      modifiers: modifiersOf(e),
    });
  };

  const onMouseMove = (e: MouseEvent<HTMLCanvasElement>) => {
    const p = pagePoint(e.clientX, e.clientY);
    if (!p) return;
    moveRef.current = { ...p, mods: modifiersOf(e) };
    if (moveFrame.current !== null) return;
    moveFrame.current = requestAnimationFrame(() => {
      moveFrame.current = null;
      const m = moveRef.current;
      moveRef.current = null;
      if (m) send({ type: "mouse", action: "move", x: m.x, y: m.y, modifiers: m.mods });
    });
  };

  // Wheel needs a non-passive listener to keep the Kokpit page itself from scrolling.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !running) return;
    const onWheel = (e: WheelEvent) => {
      // A trackpad pinch (Chromium: ctrlKey wheel events) or Ctrl + wheel zooms, as in Chrome: never the page's
      // scroll, and Kokpit's own window is not zoomed either.
      if (e.ctrlKey && pageZoom) {
        e.preventDefault();
        const dir = pinch.feed(e, (d) => zoomAfter(d, zoomRef.current, configRef.current) !== zoomRef.current);
        if (dir) stepZoomRef.current(dir);
        return;
      }
      const p = pagePoint(e.clientX, e.clientY);
      if (!p) return;
      e.preventDefault();
      const c = configRef.current;
      send(wheelEventFrom(p, e, { lineHeight: c.browserWheelLineHeight, pageHeight: c.browserWheelPageHeight }));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [running, pagePoint, send, pinch, pageZoom]);

  // ---------- Kopyalama ----------

  /** Codes of clipboard shortcuts that were not sent to the page: their key-up is not the page's either. */
  const shortcutKeys = useRef(new Set<string>());

  const reportError = useCallback(
    (err: unknown) => {
      if (!isDisconnected(err)) setError(errorMessage(err));
    },
    [setError],
  );

  /** The remote page's selection → this machine's clipboard (`cut`: the page also loses it). */
  const copyFromPage = (cut: boolean): void => {
    setError(null);
    channel
      .copy(cut)
      .then(({ text }) => {
        if (text === "") return undefined;
        if (!clip) throw new Error(t("browser.page.noClipboard"));
        return clip.writeText(text);
      })
      .catch(reportError);
  };
  const onKey = (action: "down" | "up") => (e: KeyboardEvent<HTMLCanvasElement>) => {
    if (action === "down") {
      const shortcut = clipboardShortcut(e, mac);
      if (shortcut) {
        // Not the page's key.
        shortcutKeys.current.add(e.code);
        // Paste needs the clipboard's text: the key is left alone, so the Düzen menu's Yapıştır (whose key
        // equivalent this is) runs and its `paste` event brings the text (onPaste).
        if (shortcut === "paste") return;
        // Copy / cut are done right here; the key goes no further (no second copy through the menu).
        e.preventDefault();
        if (!e.repeat) copyFromPage(shortcut === "cut");
        return;
      }
      // Kokpit's menu keys (Cmd+Q, Cmd+H, Cmd+, …): left alone, so the menu bar runs them — never the page's.
      if (chromeKeys && routeKey(e, mac).to === "app") {
        shortcutKeys.current.add(e.code);
        return;
      }
      shortcutKeys.current.delete(e.code);
    } else if (shortcutKeys.current.delete(e.code)) {
      return;
    }
    const ev = keyEventFrom(e, action);
    if (!ev) return;
    e.preventDefault();
    send(ev);
  };

  /** This machine's clipboard text → the remote page's caret. Too long is refused, never cut short. */
  const pasteIntoPage = (text: string): void => {
    if (text === "") return;
    if (text.length > CLIPBOARD_LIMITS.maxChars) {
      setError(t("browser.page.pasteTooLarge", { max: CLIPBOARD_LIMITS.maxChars }));
      return;
    }
    setError(null);
    channel.paste(text).catch(reportError);
  };

  // Düzen › Kopyala / Kes / Yapıştır (and Cmd+V, its key equivalent) and the right-click menu's roles: the browser's
  // clipboard events while the picture has the focus (canvas-clipboard.ts).
  const clipboardHandlers = useRef({ copy: () => copyFromPage(false), cut: () => copyFromPage(true), paste: pasteIntoPage });
  clipboardHandlers.current = { copy: () => copyFromPage(false), cut: () => copyFromPage(true), paste: pasteIntoPage };
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !running) return;
    return attachCanvasClipboard(canvas, {
      copy: () => clipboardHandlers.current.copy(),
      cut: () => clipboardHandlers.current.cut(),
      paste: (text) => clipboardHandlers.current.paste(text),
    });
  }, [running]);

  /** Right click: Kokpit's native menu for that point of the page (the page's own menu is not streamed). */
  const pageUrl = o.pageUrl;
  const onContextMenu = (e: MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (rightToApp || rightClickGoesToPage(e, clipboardConfig.pageContextPassModifier)) return;
    const p = pagePoint(e.clientX, e.clientY);
    if (!p || !clip) return;
    setError(null);
    channel
      .context(p)
      .then((info) =>
        clip.pageMenu({
          canCopy: info.hasSelection,
          canCut: info.hasSelection && info.editable,
          canPaste: info.editable,
          ...(info.linkUrl !== undefined ? { linkUrl: info.linkUrl } : {}),
          ...(pageUrl !== "" ? { pageUrl } : {}),
        }),
      )
      .catch(reportError);
  };

  /** The largest box of the frame's shape inside the picture area: never larger than the view, nothing to scroll. */
  const fitted = box && frameSize ? fitSize(box, frameSize) : null;

  const element = (
    <div className="kp-browser__view" ref={viewRef} data-zoom={zoom} data-viewport-owner={owner} {...o.viewAttrs}>
      <canvas
        ref={canvasRef}
        className="kp-browser__canvas"
        aria-label={o.label ?? t("browser.page.picture")}
        tabIndex={0}
        style={fitted ? { width: `${fitted.width}px`, height: `${fitted.height}px` } : undefined}
        onMouseDown={onMouseButton("down")}
        onMouseUp={onMouseButton("up")}
        onMouseMove={onMouseMove}
        onContextMenu={onContextMenu}
        onKeyDown={onKey("down")}
        onKeyUp={onKey("up")}
      />
      {bubbleShown && (
        <div
          className="kp-browser__zoom-bubble"
          role="group"
          aria-label={t("browser.page.zoomBubble")}
          onMouseEnter={() => bubble.hover(true)}
          onMouseLeave={() => bubble.hover(false)}
          // A press must not take the focus from the page: Cmd + − / = keeps working after a click here.
          onMouseDown={(e) => e.preventDefault()}
        >
          <span className="kp-browser__zoom-value" aria-live="polite">
            {zoomLabel(zoom)}
          </span>
          <button type="button" className="kp-btn kp-btn--quiet" aria-label={t("browser.page.zoomOut")} title={t("browser.page.zoomOut")} onClick={() => stepZoom("smaller")}>
            −
          </button>
          <button type="button" className="kp-btn kp-btn--quiet" aria-label={t("browser.page.zoomIn")} title={t("browser.page.zoomIn")} onClick={() => stepZoom("larger")}>
            +
          </button>
          <button type="button" className="kp-btn" onClick={() => stepZoom("reset")}>
            {t("browser.page.zoomReset")}
          </button>
        </div>
      )}
    </div>
  );

  return { element, onSurfaceKey, engineZoom, engineOwner, zoom };
}
