import type { TerminalInfo } from "@kokpit/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { EngineClient, EngineEvent } from "../../engine/types.ts";
import { errorMessage, isDisconnected } from "../errors.ts";
import { whenConnected } from "./when-connected.ts";
import { t } from "../../../i18n/index.ts";

/** Whose terminals: one card's, or a project's cardless ones. */
export type TerminalScope = { cardId: string } | { projectId: string };

export interface TerminalsState {
  terminals: TerminalInfo[];
  error: string | null;
  /** Adds a terminal the engine just opened (ignored unless it belongs to the current scope). */
  add(terminal: TerminalInfo): void;
  remove(terminalId: string): void;
  /** True once the current scope's list came from the engine (an empty list then really means "none"). */
  loaded: boolean;
}

interface Loaded {
  key: string | null;
  terminals: TerminalInfo[];
  error: string | null;
  /** A list for this key arrived (later errors keep it). */
  ok: boolean;
}

const EMPTY: TerminalInfo[] = [];

export function scopeKey(scope: TerminalScope | null): string | null {
  if (scope === null) return null;
  return "cardId" in scope ? `card:${scope.cardId}` : `project:${scope.projectId}`;
}

function belongs(scope: TerminalScope, t: TerminalInfo): boolean {
  return "cardId" in scope ? t.cardId === scope.cardId : t.projectId === scope.projectId && t.cardId === undefined;
}

function affects(scope: TerminalScope, e: Extract<EngineEvent, { name: "terminals.changed" }>): boolean {
  return "cardId" in scope ? e.cardId === scope.cardId : e.projectId === scope.projectId && e.cardId === undefined;
}

function parseKey(key: string): TerminalScope {
  const i = key.indexOf(":");
  const id = key.slice(i + 1);
  return key.slice(0, i) === "card" ? { cardId: id } : { projectId: id };
}

/**
 * Terminals of one scope. State is tagged with the scope it belongs to, so a
 * switch never renders (and so never attaches) the previous scope's terminals.
 */
export function useTerminals(client: EngineClient, scope: TerminalScope | null): TerminalsState {
  const key = scopeKey(scope);
  const [loaded, setLoaded] = useState<Loaded>({ key: null, terminals: EMPTY, error: null, ok: false });

  useEffect(() => {
    if (key === null) return;
    const s = parseKey(key);
    let active = true;
    let seq = 0;
    const load = async (): Promise<void> => {
      const my = ++seq;
      try {
        const { terminals } = await client.request("terminals.list", s);
        if (!active || my !== seq) return;
        setLoaded({ key, terminals: terminals.filter((t) => belongs(s, t)), error: null, ok: true });
      } catch (err) {
        if (!active || my !== seq || isDisconnected(err)) return;
        setLoaded((prev) => ({
          key,
          terminals: prev.key === key ? prev.terminals : EMPTY,
          error: t("workbench.load.terminals", { error: errorMessage(err) }),
          ok: prev.key === key && prev.ok,
        }));
      }
    };
    const offConnected = whenConnected(client, load);
    const offEvent = client.onEvent((event) => {
      if (event.name === "terminals.changed" && affects(s, event)) void load();
    });
    return () => {
      active = false;
      offConnected();
      offEvent();
    };
  }, [client, key]);

  const add = useCallback((terminal: TerminalInfo) => {
    setLoaded((prev) => {
      // Only into the list it belongs to (the user may have switched meanwhile).
      // If that list hasn't loaded yet, the pending load / terminals.changed brings it.
      if (prev.key === null || !belongs(parseKey(prev.key), terminal)) return prev;
      if (prev.terminals.some((t) => t.id === terminal.id)) return prev;
      return { ...prev, terminals: [...prev.terminals, terminal] };
    });
  }, []);

  const remove = useCallback((terminalId: string) => {
    setLoaded((prev) => ({ ...prev, terminals: prev.terminals.filter((t) => t.id !== terminalId) }));
  }, []);

  const current = key !== null && loaded.key === key;
  const terminals = current ? loaded.terminals : EMPTY;
  const error = current ? loaded.error : null;
  const isLoaded = current && loaded.ok;
  // Stable while nothing changed, so panels that receive it don't re-render on every workbench render.
  return useMemo(() => ({ terminals, error, add, remove, loaded: isLoaded }), [terminals, error, add, remove, isLoaded]);
}
