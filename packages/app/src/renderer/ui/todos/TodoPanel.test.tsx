import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeEngineClient, makeProject } from "../test-utils/fake-client.ts";
import { FAKE_TODAY, makeTodo } from "../test-utils/fake-todos.ts";
import { TodoPanel } from "./TodoPanel.tsx";
import { shiftDate } from "./dates.ts";

const flush = () => act(async () => {});
const DEBOUNCE_MS = 300;

function seed(extra: ConstructorParameters<typeof FakeEngineClient>[0] = {}) {
  return new FakeEngineClient({ projects: [makeProject("p1", "Alfa"), makeProject("p2", "Beta")], ...extra });
}

async function setup(client = seed()) {
  render(<TodoPanel client={client} projects={client.projects} noteDebounceMs={DEBOUNCE_MS} />);
  await flush();
  return client;
}

const list = () => screen.getByRole("list", { name: "Yapılacaklar listesi" });
const items = () => within(list()).queryAllByRole("listitem");
const itemTexts = () => items().map((li) => li.getAttribute("data-text"));
const addBox = () => screen.getByLabelText("Yeni yapılacak") as HTMLInputElement;

async function add(text: string) {
  fireEvent.change(addBox(), { target: { value: text } });
  fireEvent.keyDown(addBox(), { key: "Enter" });
  await flush();
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("TodoPanel", () => {
  it("shows today's list with a heading and date", async () => {
    const client = await setup(seed({ todos: [makeTodo("a", "Süt al"), makeTodo("b", "Fatura", { order: 1 })] }));
    expect(screen.getByRole("heading", { name: "Yapılacaklar" })).toBeTruthy();
    expect(screen.getByTestId("todo-day").textContent).toMatch(/^Bugün/);
    expect(client.callsOf("todos.list")).toEqual([{}]);
    expect(itemTexts()).toEqual(["Süt al", "Fatura"]);
  });

  it("Kopyalama: a todo's text is its copy value (the row is draggable, so it cannot be drag-selected)", async () => {
    await setup(seed({ todos: [makeTodo("a", "Süt al"), makeTodo("b", "Fatura", { order: 1 })] }));
    const copies = Array.from(document.querySelectorAll(".kp-todo__item"), (li) => li.getAttribute("data-copy"));
    expect(copies).toEqual(["Süt al", "Fatura"]);
  });

  it("Enter in the add box adds a todo (trimmed) and clears the box; blank is ignored", async () => {
    const client = await setup();
    await add("   ");
    expect(client.callsOf("todos.create")).toEqual([]);
    await add("  Yeni iş  ");
    expect(client.callsOf("todos.create")).toEqual([{ text: "Yeni iş" }]);
    expect(addBox().value).toBe("");
    expect(itemTexts()).toEqual(["Yeni iş"]);
  });

  it("adds with a project tag chosen from the projects", async () => {
    const client = await setup();
    fireEvent.change(screen.getByLabelText("Yeni yapılacağın projesi"), { target: { value: "p2" } });
    await add("Etiketli");
    expect(client.callsOf("todos.create")).toEqual([{ text: "Etiketli", projectId: "p2" }]);
    expect(within(items()[0]!).getByText("Beta")).toBeTruthy();
  });

  it("checks and unchecks", async () => {
    const client = await setup(seed({ todos: [makeTodo("a", "Süt al")] }));
    const box = screen.getByRole("checkbox", { name: "Süt al" }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await flush();
    expect(client.callsOf("todos.update")).toEqual([{ id: "a", done: true }]);
    expect((screen.getByRole("checkbox", { name: "Süt al" }) as HTMLInputElement).checked).toBe(true);
  });

  it("flips the checkbox at once, before the engine answers", async () => {
    const client = await setup(seed({ todos: [makeTodo("a", "Süt al")] }));
    client.respond("todos.update", () => new Promise(() => {}));
    fireEvent.click(screen.getByRole("checkbox", { name: "Süt al" }));
    await flush();
    expect((screen.getByRole("checkbox", { name: "Süt al" }) as HTMLInputElement).checked).toBe(true);
  });

  it("edits inline: Enter saves, Escape cancels", async () => {
    const client = await setup(seed({ todos: [makeTodo("a", "Süt al")] }));
    fireEvent.click(screen.getByRole("button", { name: "Düzenle: Süt al" }));
    const input = screen.getByLabelText("Metni düzenle: Süt al");
    fireEvent.change(input, { target: { value: "Yoğurt al" } });
    fireEvent.keyDown(input, { key: "Escape" });
    await flush();
    expect(client.callsOf("todos.update")).toEqual([]);
    expect(itemTexts()).toEqual(["Süt al"]);

    fireEvent.click(screen.getByRole("button", { name: "Düzenle: Süt al" }));
    const again = screen.getByLabelText("Metni düzenle: Süt al");
    fireEvent.change(again, { target: { value: " Yoğurt al " } });
    fireEvent.keyDown(again, { key: "Enter" });
    await flush();
    expect(client.callsOf("todos.update")).toEqual([{ id: "a", text: "Yoğurt al" }]);
    expect(itemTexts()).toEqual(["Yoğurt al"]);
  });

  it("changes and clears the project tag while editing", async () => {
    const client = await setup(seed({ todos: [makeTodo("a", "İş", { projectId: "p1" })] }));
    expect(within(items()[0]!).getByText("Alfa")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Düzenle: İş" }));
    fireEvent.change(screen.getByLabelText("Proje: İş"), { target: { value: "" } });
    await flush();
    expect(client.callsOf("todos.update")).toEqual([{ id: "a", projectId: null }]);
  });

  it("deletes", async () => {
    const client = await setup(seed({ todos: [makeTodo("a", "Süt al")] }));
    fireEvent.click(screen.getByRole("button", { name: "Sil: Süt al" }));
    await flush();
    expect(client.callsOf("todos.delete")).toEqual([{ id: "a" }]);
    expect(items()).toHaveLength(0);
    expect(screen.getByText("Bu gün için yapılacak yok.")).toBeTruthy();
  });

  it("reorders with the up/down buttons (disabled at the ends) and with Alt+arrows", async () => {
    const client = await setup(
      seed({ todos: [makeTodo("a", "A"), makeTodo("b", "B", { order: 1 }), makeTodo("c", "C", { order: 2 })] }),
    );
    expect((screen.getByRole("button", { name: "Yukarı taşı: A" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Aşağı taşı: C" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Yukarı taşı: C" }));
    await flush();
    expect(client.callsOf("todos.update")).toEqual([{ id: "c", order: 1 }]);
    expect(itemTexts()).toEqual(["A", "C", "B"]);
    fireEvent.keyDown(items()[0]!, { key: "ArrowDown", altKey: true });
    await flush();
    expect(client.callsOf("todos.update").at(-1)).toEqual({ id: "a", order: 1 });
    expect(itemTexts()).toEqual(["C", "A", "B"]);
    // focus follows the moved item
    expect(document.activeElement?.getAttribute("data-text")).toBe("A");
  });

  it("reorders by drag and drop", async () => {
    const client = await setup(seed({ todos: [makeTodo("a", "A"), makeTodo("b", "B", { order: 1 })] }));
    const [a, b] = items();
    const data = new Map<string, string>();
    const dataTransfer = { setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? "", effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(b!, { dataTransfer });
    fireEvent.dragOver(a!, { dataTransfer });
    fireEvent.drop(a!, { dataTransfer });
    await flush();
    expect(client.callsOf("todos.update")).toEqual([{ id: "b", order: 0 }]);
    expect(itemTexts()).toEqual(["B", "A"]);
  });

  it("shows a 'dünden' badge on rolled-over todos", async () => {
    await setup(seed({ todos: [makeTodo("a", "Eski", { rolledFrom: shiftDate(FAKE_TODAY, -1) }), makeTodo("b", "Çok eski", { order: 1, rolledFrom: shiftDate(FAKE_TODAY, -5) })] }));
    expect(within(items()[0]!).getByText("dünden")).toBeTruthy();
    expect(within(items()[1]!).getByText("önceki günlerden")).toBeTruthy();
  });

  it("moves between days; past days are read-only for adding", async () => {
    const client = await setup(seed({ todos: [makeTodo("y", "Dünkü", { date: shiftDate(FAKE_TODAY, -1), done: true })] }));
    fireEvent.click(screen.getByRole("button", { name: "Önceki gün" }));
    await flush();
    expect(client.callsOf("todos.list").at(-1)).toEqual({ date: shiftDate(FAKE_TODAY, -1) });
    expect(screen.getByTestId("todo-day").textContent).toMatch(/^Dün/);
    expect(itemTexts()).toEqual(["Dünkü"]);
    expect(screen.queryByLabelText("Yeni yapılacak")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sonraki gün" }));
    fireEvent.click(screen.getByRole("button", { name: "Sonraki gün" }));
    await flush();
    expect(client.callsOf("todos.list").at(-1)).toEqual({ date: shiftDate(FAKE_TODAY, 1) });
    expect(screen.getByTestId("todo-day").textContent).toMatch(/^Yarın/);
    await add("Yarına");
    expect(client.callsOf("todos.create").at(-1)).toEqual({ text: "Yarına", date: shiftDate(FAKE_TODAY, 1) });
    fireEvent.click(screen.getByRole("button", { name: "Bugüne dön" }));
    await flush();
    expect(client.callsOf("todos.list").at(-1)).toEqual({});
  });

  it("reloads on todos.changed from another client", async () => {
    const client = await setup();
    client.todos.handlers["todos.create"]({ text: "Başka pencereden" });
    act(() => client.emitEvent({ type: "event", name: "todos.changed" }));
    await flush();
    expect(itemTexts()).toEqual(["Başka pencereden"]);
  });

  it("shows engine errors", async () => {
    const client = await setup();
    client.fail("todos.create", "INVALID", "metin en çok 500 karakter olmalı");
    await add("x");
    expect(screen.getByRole("alert").textContent).toContain("500");
  });
});

describe("TodoPanel note", () => {
  it("loads the day's note and saves edits after the debounce", async () => {
    vi.useFakeTimers();
    const client = await setup(seed({ notes: { [FAKE_TODAY]: "Eski not" } }));
    const note = screen.getByLabelText("Not") as HTMLTextAreaElement;
    expect(note.value).toBe("Eski not");
    fireEvent.change(note, { target: { value: "Yeni" } });
    fireEvent.change(note, { target: { value: "Yeni not" } });
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS - 1);
    });
    expect(client.callsOf("notes.set")).toEqual([]);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(client.callsOf("notes.set")).toEqual([{ date: FAKE_TODAY, text: "Yeni not" }]);
  });

  it("flushes a pending note when the day changes", async () => {
    vi.useFakeTimers();
    const client = await setup();
    fireEvent.change(screen.getByLabelText("Not"), { target: { value: "Bekleyen" } });
    fireEvent.click(screen.getByRole("button", { name: "Sonraki gün" }));
    await act(async () => {});
    expect(client.callsOf("notes.set")).toEqual([{ date: FAKE_TODAY, text: "Bekleyen" }]);
    expect(client.callsOf("notes.get").at(-1)).toEqual({ date: shiftDate(FAKE_TODAY, 1) });
  });

  it("takes notes.changed from another client unless the user is typing", async () => {
    vi.useFakeTimers();
    const client = await setup();
    client.todos.notes[FAKE_TODAY] = "Uzaktan";
    act(() => client.emitEvent({ type: "event", name: "notes.changed", date: FAKE_TODAY }));
    await act(async () => {});
    expect((screen.getByLabelText("Not") as HTMLTextAreaElement).value).toBe("Uzaktan");
    fireEvent.change(screen.getByLabelText("Not"), { target: { value: "Yerel" } });
    client.todos.notes[FAKE_TODAY] = "Yine uzaktan";
    act(() => client.emitEvent({ type: "event", name: "notes.changed", date: FAKE_TODAY }));
    await act(async () => {});
    expect((screen.getByLabelText("Not") as HTMLTextAreaElement).value).toBe("Yerel");
  });
});

describe("TodoPanel monkey", () => {
  it("survives random clicks and keys without throwing", async () => {
    let s = 7;
    const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const client = await setup(seed({ todos: [makeTodo("a", "A"), makeTodo("b", "B", { order: 1 })] }));
    for (let i = 0; i < 100; i++) {
      const buttons = screen.queryAllByRole("button") as HTMLButtonElement[];
      const r = rnd();
      if (r < 0.3 && screen.queryByLabelText("Yeni yapılacak")) await add(rnd() < 0.2 ? "" : `iş ${i} ${"ş".repeat(Math.floor(rnd() * 5))}`);
      else if (r < 0.5) {
        const boxes = screen.queryAllByRole("checkbox");
        if (boxes.length) fireEvent.click(boxes[Math.floor(rnd() * boxes.length)]!);
      } else if (r < 0.6) {
        const li = items();
        if (li.length) fireEvent.keyDown(li[Math.floor(rnd() * li.length)]!, { key: rnd() < 0.5 ? "ArrowUp" : "ArrowDown", altKey: true });
      } else {
        const b = buttons[Math.floor(rnd() * buttons.length)];
        if (b && !b.disabled) fireEvent.click(b);
      }
      await flush();
    }
    // the panel still matches the fake engine's state for the shown day
    const shownDate = list().getAttribute("data-date")!;
    const engineDay = client.todos.handlers["todos.list"]({ date: shownDate }).todos;
    expect(itemTexts()).toEqual(engineDay.map((t) => t.text));
    expect(items().map((li) => (within(li).getByRole("checkbox") as HTMLInputElement).checked)).toEqual(engineDay.map((t) => t.done));
  }, 30_000);
});
