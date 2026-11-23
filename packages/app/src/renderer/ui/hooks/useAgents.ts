// İş A — every terminal with its activity: loaded with `agents.summary`, kept live by `terminal.activity`.
import type { TerminalInfo } from "@kokpit/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EngineClient, EngineEvent } from "../../engine/types.ts";
import { errorMessage, isDisconnected } from "../errors.ts";
import { whenConnected } from "./when-connected.ts";
import { t } from "../../../i18n/index.ts";

export interface AgentsState {
  /** All terminals, in project order. */
  terminals: TerminalInfo[];
  error: string | null;
}

/** Events after which the terminal set may differ. */
const RELOAD_EVENTS: ReadonlySet<EngineEvent["name"]> = new Set(["terminals.changed", "projects.changed", "cards.changed"]);
const EMPTY: TerminalInfo[] = [];

export function useAgents(client: EngineClient): AgentsState {
  const [state, setState] = useState<AgentsState>({ terminals: EMPTY, error: null });
  const seq = useRef(0);
  /** Latest terminals, readable from event handlers. */
  const current = useRef<TerminalInfo[]>(EMPTY);
  current.current = state.terminals;

  const load = useCallback(async (): Promise<void> => {
    const my = ++seq.current;
    try {
      const { projects } = await client.request("agents.summary", {});
      if (my !== seq.current) return;
      const terminals = projects.flatMap((p) => p.terminals);
      current.current = terminals;
      setState({ terminals, error: null });
    } catch (err) {
      if (my !== seq.current || isDisconnected(err)) return;
      setState((prev) => ({ terminals: prev.terminals, error: t("workbench.load.agents", { error: errorMessage(err) }) }));
    }
  }, [client]);

  useEffect(() => {
    let active = true;
    const offConnected = whenConnected(client, () => (active ? load() : Promise.resolve()));
    const offEvent = client.onEvent((event) => {
      if (!active) return;
      if (RELOAD_EVENTS.has(event.name)) {
        void load();
        return;
      }
      if (event.name !== "terminal.activity") return;
      // A terminal not seen yet (opened by another client before its terminals.changed arrived): reload.
      if (!current.current.some((t) => t.id === event.terminalId)) {
        void load();
        return;
      }
      setState((prev) => ({
        ...prev,
        terminals: prev.terminals.map((t) => (t.id === event.terminalId ? { ...t, activity: event.activity } : t)),
      }));
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
