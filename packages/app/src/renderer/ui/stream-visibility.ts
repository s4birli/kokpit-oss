// Performans: a streamed surface (e.g. Tarayıcı) asks the engine for frames only while someone can see
// it. Every frame costs the Mac mini a capture and a JPEG encode (a screen capture: ~80–105 % CPU at full
// rate), the network, and this window a decode — none of it is of use to a panel in a hidden dock tab, behind
// another view, or in a minimized / hidden / fully covered window.
import { useEffect, useState, type RefObject } from "react";

const pageShown = (): boolean => typeof document === "undefined" || document.visibilityState !== "hidden";

/**
 * Whether the element is on screen: in the viewport (IntersectionObserver; a `display: none` view or a detached
 * dock tab is not) and the window is shown (`document.visibilityState`, which Electron also turns hidden for an
 * occluded window, and the main process's word that the window is shown and not minimized — see window-ipc.ts).
 * Becoming visible counts at once; becoming invisible only after `hideGraceMs`, so a quick tab flip does not stop
 * and restart a stream. `active` false = nothing is observed (no element yet).
 */
export function useStreamVisible(ref: RefObject<Element | null>, active: boolean, hideGraceMs: number): boolean {
  const [visible, setVisible] = useState(pageShown);

  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    /** Unknown until the observer's first report: assume in view (the window decides meanwhile). */
    let inView = true;
    /** The main process's last word (absent bridge: the page's own state decides alone). */
    let windowShown = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = (): void => {
      clearTimeout(timer);
      timer = undefined;
      if (inView && windowShown && pageShown()) setVisible(true);
      else timer = setTimeout(() => setVisible(false), hideGraceMs);
    };
    const observer =
      el && typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver((entries) => {
            const entry = entries[entries.length - 1];
            if (!entry) return;
            inView = entry.isIntersecting;
            update();
          })
        : null;
    if (observer && el) observer.observe(el);
    document.addEventListener("visibilitychange", update);
    const offWindow = typeof window === "undefined" ? undefined : window.kokpit?.window?.onShownChanged((shown) => {
      windowShown = shown;
      update();
    });
    // Mounted in a hidden window: invisible from the start, not after a grace with a stream running.
    if (!pageShown()) setVisible(false);
    return () => {
      clearTimeout(timer);
      offWindow?.();
      observer?.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, [ref, active, hideGraceMs]);

  return visible;
}
