import { useCallback, useEffect, useRef, useState } from "react";
import type { EngineClient, EngineEvent } from "../../engine/types.ts";
import { errorMessage, isDisconnected } from "../errors.ts";
import { whenConnected } from "./when-connected.ts";

export interface EngineResource<T> {
  /** Undefined until the first successful load. */
  data: T | undefined;
  /** Engine message of the last failed load (cleared by the next success). */
  error: string | null;
  reload(): Promise<void>;
}

/**
 * Data fetched from the engine: loaded on (re)connect and whenever one of `events` arrives.
 * Stale responses (an older request finishing after a newer one) are dropped.
 */
export function useEngineResource<T>(
  client: EngineClient,
  fetch: (client: EngineClient) => Promise<T>,
  events: readonly EngineEvent["name"][],
): EngineResource<T> {
  const [state, setState] = useState<{ data: T | undefined; error: string | null }>({ data: undefined, error: null });
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const seq = useRef(0);
  const alive = useRef(true);

  const reload = useCallback(async (): Promise<void> => {
    const my = ++seq.current;
    try {
      const data = await fetchRef.current(client);
      if (!alive.current || my !== seq.current) return;
      setState({ data, error: null });
    } catch (err) {
      if (!alive.current || my !== seq.current || isDisconnected(err)) return;
      setState((prev) => ({ data: prev.data, error: errorMessage(err) }));
    }
  }, [client]);

  useEffect(() => {
    alive.current = true;
    const offConnected = whenConnected(client, reload);
    const offEvent = client.onEvent((event) => {
      if (eventsRef.current.includes(event.name)) void reload();
    });
    return () => {
      alive.current = false;
      offConnected();
      offEvent();
    };
  }, [client, reload]);

  return { data: state.data, error: state.error, reload };
}

// Shared fetchers (module-level so they are stable).
export const fetchTools = async (c: EngineClient) => (await c.request("tools.list", {})).tools;
export const fetchHosts = async (c: EngineClient) => (await c.request("sshHosts.list", {})).hosts;
export const fetchKeys = async (c: EngineClient) => (await c.request("sshKeys.list", {})).keys;
export const fetchToolStatuses = async (c: EngineClient) => (await c.request("tools.check", {})).statuses;
export const fetchSettings = async (c: EngineClient) => (await c.request("settings.get", {})).settings;
export const TOOLS_EVENTS = ["tools.changed"] as const;
export const SETTINGS_EVENTS = ["settings.changed"] as const;
export const HOSTS_EVENTS = ["sshHosts.changed"] as const;
