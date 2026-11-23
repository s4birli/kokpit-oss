// Chrome-like zoom gestures of the Tarayıcı panel (pure; BrowserPanel wires them).
//
// Pinch: Chromium delivers a trackpad pinch to the page as `wheel` events with `ctrlKey: true` (deltaY < 0 = fingers
// apart = zoom in); Ctrl + a mouse wheel looks the same. Chrome on macOS magnifies on a pinch WITHOUT re-layout
// (visual zoom) and pages through its zoom levels on Ctrl + wheel. Here both step through the configured levels of
// the project's engine-owned LAYOUT zoom: the page is re-laid out for panel ÷ zoom, so the picture always fills the
// panel and a click maps exactly — a visual zoom would need a second, viewer-local scale (and panning) that an agent
// driving the same Chrome would also see.
import type { UiConfig } from "./config.ts";
import type { Step } from "./view-prefs.ts";

export type ZoomDirection = Exclude<Step, "reset">;

/** The part of a WheelEvent a pinch is read from. */
export interface PinchInput {
  deltaY: number;
  /** 0 px, 1 lines, 2 pages (DOM `deltaMode`). */
  deltaMode: number;
  /** ms, any monotonic clock (DOM `timeStamp`). */
  timeStamp: number;
}

type PinchConfig = Pick<UiConfig, "browserPinchStepDelta" | "browserPinchIdleMs" | "browserWheelLineHeight" | "browserWheelPageHeight">;

/** Rounding slack: a delta of exactly one step must make it, also after a line/page conversion. */
const EPS = 1e-6;

export interface PinchZoom {
  /**
   * One ctrlKey wheel event → the zoom step it completes, or null. `can` says whether a step that way is possible
   * (false at the end of the levels): a blocked step leaves nothing built up, so zooming back works at once.
   */
  feed(e: PinchInput, can: (dir: ZoomDirection) => boolean): ZoomDirection | null;
}

/**
 * Accumulates a pinch's deltas into discrete steps: one step per `browserPinchStepDelta`, at most one per event
 * (a single large delta — a mouse notch — is one step, and leaves nothing over). Reversing direction or pausing
 * (`browserPinchIdleMs`) starts afresh.
 */
export function createPinchZoom(config: () => PinchConfig): PinchZoom {
  /** Built-up zoom-in amount (px of −deltaY); negative = towards zooming out. */
  let acc = 0;
  let last = Number.NEGATIVE_INFINITY;
  return {
    feed(e, can) {
      const c = config();
      const factor = e.deltaMode === 1 ? c.browserWheelLineHeight : e.deltaMode === 2 ? c.browserWheelPageHeight : 1;
      const amount = -e.deltaY * factor;
      if (!Number.isFinite(amount) || amount === 0 || !Number.isFinite(e.timeStamp)) return null;
      if (e.timeStamp < last || e.timeStamp - last > c.browserPinchIdleMs) acc = 0;
      last = e.timeStamp;
      if (Math.sign(amount) !== Math.sign(acc)) acc = 0;
      acc += amount;
      const threshold = c.browserPinchStepDelta;
      if (Math.abs(acc) < threshold - EPS) return null;
      const dir: ZoomDirection = acc > 0 ? "larger" : "smaller";
      if (!can(dir)) {
        acc = 0;
        return null;
      }
      const rest = Math.abs(acc) - threshold;
      // A smooth overshoot carries over; a jump past a whole further step (one huge delta) does not.
      acc = rest > EPS && rest < threshold ? Math.sign(acc) * rest : 0;
      return dir;
    },
  };
}

export interface ZoomBubble {
  /** A zoom change: show (again) and (re)start the time to hide — unless the pointer is on the bubble. */
  show(): void;
  /** The pointer entered (true) / left (false) the bubble: it stays while hovered. */
  hover(on: boolean): void;
  dispose(): void;
}

/** Show/hide timing of the zoom bubble (Chrome's: hides after a while, stays while hovered). */
export function createZoomBubble(hideAfterMs: () => number, onVisible: (visible: boolean) => void): ZoomBubble {
  let visible = false;
  let hovered = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const arm = () => {
    stop();
    if (hovered || !visible) return;
    timer = setTimeout(() => {
      timer = undefined;
      visible = false;
      onVisible(false);
    }, hideAfterMs());
  };
  return {
    show() {
      if (!visible) {
        visible = true;
        onVisible(true);
      }
      arm();
    },
    hover(on) {
      hovered = on;
      if (on) stop();
      else arm();
    },
    dispose: stop,
  };
}
