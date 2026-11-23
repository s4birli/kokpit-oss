// Is the user working in THIS window right now? Several apps (a MacBook, a second one left open on the engine
// machine) may show one project's browser in panels of different sizes; the page's size must follow the panel its
// user last used and never an unattended one. Input in the Tarayıcı panel itself claims the page directly
// (BrowserPanel); this module answers the other case — a size the panel reports by itself because it was mounted,
// shown or resized: that counts as the user's doing only shortly after their input in this window (they clicked a
// project tab, dragged a splitter) or after the focused window itself was resized (they dragged its edge).

export interface Activity {
  /** When the user last pressed a pointer button, a key or turned the wheel in this window (performance.now()). */
  lastInput: number;
  /** When the window itself was last resized. */
  lastWindowResize: number;
}

/** Whether something happening at `now` is the user's doing in this window. `windowMs` <= 0: never. */
export function userDriven(activity: Activity, now: number, focused: boolean, windowMs: number): boolean {
  if (!(windowMs > 0) || !Number.isFinite(now)) return false;
  const recent = (at: number) => now - at >= 0 && now - at <= windowMs;
  return recent(activity.lastInput) || (focused && recent(activity.lastWindowResize));
}

const INPUT_EVENTS = ["pointerdown", "mousedown", "keydown", "wheel"] as const;
const NEVER = Number.NEGATIVE_INFINITY;
const activity: Activity = { lastInput: NEVER, lastWindowResize: NEVER };
let watched: Window | null = null;

/** Starts noting the user's input in `win` (once per window; capture phase, so nothing can swallow it first). */
export function watchActivity(win: Window = window): void {
  if (watched === win) return;
  watched = win;
  const input = () => {
    activity.lastInput = performance.now();
  };
  for (const name of INPUT_EVENTS) win.addEventListener(name, input, { capture: true, passive: true });
  win.addEventListener("resize", () => {
    activity.lastWindowResize = performance.now();
  });
}

/** Whether the user is at work in this window right now (see `userDriven`). */
export function userDrivenNow(windowMs: number): boolean {
  return userDriven(activity, performance.now(), typeof document !== "undefined" && document.hasFocus(), windowMs);
}

/** Tests: as if the user had never touched this window. */
export function forgetActivity(): void {
  activity.lastInput = NEVER;
  activity.lastWindowResize = NEVER;
}
