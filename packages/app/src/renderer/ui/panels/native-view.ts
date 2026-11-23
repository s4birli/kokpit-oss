// İş M: a panel whose content is a native WebContentsView drawn by Electron main over
// the panel's surface. The panel only reports, every frame while mounted, where that surface is on screen (or that it
// isn't: zero size, hidden window, an app modal on top), and main moves the view. Shared by every native-view panel (the Web panel).
import { useEffect, useRef, type RefObject } from "react";
import type { SurfaceBounds } from "../../engine/surface.ts";

/** Runs `cb` on the next frame; returns a cancel. Tests inject a manual one. */
export type FrameScheduler = (cb: () => void) => () => void;

export const animationFrames: FrameScheduler = (cb) => {
  const id = requestAnimationFrame(cb);
  return () => cancelAnimationFrame(id);
};

/** App overlays the native view would cover; while one is open the view steps aside. */
const MODAL_SELECTOR = '[aria-modal="true"], dialog[open]';

function sameBounds(a: SurfaceBounds | null, b: SurfaceBounds | null): boolean {
  return a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);
}

/** The surface's rectangle in window pixels, or null when the view must not be on screen. */
export function measureSurface(el: HTMLElement): SurfaceBounds | null {
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  if (typeof document !== "undefined" && document.hidden) return null;
  const modal = document.querySelector(MODAL_SELECTOR);
  if (modal && !el.contains(modal)) return null;
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
}

export interface SurfaceReporter {
  /** Restarts the loop when it changes (e.g. another project / site). */
  key: string;
  /** False: nothing is reported (and the view is not hidden either, e.g. while it is being destroyed). */
  active: boolean;
  schedule: FrameScheduler;
  show(bounds: SurfaceBounds): Promise<void>;
  hide(): Promise<void>;
  onError(err: unknown): void;
  /** Set while the view is being destroyed: leaving the loop must not hide it on its way out. */
  skipFinalHide?: RefObject<boolean>;
}

/** Every frame: where is the surface? Reports only changes (show with bounds / hide); hides on the way out. */
export function useSurfaceReporter(surface: RefObject<HTMLElement | null>, opts: SurfaceReporter): void {
  const latest = useRef(opts);
  latest.current = opts;
  const { key, active, schedule } = opts;
  useEffect(() => {
    if (!active) return;
    let last: SurfaceBounds | null = null;
    let shown = false;
    let cancel = () => {};
    // The view this loop is about (a new key gets its own loop; the old one must hide its own view).
    const hideOwn = latest.current.hide;
    const frame = () => {
      const el = surface.current;
      const bounds = el ? measureSurface(el) : null;
      if (bounds && !sameBounds(bounds, last)) {
        void latest.current.show(bounds).catch(latest.current.onError);
        shown = true;
      } else if (!bounds && shown) {
        void latest.current.hide().catch(latest.current.onError);
        shown = false;
      }
      last = bounds;
      cancel = schedule(frame);
    };
    frame();
    return () => {
      cancel();
      if (!latest.current.skipFinalHide?.current) void hideOwn().catch(() => {});
    };
  }, [surface, key, active, schedule]);
}
