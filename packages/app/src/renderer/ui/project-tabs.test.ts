// İş P — proje sekmeleri: pure open/activate/close/reorder logic.
import { describe, expect, it } from "vitest";
import {
  activateTab,
  closeTab,
  dropCard,
  dropMissingCards,
  emptyTabs,
  mergeTabs,
  moveTab,
  moveTabBy,
  openTab,
  parseTabs,
  retainProjects,
  selectionOf,
  tabsFromSelection,
  type ProjectTabsState,
} from "./project-tabs.ts";

const ids = (s: ProjectTabsState) => s.tabs.map((t) => t.projectId);
const three = () => openTab(openTab(openTab(emptyTabs(), "a"), "b"), "c");

describe("openTab", () => {
  it("opens a new tab at the end and activates it", () => {
    const s = three();
    expect(ids(s)).toEqual(["a", "b", "c"]);
    expect(s.active).toBe("c");
  });

  it("an open project is only activated (no duplicate), keeping its card unless one is given", () => {
    let s = openTab(three(), "a", "card1");
    s = openTab(s, "b");
    s = openTab(s, "a");
    expect(ids(s)).toEqual(["a", "b", "c"]);
    expect(s.active).toBe("a");
    expect(s.tabs[0]).toEqual({ projectId: "a", cardId: "card1" });
  });

  it("null clears the card, a string replaces it", () => {
    let s = openTab(emptyTabs(), "a", "x");
    s = openTab(s, "a", "y");
    expect(s.tabs[0]!.cardId).toBe("y");
    s = openTab(s, "a", null);
    expect(s.tabs[0]).toEqual({ projectId: "a" });
  });
});

describe("activateTab", () => {
  it("activates an open tab; an unknown id changes nothing", () => {
    const s = three();
    expect(activateTab(s, "a").active).toBe("a");
    expect(activateTab(s, "zz")).toBe(s);
  });
});

describe("closeTab", () => {
  it("closing the active tab activates its right neighbour, or the left one at the end", () => {
    let s = activateTab(three(), "b");
    s = closeTab(s, "b");
    expect(ids(s)).toEqual(["a", "c"]);
    expect(s.active).toBe("c");
    s = closeTab(s, "c");
    expect(s.active).toBe("a");
    s = closeTab(s, "a");
    expect(s).toEqual(emptyTabs());
  });

  it("closing an inactive tab keeps the active one; unknown ids change nothing", () => {
    const s = activateTab(three(), "a");
    const t = closeTab(s, "c");
    expect(ids(t)).toEqual(["a", "b"]);
    expect(t.active).toBe("a");
    expect(closeTab(s, "zz")).toBe(s);
  });
});

describe("moveTab / moveTabBy", () => {
  it("moves a tab to an index (clamped), the active one stays active", () => {
    const s = activateTab(three(), "b");
    expect(ids(moveTab(s, "a", 2))).toEqual(["b", "c", "a"]);
    expect(ids(moveTab(s, "c", 0))).toEqual(["c", "a", "b"]);
    expect(ids(moveTab(s, "c", -5))).toEqual(["c", "a", "b"]);
    expect(ids(moveTab(s, "a", 99))).toEqual(["b", "c", "a"]);
    expect(moveTab(s, "a", 2).active).toBe("b");
    expect(moveTab(s, "zz", 0)).toBe(s);
  });

  it("moves by a step (keyboard), stopping at the ends", () => {
    const s = three();
    expect(ids(moveTabBy(s, "b", -1))).toEqual(["b", "a", "c"]);
    expect(ids(moveTabBy(s, "b", 1))).toEqual(["a", "c", "b"]);
    expect(moveTabBy(s, "a", -1)).toBe(s);
    expect(moveTabBy(s, "c", 1)).toBe(s);
  });
});

describe("selection, cards and pruning", () => {
  it("the active tab is the selection: its card, else the project", () => {
    expect(selectionOf(emptyTabs())).toBeNull();
    expect(selectionOf(openTab(emptyTabs(), "a"))).toEqual({ kind: "project", projectId: "a" });
    expect(selectionOf(openTab(emptyTabs(), "a", "k"))).toEqual({ kind: "card", cardId: "k" });
  });

  it("a deleted card leaves its tab on the project", () => {
    const s = openTab(openTab(emptyTabs(), "a", "k"), "b", "m");
    const t = dropCard(s, "k");
    expect(t.tabs).toEqual([{ projectId: "a" }, { projectId: "b", cardId: "m" }]);
    expect(dropCard(s, "none")).toBe(s);
  });

  it("a card missing from its project's loaded list is dropped; unloaded lists keep the card", () => {
    const s = openTab(openTab(emptyTabs(), "a", "k"), "b", "m");
    const t = dropMissingCards(s, (p) => (p === "a" ? [{ id: "other" }] : undefined));
    expect(t.tabs).toEqual([{ projectId: "a" }, { projectId: "b", cardId: "m" }]);
    expect(dropMissingCards(s, () => [{ id: "k" }, { id: "m" }])).toBe(s);
  });

  it("tabs of projects that no longer exist are closed (neighbour activation)", () => {
    const s = activateTab(three(), "b");
    const t = retainProjects(s, new Set(["a", "c"]));
    expect(ids(t)).toEqual(["a", "c"]);
    expect(t.active).toBe("c");
    expect(retainProjects(s, new Set(["a", "b", "c"]))).toBe(s);
  });
});

describe("persistence", () => {
  it("round-trips through JSON", () => {
    const s = activateTab(openTab(three(), "b", "k"), "a");
    expect(parseTabs(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it("drops malformed input: bad entries, duplicates, a dangling active id", () => {
    expect(parseTabs(null)).toEqual(emptyTabs());
    expect(parseTabs("x")).toEqual(emptyTabs());
    expect(parseTabs({ tabs: "x", active: 1 })).toEqual(emptyTabs());
    expect(
      parseTabs({
        tabs: [{ projectId: "a", cardId: 5 }, { projectId: "a" }, null, { projectId: "" }, { projectId: "b", cardId: "k" }, 7],
        active: "zz",
      }),
    ).toEqual({ tabs: [{ projectId: "a" }, { projectId: "b", cardId: "k" }], active: "a" });
  });

  it("first launch: a saved selection becomes the only tab (a card needs its project)", () => {
    expect(tabsFromSelection(null, () => undefined)).toEqual(emptyTabs());
    expect(tabsFromSelection({ kind: "project", projectId: "a" }, () => undefined)).toEqual(openTab(emptyTabs(), "a"));
    expect(tabsFromSelection({ kind: "card", cardId: "k" }, () => undefined)).toBeNull();
    expect(tabsFromSelection({ kind: "card", cardId: "k" }, (id) => (id === "k" ? "a" : undefined))).toEqual(
      openTab(emptyTabs(), "a", "k"),
    );
  });

  it("changes made while loading are merged over the saved tabs", () => {
    const saved = activateTab(three(), "a");
    const live = openTab(openTab(emptyTabs(), "d"), "b", "k");
    const m = mergeTabs(saved, live);
    expect(ids(m)).toEqual(["a", "b", "c", "d"]);
    expect(m.active).toBe("b");
    expect(m.tabs[1]).toEqual({ projectId: "b", cardId: "k" });
    expect(mergeTabs(saved, emptyTabs())).toBe(saved);
  });
});

describe("monkey: random operations keep the invariants", () => {
  it("unique ids; active is null iff empty, else one of the tabs", () => {
    let seed = 42;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const pool = ["a", "b", "c", "d", "e", "zz"];
    let s = emptyTabs();
    for (let i = 0; i < 5000; i++) {
      const id = pool[rnd(pool.length)]!;
      switch (rnd(8)) {
        case 0:
          s = openTab(s, id, rnd(3) === 0 ? `k${rnd(3)}` : rnd(2) === 0 ? null : undefined);
          break;
        case 1:
          s = activateTab(s, id);
          break;
        case 2:
          s = closeTab(s, id);
          break;
        case 3:
          s = moveTab(s, id, rnd(9) - 2);
          break;
        case 4:
          s = moveTabBy(s, id, rnd(2) === 0 ? -1 : 1);
          break;
        case 5:
          s = dropCard(s, `k${rnd(3)}`);
          break;
        case 6:
          s = retainProjects(s, new Set(pool.filter(() => rnd(4) !== 0)));
          break;
        default:
          s = parseTabs(JSON.parse(JSON.stringify(s)));
      }
      const list = ids(s);
      expect(new Set(list).size).toBe(list.length);
      if (list.length === 0) expect(s.active).toBeNull();
      else expect(list).toContain(s.active);
    }
  });
});
