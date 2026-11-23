// İş P — the project tab strip on its own.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultProjectTabsText, matchesKeys, ProjectTabs, type ProjectTabItem } from "./ProjectTabs.tsx";

afterEach(cleanup);

const items: ProjectTabItem[] = [
  { projectId: "a", title: "Alfa", count: { running: 2, waiting: 1 } },
  { projectId: "b", title: "Beta" },
  { projectId: "c", title: "Gama" },
];

function setup(active: string | null = "b") {
  const handlers = { onActivate: vi.fn(), onClose: vi.fn(), onMove: vi.fn() };
  render(<ProjectTabs items={items} active={active} {...handlers} />);
  return handlers;
}

const strip = () => screen.getByRole("toolbar", { name: defaultProjectTabsText.label });
const tabButton = (name: string) => within(strip()).getByRole("button", { name });
const tabOf = (id: string) => strip().querySelector<HTMLElement>(`[data-project-id="${id}"]`)!;

describe("ProjectTabs", () => {
  it("one tab per open project, in order; the active one is current; counters reuse the rail's", () => {
    setup();
    const names = Array.from(strip().querySelectorAll(".kp-ptab__main"), (b) => b.textContent);
    expect(names).toEqual(["Alfa", "Beta", "Gama"]);
    expect(tabButton("Beta").getAttribute("aria-current")).toBe("page");
    expect(tabButton("Alfa").getAttribute("aria-current")).toBeNull();
    expect(within(tabOf("a")).getByRole("img", { name: "Alfa: 2 çalışıyor, 1 seni bekliyor" })).toBeTruthy();
    expect(within(tabOf("b")).queryByRole("img")).toBeNull();
  });

  it("a tab's tooltip is the project's location; tabs without one keep the strip's hint", () => {
    const handlers = { onActivate: vi.fn(), onClose: vi.fn(), onMove: vi.fn() };
    render(<ProjectTabs items={[{ ...items[0]!, location: "Mac mini: /repos/alfa" }, items[1]!]} active="a" {...handlers} />);
    expect(tabButton("Alfa").getAttribute("title")).toBe("Mac mini: /repos/alfa");
    expect(tabButton("Beta").getAttribute("title")).toBeNull();
    expect(strip().getAttribute("title")).toBe(defaultProjectTabsText.moveHint);
  });

  it("click activates, × and middle-click close", () => {
    const h = setup();
    fireEvent.click(tabButton("Alfa"));
    expect(h.onActivate).toHaveBeenCalledWith("a");
    fireEvent.click(within(strip()).getByRole("button", { name: defaultProjectTabsText.close("Gama") }));
    expect(h.onClose).toHaveBeenCalledWith("c");
    tabOf("a").dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(h.onClose).toHaveBeenLastCalledWith("a");
    // Right click is not a close.
    tabOf("b").dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 2 }));
    expect(h.onClose).toHaveBeenCalledTimes(2);
  });

  it("drag a tab onto another moves it to that place", () => {
    const h = setup();
    fireEvent.dragStart(tabOf("c"));
    fireEvent.dragOver(tabOf("a"));
    fireEvent.drop(tabOf("a"));
    expect(h.onMove).toHaveBeenCalledWith("c", 0);
    // A drop without a drag of ours (e.g. a file) does nothing.
    fireEvent.dragEnd(tabOf("c"));
    fireEvent.drop(tabOf("b"));
    expect(h.onMove).toHaveBeenCalledTimes(1);
  });

  it("keyboard alternative: the move shortcut moves the focused tab left/right", () => {
    const h = setup();
    const [left, right] = defaultProjectTabsText.moveKeys;
    const press = (el: HTMLElement, combo: string) => {
      const parts = combo.split("+");
      fireEvent.keyDown(el, {
        key: parts.at(-1),
        altKey: parts.includes("Alt"),
        shiftKey: parts.includes("Shift"),
        ctrlKey: parts.includes("Control"),
        metaKey: parts.includes("Meta"),
      });
    };
    press(tabButton("Beta"), right!);
    expect(h.onMove).toHaveBeenLastCalledWith("b", 2);
    press(tabButton("Beta"), left!);
    expect(h.onMove).toHaveBeenLastCalledWith("b", 0);
    expect(tabButton("Beta").getAttribute("aria-keyshortcuts")).toBe(`${left} ${right}`);
    fireEvent.keyDown(tabButton("Beta"), { key: "ArrowRight" });
    expect(h.onMove).toHaveBeenCalledTimes(2);
  });

  it("renders nothing when no project is open", () => {
    render(<ProjectTabs items={[]} active={null} onActivate={() => {}} onClose={() => {}} onMove={() => {}} />);
    expect(screen.queryByRole("toolbar")).toBeNull();
  });
});

describe("matchesKeys", () => {
  it("needs exactly the listed modifiers", () => {
    const ev = (key: string, mods: Partial<Record<"altKey" | "shiftKey" | "ctrlKey" | "metaKey", boolean>> = {}) =>
      ({ key, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, ...mods });
    expect(matchesKeys(ev("ArrowLeft", { altKey: true, shiftKey: true }), "Alt+Shift+ArrowLeft")).toBe(true);
    expect(matchesKeys(ev("ArrowLeft", { altKey: true }), "Alt+Shift+ArrowLeft")).toBe(false);
    expect(matchesKeys(ev("ArrowLeft", { altKey: true, shiftKey: true, metaKey: true }), "Alt+Shift+ArrowLeft")).toBe(false);
    expect(matchesKeys(ev("x"), "x")).toBe(true);
  });
});
