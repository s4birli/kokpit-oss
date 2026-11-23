// Request handlers for Yapılacaklar (todos.*, notes.*). Every change is broadcast to all clients
// (todos.changed / notes.changed) after the reply, so other windows reload the day they show.
import type { ParamsOf, ResultOf, ServerMessage } from "@kokpit/shared";
import { engineError, type TodoService } from "../contracts.ts";

type TodoMethod = "todos.list" | "todos.create" | "todos.update" | "todos.delete" | "notes.get" | "notes.set";

/** The part of the server's per-request context these handlers use. */
interface Ctx {
  after(fn: () => void): void;
}

type Handlers = { [M in TodoMethod]: (ctx: Ctx, params: ParamsOf<M>) => ResultOf<M> };

export interface TodoHandlerDeps {
  /** Absent in servers built without todos (unit-test fakes): requests then fail with INTERNAL. */
  todos: TodoService | undefined;
  broadcast(msg: ServerMessage): void;
}

export function todoHandlers(deps: TodoHandlerDeps): Handlers {
  const svc = (): TodoService => {
    if (!deps.todos) throw engineError("INTERNAL", "engine.handlers.todos.unavailable");
    return deps.todos;
  };
  const todosChanged = (ctx: Ctx) => ctx.after(() => deps.broadcast({ type: "event", name: "todos.changed" }));

  return {
    "todos.list": (ctx, p) => {
      if (svc().rollover()) todosChanged(ctx);
      return svc().list(p.date);
    },
    "todos.create": (ctx, p) => {
      const todo = svc().create(p);
      todosChanged(ctx);
      return { todo };
    },
    "todos.update": (ctx, p) => {
      const todo = svc().update(p);
      todosChanged(ctx);
      return { todo };
    },
    "todos.delete": (ctx, p) => {
      svc().delete(p.id);
      todosChanged(ctx);
      return {};
    },
    "notes.get": (_ctx, p) => svc().getNote(p.date),
    "notes.set": (ctx, p) => {
      const note = svc().setNote(p);
      ctx.after(() => deps.broadcast({ type: "event", name: "notes.changed", date: note.date }));
      return note;
    },
  };
}
