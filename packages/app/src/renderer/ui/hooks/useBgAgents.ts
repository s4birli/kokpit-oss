// İş A (Adım 7) — background Claude sessions: loaded with `bgAgents.list`, reloaded on `bgAgents.changed`
// and on every (re)connection.
import type { BgAgentSession } from "@kokpit/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EngineClient } from "../../engine/types.ts";
import { errorMessage, isDisconnected } from "../errors.ts";
import { whenConnected } from "./when-connected.ts";
import { t } from "../../../i18n/index.ts";

export interface BgAgentsState {
  sessions: BgAgentSession[];
  /** The engine could not read the list (claude missing, timeout…) or the request failed. */
  error: string | null;
}

const EMPTY: BgAgentSession[] = [];

export function useBgAgents(client: EngineClient): BgAgentsState {
  const [state, setState] = useState<BgAgentsState>({ sessions: EMPTY, error: null });
  const seq = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const my = ++seq.current;
    try {
      const { sessions, error } = await client.request("bgAgents.list", {});
      if (my !== seq.current) return;
      setState({ sessions, error: error ?? null });
    } catch (err) {
      if (my !== seq.current || isDisconnected(err)) return;
      setState((prev) => ({ sessions: prev.sessions, error: t("workbench.load.bgAgents", { error: errorMessage(err) }) }));
    }
  }, [client]);

  useEffect(() => {
    let active = true;
    const offConnected = whenConnected(client, () => (active ? load() : Promise.resolve()));
    const offEvent = client.onEvent((event) => {
      if (active && event.name === "bgAgents.changed") void load();
    });
    return () => {
      active = false;
      seq.current++;
      offConnected();
      offEvent();
    };
  }, [client, load]);

  return state;
}
