import type { EngineClient } from "../../engine/types.ts";

/**
 * Runs `run` now and once per (re)connection afterwards: on onReconnected, or
 * on the first transition to "open" if we were mounted while not yet connected.
 * Each connection triggers at most one run, whichever order the client fires
 * onState("open") and onReconnected in. `run` handles its own errors; any
 * rejection is swallowed here. Returns a cleanup function.
 */
export function whenConnected(client: EngineClient, run: () => Promise<unknown>): () => void {
  let active = true;
  /** True once a run has been started while the current connection was open. */
  let served = false;

  const start = (): void => {
    if (!active) return;
    served = client.state === "open";
    run().catch(() => {});
  };

  const offState = client.onState((state) => {
    if (state !== "open") served = false;
    else if (!served) start();
  });
  const offReconnected = client.onReconnected(() => {
    if (!served) start();
  });

  start();

  return () => {
    active = false;
    offState();
    offReconnected();
  };
}
