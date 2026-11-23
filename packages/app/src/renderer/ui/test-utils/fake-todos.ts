// In-memory todos.* / notes.* for FakeEngineClient (no rollover: tests seed rolled todos directly).
import type { ParamsOf, ResultOf, Todo } from "@kokpit/shared";
import { EngineRequestError } from "../../engine/types.ts";

export const FAKE_TODAY = "2026-11-16";

type TodoMethod = "todos.list" | "todos.create" | "todos.update" | "todos.delete" | "notes.get" | "notes.set";
type Handlers = { [M in TodoMethod]: (params: ParamsOf<M>) => ResultOf<M> };

let counter = 0;

export class FakeTodos {
  today = FAKE_TODAY;
  todos: Todo[] = [];
  notes: Record<string, string> = {};

  seed(todos: Todo[] = [], notes: Record<string, string> = {}): void {
    this.todos = todos.map((t) => ({ ...t }));
    this.notes = { ...notes };
  }

  private day(date: string): Todo[] {
    return this.todos.filter((t) => t.date === date).sort((a, b) => a.order - b.order);
  }

  private find(id: string): Todo {
    const t = this.todos.find((x) => x.id === id);
    if (!t) throw new EngineRequestError("NOT_FOUND", "yapılacak bulunamadı");
    return t;
  }

  readonly handlers: Handlers = {
    "todos.list": ({ date }) => {
      const d = date ?? this.today;
      return { date: d, todos: this.day(d).map((t) => ({ ...t })) };
    },
    "todos.create": ({ text, projectId, date }) => {
      const d = date ?? this.today;
      const todo: Todo = {
        id: `todo-${++counter}`,
        text: text.trim(),
        done: false,
        date: d,
        order: this.day(d).length,
        createdAt: new Date(0).toISOString(),
        ...(projectId === undefined ? {} : { projectId }),
      };
      this.todos.push(todo);
      return { todo: { ...todo } };
    },
    "todos.update": ({ id, text, done, projectId, order }) => {
      const t = this.find(id);
      if (text !== undefined) t.text = text.trim();
      if (done !== undefined) t.done = done;
      if (projectId === null) delete t.projectId;
      else if (projectId !== undefined) t.projectId = projectId;
      if (order !== undefined) {
        const rest = this.day(t.date).filter((x) => x !== t);
        rest.splice(Math.min(order, rest.length), 0, t);
        rest.forEach((x, i) => (x.order = i));
      }
      return { todo: { ...t } };
    },
    "todos.delete": ({ id }) => {
      const t = this.find(id);
      this.todos = this.todos.filter((x) => x !== t);
      this.day(t.date).forEach((x, i) => (x.order = i));
      return {};
    },
    "notes.get": ({ date }) => {
      const d = date ?? this.today;
      return { date: d, text: this.notes[d] ?? "" };
    },
    "notes.set": ({ date, text }) => {
      const d = date ?? this.today;
      this.notes[d] = text;
      return { date: d, text };
    },
  };
}

export function makeTodo(id: string, text: string, extra: Partial<Todo> = {}): Todo {
  return { id, text, done: false, date: FAKE_TODAY, order: 0, createdAt: new Date(0).toISOString(), ...extra };
}
