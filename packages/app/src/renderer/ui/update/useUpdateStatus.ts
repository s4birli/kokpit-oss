// Kendini güncelleme: the updater's state as the page sees it (main owns the updater; see engine/update-ipc.ts).
import { useEffect, useState } from "react";
import type { UpdateBridge, UpdateStatus } from "../../engine/update-ipc.ts";

/** The preload's `window.kokpit.update`; absent outside Electron (unit tests, a bridge from before self-update). */
export function defaultUpdateBridge(): UpdateBridge | undefined {
  return typeof window === "undefined" ? undefined : window.kokpit?.update;
}

/** Null until the first status arrived (and for good without a bridge). */
export function useUpdateStatus(bridge: UpdateBridge | undefined = defaultUpdateBridge()): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    const off = bridge.onStatus((s) => {
      if (!cancelled) setStatus(s);
    });
    bridge.status().then(
      (s) => {
        if (!cancelled) setStatus((current) => current ?? s);
      },
      () => {},
    );
    return () => {
      cancelled = true;
      off();
    };
  }, [bridge]);
  return status;
}
