import type { ParamsOf, Todo } from "@kokpit/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EngineClient } from "../../engine/types.ts";
import { errorMessage, isDisconnected } from "../errors.ts";
import { whenConnected } from "../hooks/when-connected.ts";

export interface TodosState {
  /** The day shown (undefined until the first load). */
  date: string | undefined;
  /** The engine's today, learned from the last list of today. */
  today: string | undefined;
  todos: Todo[];
  error: string | null;
  create(text: string, projectId: string | undefined): Promise<void>;
  update(patch: ParamsOf<"todos.update">): Promise<void>;
  /** Moves a todo to a new 0-based position within the shown day (applied locally at once). */
  move(id: string, to: number): Promise<void>;
  remove(id: string): Promise<void>;
}

/** The visible part of an update (order is handled by `move`). */
function applyLocal(todo: Todo, patch: ParamsOf<"todos.update">): Todo {
  const next: Todo = { ...todo };
  if (patch.text !== undefined) next.text = patch.text;
  if (patch.done !== undefined) next.done = patch.done;
  if (patch.projectId === null) delete next.projectId;
  else if (patch.projectId !== undefined) next.projectId = patch.projectId;
  return next;
}

/**
 * One day's todos. `viewDate` null = the engine's today (so a day change on the engine is followed).
 * Reloads on (re)connect, on `todos.changed` and after every own change; stale responses are dropped.
 */
export function useTodos(client: EngineClient, viewDate: string | null): TodosState {
  const [day, setDay] = useState<{ date: string | undefined; todos: Todo[] }>({ date: undefined, todos: [] });
  const [today, setToday] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const alive = useRef(true);

  const reload = useCallback(async (): Promise<void> => {
    const my = ++seq.current;
    try {
      const res = await client.request("todos.list", viewDate === null ? {} : { date: viewDate });
      if (!alive.current || my !== seq.current) return;
      setDay({ date: res.date, todos: res.todos });
      if (viewDate === null) setToday(res.date);
    } catch (err) {
      if (!alive.current || my !== seq.current || isDisconnected(err)) return;
      setError(errorMessage(err));
    }
  }, [client, viewDate]);

  useEffect(() => {
    alive.current = true;
    const offConnected = whenConnected(client, reload);
    const offEvent = client.onEvent((event) => {
      if (event.name === "todos.changed") void reload();
    });
    return () => {
      alive.current = false;
      offConnected();
      offEvent();
    };
  }, [client, reload]);

  /** Runs one change; shows its error, then reloads either way. */
  const run = useCallback(
    async (fn: () => Promise<unknown>): Promise<void> => {
      try {
        await fn();
        if (alive.current) setError(null);
      } catch (err) {
        if (alive.current) setError(errorMessage(err));
      }
      await reload();
    },
    [reload],
  );

  const create = useCallback(
    (text: string, projectId: string | undefined) =>
      run(() =>
        client.request("todos.create", {
          text,
          ...(projectId === undefined ? {} : { projectId }),
          ...(viewDate === null ? {} : { date: viewDate }),
        }),
      ),
    [client, run, viewDate],
  );

  const update = useCallback(
    (patch: ParamsOf<"todos.update">) => {
      // Shown at once (a checkbox must flip on click); the reload afterwards brings the engine's truth.
      setDay((prev) => ({ ...prev, todos: prev.todos.map((t) => (t.id === patch.id ? applyLocal(t, patch) : t)) }));
      return run(() => client.request("todos.update", patch));
    },
    [client, run],
  );

  const move = useCallback(
    (id: string, to: number) => {
      setDay((prev) => {
        const from = prev.todos.findIndex((t) => t.id === id);
        if (from < 0) return prev;
        const todos = [...prev.todos];
        const [item] = todos.splice(from, 1);
        todos.splice(Math.min(to, todos.length), 0, item!);
        return { ...prev, todos };
      });
      return run(() => client.request("todos.update", { id, order: to }));
    },
    [client, run],
  );

  const remove = useCallback((id: string) => run(() => client.request("todos.delete", { id })), [client, run]);

  return { date: day.date, today, todos: day.todos, error, create, update, move, remove };
}
