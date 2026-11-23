// TodoService: per-day lists in the engine's time zone, rollover, ordering, notes, validation,
// plus a monkey test of random operations against a simple model.
import { describe, expect, it } from "vitest";
import { TODOS_PER_DAY_MAX, type Todo } from "@kokpit/shared";
import { EngineError } from "./contracts.ts";
import { createMemoryStore } from "./store.ts";
import { clockFromEnv, createTodoService, dateKeyIn } from "./todos.ts";

const TZ = "Europe/Istanbul";

function setup(start: string, opts: { timeZone?: string; projects?: string[] } = {}) {
  let now = new Date(start);
  const store = createMemoryStore();
  let n = 0;
  const projects = new Set(opts.projects ?? ["p1", "p2"]);
  const svc = createTodoService({
    store,
    now: () => now,
    timeZone: opts.timeZone ?? TZ,
    newId: () => `t${++n}`,
    projectExists: (id) => projects.has(id),
  });
  return {
    svc,
    store,
    setNow: (iso: string) => {
      now = new Date(iso);
    },
  };
}

const texts = (todos: Todo[]) => todos.map((t) => t.text);

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(EngineError);
    expect((e as EngineError).code).toBe(code);
    return;
  }
  throw new Error(`expected EngineError ${code}`);
}

describe("dateKeyIn", () => {
  it("formats the local calendar day of the given zone", () => {
    // 21:30 UTC is already the next day in Istanbul (UTC+3) but not in New York.
    const d = new Date("2026-11-16T21:30:00Z");
    expect(dateKeyIn(d, "Europe/Istanbul")).toBe("2026-11-17");
    expect(dateKeyIn(d, "America/New_York")).toBe("2026-11-16");
    expect(dateKeyIn(d, "UTC")).toBe("2026-11-16");
  });

  it("handles DST transitions (New York spring forward / fall back)", () => {
    expect(dateKeyIn(new Date("2026-03-08T06:59:00Z"), "America/New_York")).toBe("2026-03-08"); // 01:59 EST
    expect(dateKeyIn(new Date("2026-03-08T07:00:00Z"), "America/New_York")).toBe("2026-03-08"); // 03:00 EDT
    expect(dateKeyIn(new Date("2026-03-09T03:59:00Z"), "America/New_York")).toBe("2026-03-08"); // 23:59 EDT
    expect(dateKeyIn(new Date("2026-03-09T04:00:00Z"), "America/New_York")).toBe("2026-03-09"); // 00:00 EDT
    expect(dateKeyIn(new Date("2026-11-01T05:30:00Z"), "America/New_York")).toBe("2026-11-01"); // 01:30 EDT
    expect(dateKeyIn(new Date("2026-11-01T06:30:00Z"), "America/New_York")).toBe("2026-11-01"); // 01:30 EST
    expect(dateKeyIn(new Date("2026-11-02T04:59:00Z"), "America/New_York")).toBe("2026-11-01"); // 23:59 EST
    expect(dateKeyIn(new Date("2026-11-02T05:00:00Z"), "America/New_York")).toBe("2026-11-02");
  });

  it("uses the machine's zone when none is given", () => {
    const d = new Date("2026-06-01T12:00:00Z");
    const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    expect(dateKeyIn(d)).toBe(local);
  });
});

describe("clockFromEnv", () => {
  it("is the real clock unless KOKPIT_TEST_NOW is set", () => {
    const real = clockFromEnv({});
    expect(Math.abs(real().getTime() - Date.now())).toBeLessThan(1000);
    expect(clockFromEnv({ KOKPIT_TEST_NOW: "2026-11-16T08:00:00Z" })().toISOString()).toBe("2026-11-16T08:00:00.000Z");
  });

  it("refuses an unparseable fake time", () => {
    expect(() => clockFromEnv({ KOKPIT_TEST_NOW: "dün" })).toThrow(/KOKPIT_TEST_NOW/);
  });
});

describe("TodoService", () => {
  it("creates todos on today's list in order", () => {
    const { svc } = setup("2026-11-16T08:00:00Z");
    expect(svc.today()).toBe("2026-11-16");
    const a = svc.create({ text: "  Süt al  " });
    svc.create({ text: "Fatura öde", projectId: "p1" });
    expect(a).toMatchObject({ text: "Süt al", done: false, date: "2026-11-16", order: 0, createdAt: "2026-11-16T08:00:00.000Z" });
    const { date, todos } = svc.list();
    expect(date).toBe("2026-11-16");
    expect(texts(todos)).toEqual(["Süt al", "Fatura öde"]);
    expect(todos[1]!.projectId).toBe("p1");
  });

  it("checks and unchecks, stamping doneAt", () => {
    const { svc, setNow } = setup("2026-11-16T08:00:00Z");
    const a = svc.create({ text: "a" });
    setNow("2026-11-16T09:00:00Z");
    expect(svc.update({ id: a.id, done: true })).toMatchObject({ done: true, doneAt: "2026-11-16T09:00:00.000Z" });
    const back = svc.update({ id: a.id, done: false });
    expect(back.done).toBe(false);
    expect(back.doneAt).toBeUndefined();
  });

  it("edits text and project tag; null clears the tag", () => {
    const { svc } = setup("2026-11-16T08:00:00Z");
    const a = svc.create({ text: "a", projectId: "p1" });
    expect(svc.update({ id: a.id, text: " b ", projectId: "p2" })).toMatchObject({ text: "b", projectId: "p2" });
    expect(svc.update({ id: a.id, projectId: null }).projectId).toBeUndefined();
  });

  it("reorders within a day (clamped) and keeps orders contiguous", () => {
    const { svc } = setup("2026-11-16T08:00:00Z");
    const [a, b, c] = ["a", "b", "c"].map((text) => svc.create({ text }));
    svc.update({ id: c!.id, order: 0 });
    expect(texts(svc.list().todos)).toEqual(["c", "a", "b"]);
    svc.update({ id: c!.id, order: 99 });
    expect(texts(svc.list().todos)).toEqual(["a", "b", "c"]);
    svc.update({ id: a!.id, order: 1 });
    expect(texts(svc.list().todos)).toEqual(["b", "a", "c"]);
    svc.delete(b!.id);
    expect(svc.list().todos.map((t) => t.order)).toEqual([0, 1]);
  });

  it("rolls unfinished todos over to today when today is listed; done ones stay", () => {
    const { svc, setNow } = setup("2026-11-16T08:00:00Z");
    const a = svc.create({ text: "bitmedi" });
    const b = svc.create({ text: "bitti" });
    svc.update({ id: b.id, done: true });
    svc.setNote({ text: "dünün notu" });
    setNow("2026-11-17T06:00:00Z");
    expect(svc.rollover()).toBe(true);
    expect(svc.rollover()).toBe(false);
    const today = svc.list();
    expect(today.date).toBe("2026-11-17");
    expect(today.todos).toEqual([expect.objectContaining({ id: a.id, date: "2026-11-17", rolledFrom: "2026-11-16", order: 0 })]);
    const yesterday = svc.list("2026-11-16");
    expect(yesterday.todos.map((t) => t.id)).toEqual([b.id]);
    expect(svc.getNote("2026-11-16").text).toBe("dünün notu");
    expect(svc.getNote().text).toBe("");
  });

  it("rolled todos come first, in their old day and order, and keep the day they were first planned for", () => {
    const { svc, setNow } = setup("2026-11-14T08:00:00Z");
    svc.create({ text: "14-a" });
    svc.create({ text: "16-x", date: "2026-11-16" });
    setNow("2026-11-15T08:00:00Z");
    svc.create({ text: "15-a" });
    expect(texts(svc.list().todos)).toEqual(["14-a", "15-a"]);
    setNow("2026-11-16T08:00:00Z");
    const { todos } = svc.list();
    expect(texts(todos)).toEqual(["14-a", "15-a", "16-x"]);
    expect(todos.map((t) => t.rolledFrom)).toEqual(["2026-11-14", "2026-11-15", undefined]);
  });

  it("rolls over by the engine's local day, also across DST", () => {
    const { svc, setNow } = setup("2026-03-08T04:30:00Z", { timeZone: "America/New_York" }); // 23:30 EST on 03-07
    expect(svc.today()).toBe("2026-03-07");
    svc.create({ text: "gece" });
    setNow("2026-03-08T07:30:00Z"); // 03:30 EDT on 03-08, an hour lost to DST
    expect(svc.list().todos).toEqual([expect.objectContaining({ text: "gece", date: "2026-03-08", rolledFrom: "2026-03-07" })]);
    setNow("2026-03-09T03:30:00Z"); // 23:30 EDT, still 03-08
    expect(svc.rollover()).toBe(false);
    setNow("2026-11-01T05:30:00Z"); // 01:30 EDT, fall back day
    expect(svc.list().date).toBe("2026-11-01");
    setNow("2026-11-01T06:30:00Z"); // 01:30 EST again, same day
    expect(svc.rollover()).toBe(false);
  });

  it("refuses bad input", () => {
    const { svc, store } = setup("2026-11-16T08:00:00Z");
    expectCode(() => svc.create({ text: "x", projectId: "yok" }), "NOT_FOUND");
    expectCode(() => svc.create({ text: "x", date: "2026-11-15" }), "INVALID");
    expectCode(() => svc.create({ text: "   " }), "INVALID");
    expectCode(() => svc.update({ id: "yok", done: true }), "NOT_FOUND");
    expectCode(() => svc.delete("yok"), "NOT_FOUND");
    const a = svc.create({ text: "a" });
    expectCode(() => svc.update({ id: a.id, projectId: "yok" }), "NOT_FOUND");
    expectCode(() => svc.update({ id: a.id, text: " " }), "INVALID");
    store.replaceTodos(
      Array.from({ length: TODOS_PER_DAY_MAX }, (_, i) => ({
        id: `x${i}`,
        text: "x",
        done: false,
        date: "2026-11-16",
        order: i,
        createdAt: "2026-11-16T08:00:00.000Z",
      })),
    );
    expectCode(() => svc.create({ text: "fazla" }), "INVALID");
  });

  it("keeps day notes; empty or blank text removes them", () => {
    const { svc } = setup("2026-11-16T08:00:00Z");
    expect(svc.getNote()).toEqual({ date: "2026-11-16", text: "" });
    expect(svc.setNote({ text: "bugün" })).toEqual({ date: "2026-11-16", text: "bugün" });
    svc.setNote({ date: "2026-11-20", text: "ileride" });
    expect(svc.getNote("2026-11-20").text).toBe("ileride");
    svc.setNote({ text: "  \n " });
    expect(svc.getNote().text).toBe("");
  });
});

// ---------- monkey: random operations against a model ----------

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

interface ModelTodo {
  id: string;
  text: string;
  done: boolean;
}

describe("TodoService monkey", () => {
  it.each([1, 2, 3, 4, 5])("matches a model under random operations (seed %i)", (seed) => {
    const rnd = rng(seed);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    let t = Date.parse("2026-03-06T12:00:00Z");
    const zone = "America/New_York"; // crosses the 2026-03-08 DST change
    const { svc, setNow } = setup(new Date(t).toISOString(), { timeZone: zone });
    /** date → ids in order */
    const days = new Map<string, ModelTodo[]>();
    const day = (d: string) => days.get(d) ?? (days.set(d, []), days.get(d)!);
    const today = () => dateKeyIn(new Date(t), zone);

    const modelRollover = () => {
      const now = today();
      const stale = [...days.keys()]
        .filter((d) => d < now)
        .sort()
        .flatMap((d) => {
          const keep = day(d).filter((x) => x.done);
          const move = day(d).filter((x) => !x.done);
          days.set(d, keep);
          return move;
        });
      if (stale.length > 0) days.set(now, [...stale, ...day(now)]);
    };
    const all = () => [...days.values()].flat();

    for (let step = 0; step < 400; step++) {
      const r = rnd();
      if (r < 0.1) {
        t += Math.floor(rnd() * 30 * 60 * 60 * 1000); // up to 30 hours
        setNow(new Date(t).toISOString());
        continue;
      }
      modelRollover();
      const items = all();
      if (r < 0.4 || items.length === 0) {
        const text = `iş ${step}`;
        const offset = rnd() < 0.2 ? 1 : 0;
        const date = offset ? dateKeyIn(new Date(t + 26 * 3600 * 1000), zone) : undefined;
        const todo = svc.create({ text, ...(date ? { date } : {}) });
        day(todo.date).push({ id: todo.id, text, done: false });
      } else if (r < 0.6) {
        const x = pick(items);
        x.done = !x.done;
        svc.update({ id: x.id, done: x.done });
      } else if (r < 0.75) {
        const x = pick(items);
        const d = [...days.entries()].find(([, xs]) => xs.includes(x))![0];
        const list = day(d);
        const to = Math.floor(rnd() * (list.length + 2));
        list.splice(list.indexOf(x), 1);
        list.splice(Math.min(to, list.length), 0, x);
        svc.update({ id: x.id, order: to });
      } else if (r < 0.85) {
        const x = pick(items);
        x.text = `düzeltildi ${step}`;
        svc.update({ id: x.id, text: x.text });
      } else {
        const x = pick(items);
        for (const [d, xs] of days) days.set(d, xs.filter((y) => y !== x));
        svc.delete(x.id);
      }

      // invariants after every operation
      const check = pick([...days.keys(), today()]);
      const listed = svc.list(check);
      modelRollover();
      expect(listed.todos.map((x) => [x.id, x.text, x.done])).toEqual(day(check).map((x) => [x.id, x.text, x.done]));
      expect(listed.todos.map((x) => x.order)).toEqual(listed.todos.map((_, i) => i));
      const now = today();
      for (const d of days.keys()) {
        if (d < now) expect(svc.list(d).todos.every((x) => x.done)).toBe(true);
      }
    }
  });
});
