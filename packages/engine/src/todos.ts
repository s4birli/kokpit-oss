// TodoService (Yapılacaklar, Adım 6): one list and one note per day. "Today" is the calendar day
// of the engine machine (or the injected zone), from an injected clock. Unfinished todos of earlier
// days roll over to today the first time anything touches the todos on a new day; done ones stay.
import { randomUUID } from "node:crypto";
import { TODO_TEXT_MAX, TODOS_PER_DAY_MAX, type ParamsOf, type Todo } from "@kokpit/shared";
import { engineError, type TodoService, type TodoStore } from "./contracts.ts";

/** Env var that pins the engine's clock to an ISO instant. For end-to-end tests only. */
export const TEST_NOW_ENV = "KOKPIT_TEST_NOW";

export interface TodoServiceDeps {
  store: TodoStore;
  now: () => Date;
  /** IANA zone for "today"; undefined = the machine's local zone. */
  timeZone?: string;
  newId?: () => string;
  projectExists: (projectId: string) => boolean;
}

/** YYYY-MM-DD of `d` in `timeZone` (default: the machine's zone). */
export function dateKeyIn(d: Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The real clock, or a fixed one when `KOKPIT_TEST_NOW` holds an ISO instant. */
export function clockFromEnv(env: NodeJS.ProcessEnv): () => Date {
  const fixed = env[TEST_NOW_ENV];
  if (fixed === undefined || fixed === "") return () => new Date();
  const ms = Date.parse(fixed);
  if (Number.isNaN(ms)) throw new Error(`${TEST_NOW_ENV} must be an ISO date-time, got ${JSON.stringify(fixed)}`);
  return () => new Date(ms);
}

const byOrder = (a: Todo, b: Todo) => a.order - b.order || a.createdAt.localeCompare(b.createdAt);

/** Every day's todos renumbered 0..n-1 in their current order. */
function renumber(todos: Todo[]): Todo[] {
  const days = new Map<string, Todo[]>();
  for (const t of todos) {
    const list = days.get(t.date) ?? [];
    list.push(t);
    days.set(t.date, list);
  }
  return [...days.values()].flatMap((list) => list.sort(byOrder).map((t, i) => (t.order === i ? t : { ...t, order: i })));
}

function cleanText(text: string): string {
  const t = text.trim();
  if (t.length === 0) throw engineError("INVALID", "engine.todos.emptyText");
  if (t.length > TODO_TEXT_MAX) throw engineError("INVALID", "engine.todos.textTooLong", { max: TODO_TEXT_MAX });
  return t;
}

export function createTodoService(deps: TodoServiceDeps): TodoService {
  const { store, now } = deps;
  const newId = deps.newId ?? randomUUID;

  const today = () => dateKeyIn(now(), deps.timeZone);

  function requireProject(projectId: string): void {
    if (!deps.projectExists(projectId)) throw engineError("NOT_FOUND", "engine.todos.projectNotFound");
  }

  function requireTodo(todos: Todo[], id: string): Todo {
    const t = todos.find((x) => x.id === id);
    if (!t) throw engineError("NOT_FOUND", "engine.todos.notFound");
    return t;
  }

  function rollover(): boolean {
    const day = today();
    const all = store.listTodos();
    const stale = all.filter((t) => t.date < day && !t.done);
    if (stale.length === 0) return false;
    const staleIds = new Set(stale.map((t) => t.id));
    stale.sort((a, b) => a.date.localeCompare(b.date) || byOrder(a, b));
    const rolled = stale.map((t, i): Todo => ({ ...t, date: day, order: i, rolledFrom: t.rolledFrom ?? t.date }));
    const rest = all
      .filter((t) => !staleIds.has(t.id))
      .map((t) => (t.date === day ? { ...t, order: t.order + rolled.length } : t));
    store.replaceTodos(renumber([...rolled, ...rest]));
    return true;
  }

  function dayList(date: string): Todo[] {
    return store
      .listTodos()
      .filter((t) => t.date === date)
      .sort(byOrder);
  }

  return {
    today,
    rollover,

    list(date) {
      rollover();
      const day = date ?? today();
      return { date: day, todos: dayList(day) };
    },

    create(input) {
      rollover();
      const day = input.date ?? today();
      if (day < today()) throw engineError("INVALID", "engine.todos.pastDay");
      if (input.projectId !== undefined) requireProject(input.projectId);
      const text = cleanText(input.text);
      const existing = dayList(day);
      if (existing.length >= TODOS_PER_DAY_MAX) {
        throw engineError("INVALID", "engine.todos.dayFull", { max: TODOS_PER_DAY_MAX });
      }
      const todo: Todo = {
        id: newId(),
        text,
        done: false,
        date: day,
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
        order: existing.length,
        createdAt: now().toISOString(),
      };
      store.replaceTodos([...store.listTodos(), todo]);
      return todo;
    },

    update(input: ParamsOf<"todos.update">) {
      rollover();
      const all = store.listTodos();
      const cur = requireTodo(all, input.id);
      let next: Todo = { ...cur };
      if (input.text !== undefined) next.text = cleanText(input.text);
      if (input.projectId !== undefined) {
        if (input.projectId === null) delete next.projectId;
        else {
          requireProject(input.projectId);
          next.projectId = input.projectId;
        }
      }
      if (input.done !== undefined && input.done !== cur.done) {
        if (input.done) next = { ...next, done: true, doneAt: now().toISOString() };
        else {
          next.done = false;
          delete next.doneAt;
        }
      }
      let others = all.filter((t) => t.id !== cur.id);
      if (input.order !== undefined) {
        const day = others.filter((t) => t.date === cur.date).sort(byOrder);
        const at = Math.min(input.order, day.length);
        const placed = [...day.slice(0, at), next, ...day.slice(at)].map((t, i) => ({ ...t, order: i }));
        others = others.filter((t) => t.date !== cur.date);
        store.replaceTodos(renumber([...others, ...placed]));
      } else {
        store.replaceTodos(renumber([...others, next]));
      }
      return requireTodo(store.listTodos(), cur.id);
    },

    delete(id) {
      rollover();
      const all = store.listTodos();
      requireTodo(all, id);
      store.replaceTodos(renumber(all.filter((t) => t.id !== id)));
    },

    getNote(date) {
      const day = date ?? today();
      return { date: day, text: store.getNotes()[day] ?? "" };
    },

    setNote(input) {
      const day = input.date ?? today();
      const text = input.text.trim() === "" ? "" : input.text;
      store.setNote(day, text);
      return { date: day, text };
    },
  };
}
