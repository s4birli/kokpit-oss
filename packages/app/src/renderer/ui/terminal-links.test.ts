// Bağlantılar: links in a terminal, against a minimal stand-in for xterm (its buffer, its link provider registry,
// its OSC 8 `linkHandler`, and the way its Linkifier calls `hover` / `leave` and tracks `decorations`).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t as msg } from "../../i18n/index.ts";
import { linksConfig, type LinkMenuChoice, type LinksConfig } from "../engine/links-ipc.ts";
import type { FileLocation } from "@kokpit/shared";
import type { LinkDestination, PathState } from "./link-actions.ts";
import type { PathLinkRef, TerminalPathHost } from "./link-opener.ts";
import { attachTerminalLinks, linksOfRow, pathsOfRow, type LinkProvider, type LinkRange, type LinkTerm, type ProvidedLink } from "./terminal-links.ts";

const cfg: LinksConfig = { ...linksConfig, tooltipDelayMs: 300, confirmMs: 5000, noticeMs: 2000, clickMaxMovePx: 4, maxWrappedRows: 8 };
const COLS = 40;

interface Cell {
  chars: string;
  width: number;
}
/** East Asian wide characters and emoji take two cells, like in xterm. */
const isWide = (cp: number): boolean => (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xff00 && cp <= 0xff60) || cp >= 0x1f300;
function cellsOf(text: string): Cell[] {
  const cells: Cell[] = [];
  for (const ch of text) {
    if (isWide(ch.codePointAt(0)!)) cells.push({ chars: ch, width: 2 }, { chars: "", width: 0 });
    else cells.push({ chars: ch, width: 1 });
  }
  return cells;
}
/** Lays `text` out like a terminal `cols` wide would: a new row whenever the next character does not fit. */
function layout(lines: readonly string[], cols = COLS): { cells: Cell[]; isWrapped: boolean }[] {
  const rows: { cells: Cell[]; isWrapped: boolean }[] = [];
  for (const line of lines) {
    let row: Cell[] = [];
    let wrapped = false;
    const flush = (): void => {
      while (row.length < cols) row.push({ chars: "", width: 1 });
      rows.push({ cells: row, isWrapped: wrapped });
      row = [];
      wrapped = true;
    };
    const cells = cellsOf(line);
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i]!;
      if (cell.width === 0) continue;
      if (row.length + cell.width > cols) flush();
      row.push(cell);
      if (cell.width === 2) row.push({ chars: "", width: 0 });
    }
    flush();
  }
  return rows;
}

function fakeTerm(lines: readonly string[], cols = COLS) {
  const rows = layout(lines, cols);
  const providers: LinkProvider[] = [];
  const term: LinkTerm & { selection: boolean; mouse: LinkTerm["modes"]["mouseTrackingMode"] } = {
    cols,
    selection: false,
    mouse: "none",
    buffer: {
      active: {
        getLine: (y) => {
          const row = rows[y];
          if (!row) return undefined;
          return {
            isWrapped: row.isWrapped,
            length: row.cells.length,
            getCell: (x) => {
              const cell = row.cells[x];
              return cell ? { getChars: () => cell.chars, getWidth: () => cell.width } : undefined;
            },
            translateToString: (_trim, start = 0, end = row.cells.length) =>
              row.cells
                .slice(start, end)
                .filter((c) => c.width > 0)
                .map((c) => c.chars || " ")
                .join(""),
          };
        },
      },
    },
    modes: {
      get mouseTrackingMode() {
        return term.mouse;
      },
    },
    options: { linkHandler: null },
    registerLinkProvider: (p) => {
      providers.push(p);
      return { dispose: () => void providers.splice(providers.indexOf(p), 1) };
    },
    hasSelection: () => term.selection,
  };
  return { term, rows, providers };
}

/** The row text as drawn (for locating things in a test). */
const rowText = (row: { cells: Cell[] }): string => row.cells.map((c) => (c.width === 0 ? "" : c.chars || " ")).join("");

interface Opened {
  url: string;
  where: "project" | "external";
}
const attached: { dispose(): void }[] = [];

function setup(
  lines: readonly string[],
  over: { config?: Partial<LinksConfig>; isMac?: boolean; destination?: LinkDestination; cols?: number; openFails?: string; path?: TerminalPathHost } = {},
) {
  const { term, rows, providers } = fakeTerm(lines, over.cols);
  const container = document.createElement("div");
  const screen = document.createElement("div");
  container.append(screen);
  document.body.append(container);
  const opened: Opened[] = [];
  const menus: string[] = [];
  let menuChoice: LinkMenuChoice | null = null;
  let destination: LinkDestination = over.destination ?? "engine";
  const handle = attachTerminalLinks(term, container, {
    config: { ...cfg, ...over.config },
    isMac: over.isMac ?? true,
    host: {
      destination: () => destination,
      machineName: () => "Mac mini",
      open: async (url, where) => {
        opened.push({ url, where });
        if (over.openFails !== undefined) throw new Error(over.openFails);
      },
      menu: async (url) => {
        menus.push(url);
        return menuChoice;
      },
      ...(over.path ? { path: over.path } : {}),
    },
  });
  attached.push(handle);
  /** Events that reach the terminal (xterm listens below the container, in the bubble phase). */
  const seen: string[] = [];
  for (const type of ["mousedown", "mouseup", "contextmenu"]) screen.addEventListener(type, (e) => seen.push(`${type}:${(e as MouseEvent).button}`));

  // --- what xterm's Linkifier does ---
  let current: { link: ProvidedLink; state: { underline: boolean; pointerCursor: boolean } } | undefined;
  let osc: { uri: string; range: LinkRange } | undefined;
  const inRange = (r: LinkRange, x: number, y: number): boolean => {
    const at = y * term.cols + x;
    return r.start.y * term.cols + r.start.x <= at && at <= r.end.y * term.cols + r.end.x;
  };
  const linksAt = (y: number): ProvidedLink[] => {
    let links: ProvidedLink[] | undefined;
    providers[0]!.provideLinks(y, (l) => (links = l));
    return links ?? [];
  };
  const leaveAll = (): void => {
    if (current) {
      const { link } = current;
      current = undefined;
      link.leave?.(mouse("mousemove"), link.text);
    }
    if (osc) {
      const { uri, range } = osc;
      osc = undefined;
      term.options.linkHandler?.leave?.(mouse("mousemove"), uri, range);
    }
  };
  /** The pointer moves to cell (x, y), 1-based: xterm asks the provider and hovers the link there, if any. */
  const hoverCell = (x: number, y: number, init: MouseEventInit = {}): ProvidedLink | undefined => {
    leaveAll();
    const link = linksAt(y).find((l) => inRange(l.range, x, y));
    if (!link) return undefined;
    const state = { underline: link.decorations?.underline ?? true, pointerCursor: link.decorations?.pointerCursor ?? true };
    current = { link, state };
    link.hover?.(mouse("mousemove", init), link.text);
    // Like xterm: from now on changes to `decorations` are tracked.
    link.decorations = {
      get underline() {
        return state.underline;
      },
      set underline(v: boolean) {
        state.underline = v;
      },
      get pointerCursor() {
        return state.pointerCursor;
      },
      set pointerCursor(v: boolean) {
        state.pointerCursor = v;
      },
    };
    return link;
  };
  /** Hovers the first link whose text contains `piece`; fails when there is none. */
  const hover = (piece: string, init: MouseEventInit = {}): ProvidedLink => {
    for (let y = 1; y <= rows.length; y++) {
      const col = rowText(rows[y - 1]!).indexOf(piece);
      if (col < 0) continue;
      const link = hoverCell(col + 1, y, init);
      if (link) return link;
    }
    throw new Error(`no link at "${piece}"`);
  };
  /** An OSC 8 link whose visible text is `text` (found on screen), pointing at `uri`. */
  const hoverOsc = (text: string, uri: string, init: MouseEventInit = {}): void => {
    leaveAll();
    const y = rows.findIndex((r) => rowText(r).includes(text));
    if (y < 0) throw new Error(`"${text}" not on screen`);
    const x = rowText(rows[y]!).indexOf(text);
    const range: LinkRange = { start: { x: x + 1, y: y + 1 }, end: { x: x + text.length, y: y + 1 } };
    osc = { uri, range };
    term.options.linkHandler?.hover?.(mouse("mousemove", init), uri, range);
  };
  const click = (init: MouseEventInit = {}, up: MouseEventInit = {}): void => {
    screen.dispatchEvent(mouse("mousedown", init));
    screen.dispatchEvent(mouse("mouseup", { ...init, ...up }));
  };
  const rightClick = (init: MouseEventInit = {}): MouseEvent => {
    screen.dispatchEvent(mouse("mousedown", { button: 2, ...init }));
    screen.dispatchEvent(mouse("mouseup", { button: 2, ...init }));
    const menu = mouse("contextmenu", { button: 2, ...init });
    screen.dispatchEvent(menu);
    return menu;
  };
  return {
    term,
    container,
    screen,
    handle,
    opened,
    menus,
    seen,
    providers,
    linksAt,
    hover,
    hoverCell,
    hoverOsc,
    leaveAll,
    click,
    rightClick,
    decorations: () => current?.state,
    choose: (c: LinkMenuChoice | null) => (menuChoice = c),
    setDestination: (d: LinkDestination) => (destination = d),
    tip: () => container.querySelector<HTMLElement>(".kp-term__linktip"),
    tipLines: () => Array.from(container.querySelectorAll(".kp-term__linktip > span"), (s) => s.textContent ?? ""),
    confirm: () => container.querySelector<HTMLElement>(".kp-term__linkconfirm"),
    note: () => container.querySelector<HTMLElement>(".kp-term__linknote")?.textContent ?? null,
  };
}

const mouse = (type: string, init: MouseEventInit = {}): MouseEvent => new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 10, ...init });
const CMD = { metaKey: true };
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const h of attached.splice(0)) h.dispose();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("plain-text links: where they are", () => {
  const found = (lines: readonly string[], y: number, cols = COLS): { url: string; range: LinkRange }[] | undefined =>
    linksOfRow(fakeTerm(lines, cols).term, y, cfg.maxWrappedRows, (url, range) => ({ url, range }));

  it("an address on a row: its cells, 1-based and inclusive", () => {
    expect(found(["  Local: http://localhost:3000/ ok"], 1)).toEqual([{ url: "http://localhost:3000/", range: { start: { x: 10, y: 1 }, end: { x: 31, y: 1 } } }]);
  });

  it("punctuation around the address is not part of the link", () => {
    const [link] = found(["Bkz. (https://a.example/x)."], 1)!;
    expect(link).toEqual({ url: "https://a.example/x", range: { start: { x: 7, y: 1 }, end: { x: 25, y: 1 } } });
  });

  it("a bare localhost:PORT is a link to http://localhost:PORT, drawn where it was written", () => {
    expect(found(["ready on localhost:5173/app"], 1)).toEqual([{ url: "http://localhost:5173/app", range: { start: { x: 10, y: 1 }, end: { x: 27, y: 1 } } }]);
  });

  it("an address wrapped over several rows is ONE link, whichever of its rows is asked for", () => {
    const url = `https://a.example/${"u".repeat(70)}/SON`;
    const lines = ["önce", `git ${url} bitti`, "sonra"];
    const want = { url, range: { start: { x: 5, y: 2 }, end: { x: (4 + url.length) % COLS, y: 4 } } };
    expect(4 + url.length).toBeGreaterThan(2 * COLS);
    for (const y of [2, 3, 4]) expect(found(lines, y)).toEqual([want]);
    expect(found(lines, 1)).toEqual([]);
    expect(found(lines, 5)).toEqual([]);
  });

  it("wide characters before the address take two cells each", () => {
    // "漢字" = 4 cells, " " = 1 → the address starts in cell 6.
    expect(found(["漢字 https://a.example/x 終"], 1)).toEqual([{ url: "https://a.example/x", range: { start: { x: 6, y: 1 }, end: { x: 24, y: 1 } } }]);
    expect(found(["😀 http://localhost:1/ ✓"], 1)![0]!.range.start).toEqual({ x: 4, y: 1 });
  });

  it("Turkish text around and inside the address", () => {
    expect(found(["şuraya bakın: https://a.example/çğış, lütfen"], 1)![0]!.url).toBe("https://a.example/çğış");
  });

  it("several addresses on a line", () => {
    expect(found(["http://a.example/1 ve http://b.example/2"], 1)!.map((l) => l.url)).toEqual(["http://a.example/1", "http://b.example/2"]);
  });

  it("schemes that are never opened are not links in plain text", () => {
    expect(found(["file:///tmp/a.txt vscode://file/x javascript:alert(1) mailto:a@b.example"], 1)).toEqual([]);
  });

  it("a row that does not exist: undefined", () => {
    expect(found(["x"], 5)).toBeUndefined();
    expect(found(["x"], 0)).toBeUndefined();
    expect(found(["x"], -3)).toBeUndefined();
    expect(found(["x"], 1.5)).toBeUndefined();
  });

  it("a line wrapped over more rows than are joined: an address cut at that edge is not offered as a link", () => {
    const url = `https://a.example/${"u".repeat(12 * COLS)}/SON`;
    // Rows 1…: the address fills far more than maxWrappedRows rows.
    const first = found([url], 1);
    expect(first).toEqual([]);
    const middle = found([url], 7);
    expect(middle).toEqual([]);
  });

  it("monkey: random screens never throw and every range lies inside the buffer", () => {
    const pieces = ["http://", "https://a.example/", "localhost:3000", "漢字", "😀", " ", "(", ")", ".", "çğ", "x".repeat(30), "/", "?a=1", "│", "[::1]:8080"];
    let seed = 4711;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let round = 0; round < 300; round++) {
      const lines = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => Array.from({ length: Math.floor(rnd() * 12) }, () => pieces[Math.floor(rnd() * pieces.length)]).join(""));
      const cols = 8 + Math.floor(rnd() * 40);
      const { term, rows } = fakeTerm(lines, cols);
      for (let y = 0; y <= rows.length + 1; y++) {
        const links = linksOfRow(term, y, cfg.maxWrappedRows, (url, range) => ({ url, range }));
        for (const l of links ?? []) {
          expect(l.range.start.x).toBeGreaterThanOrEqual(1);
          expect(l.range.end.x).toBeLessThanOrEqual(cols);
          expect(l.range.start.y).toBeGreaterThanOrEqual(1);
          expect(l.range.end.y).toBeLessThanOrEqual(rows.length);
          expect(l.range.start.y * cols + l.range.start.x).toBeLessThanOrEqual(l.range.end.y * cols + l.range.end.x);
          expect(/^https?:\/\//.test(l.url)).toBe(true);
        }
      }
    }
  });
});

describe("gestures while the program tracks the mouse (Claude Code)", () => {
  const LINES = ["DUZ http://127.0.0.1:3000/duz?x=1 son"];
  const tracked = (over: Parameters<typeof setup>[1] = {}) => {
    const s = setup(LINES, over);
    s.term.mouse = "drag";
    return s;
  };

  it("⌘ click opens the link in the project's browser, and the click never reaches the program", async () => {
    const s = tracked();
    s.hover("/duz", CMD);
    s.click(CMD);
    await flush();
    expect(s.opened).toEqual([{ url: "http://127.0.0.1:3000/duz?x=1", where: "project" }]);
    expect(s.seen).toEqual([]);
  });

  it("a plain click is the program's: nothing opens, the click passes", async () => {
    const s = tracked();
    s.hover("/duz");
    s.click();
    await flush();
    expect(s.opened).toEqual([]);
    expect(s.seen).toEqual(["mousedown:0", "mouseup:0"]);
  });

  it("⌥⌘ click opens it in the default browser", async () => {
    const s = tracked();
    s.hover("/duz", CMD);
    s.click({ metaKey: true, altKey: true });
    await flush();
    expect(s.opened).toEqual([{ url: "http://127.0.0.1:3000/duz?x=1", where: "external" }]);
    expect(s.seen).toEqual([]);
  });

  it("⌥ and ⇧ clicks stay selection gestures", async () => {
    const s = tracked();
    s.hover("/duz");
    s.click({ altKey: true });
    s.click({ shiftKey: true });
    await flush();
    expect(s.opened).toEqual([]);
    expect(s.seen).toHaveLength(4);
  });

  it("⌘ click where there is no link goes to the program as before", async () => {
    const s = tracked();
    expect(s.hoverCell(1, 1, CMD)).toBeUndefined();
    s.click(CMD);
    await flush();
    expect(s.opened).toEqual([]);
    expect(s.seen).toEqual(["mousedown:0", "mouseup:0"]);
  });

  it("the underline follows ⌘: off while hovering, on while the key is held", async () => {
    const s = tracked();
    s.hover("/duz");
    await flush();
    expect(s.decorations()).toEqual({ underline: false, pointerCursor: false });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", metaKey: true }));
    expect(s.decorations()).toEqual({ underline: true, pointerCursor: true });
    document.dispatchEvent(new KeyboardEvent("keyup", { key: "Meta" }));
    expect(s.decorations()).toEqual({ underline: false, pointerCursor: false });
    // The key went down elsewhere (another window): the next pointer move knows.
    s.screen.dispatchEvent(mouse("mousemove", CMD));
    expect(s.decorations()).toEqual({ underline: true, pointerCursor: true });
    window.dispatchEvent(new Event("blur"));
    expect(s.decorations()).toEqual({ underline: false, pointerCursor: false });
  });

  it("the tooltip names ⌘ click only, the real target and the engine machine", () => {
    const s = tracked();
    s.hover("/duz");
    expect(s.tip()).toBeNull();
    vi.advanceTimersByTime(cfg.tooltipDelayMs);
    expect(s.tipLines()).toEqual(["http://127.0.0.1:3000/duz?x=1", "⌘ tıkla: Mac mini'deki tarayıcıda açılır", `${msg("links.text.gestureExternal")} · ${msg("links.text.gestureMenu")}`]);
    expect(s.tip()!.getAttribute("role")).toBe("tooltip");
  });
});

describe("gestures while the program does not track the mouse (a shell)", () => {
  const LINES = ["DUZ http://127.0.0.1:3000/duz?x=1 son", "IKI https://b.example/iki"];

  it("a plain click opens the link; xterm still gets the click (focus, clearing a selection)", async () => {
    const s = setup(LINES);
    s.hover("/duz");
    s.click();
    await flush();
    expect(s.opened).toEqual([{ url: "http://127.0.0.1:3000/duz?x=1", where: "project" }]);
    expect(s.seen).toEqual(["mousedown:0", "mouseup:0"]);
  });

  it("⌘ click and ⌥⌘ click work as everywhere", async () => {
    const s = setup(LINES);
    s.hover("/duz", CMD);
    s.click(CMD);
    s.click({ metaKey: true, altKey: true });
    await flush();
    expect(s.opened.map((o) => o.where)).toEqual(["project", "external"]);
    expect(s.seen).toEqual([]);
  });

  it("the link is underlined on hover: a click would open it", async () => {
    const s = setup(LINES);
    s.hover("/duz");
    await flush();
    expect(s.decorations()).toEqual({ underline: true, pointerCursor: true });
    vi.advanceTimersByTime(cfg.tooltipDelayMs);
    expect(s.tipLines()[1]).toBe("Tıkla ya da ⌘ tıkla: Mac mini'deki tarayıcıda açılır");
  });

  it("a drag that starts on the link selects text; it does not open", async () => {
    const s = setup(LINES);
    s.hover("/duz");
    s.click({ clientX: 10, clientY: 10 }, { clientX: 60, clientY: 10 });
    await flush();
    expect(s.opened).toEqual([]);
  });

  it("a click that left a selection behind does not open", async () => {
    const s = setup(LINES);
    s.hover("/duz");
    s.term.selection = true;
    s.click();
    await flush();
    expect(s.opened).toEqual([]);
    // ⌘ click says "open" whatever is selected.
    s.click(CMD);
    await flush();
    expect(s.opened).toHaveLength(1);
  });

  it("pressed on one link, released on another: nothing opens", async () => {
    const s = setup(LINES);
    s.hover("/duz");
    s.screen.dispatchEvent(mouse("mousedown"));
    s.hover("/iki");
    s.screen.dispatchEvent(mouse("mouseup"));
    await flush();
    expect(s.opened).toEqual([]);
  });

  it("pressed on a link, released after the pointer left it: nothing opens", async () => {
    const s = setup(LINES);
    s.hover("/duz", CMD);
    s.screen.dispatchEvent(mouse("mousedown", CMD));
    s.leaveAll();
    s.screen.dispatchEvent(mouse("mouseup", CMD));
    await flush();
    expect(s.opened).toEqual([]);
  });

  it("with plain clicks turned off in the config only ⌘ click opens, and only ⌘ underlines", async () => {
    const s = setup(LINES, { config: { plainClickOpens: false } });
    s.hover("/duz");
    await flush();
    expect(s.decorations()).toEqual({ underline: false, pointerCursor: false });
    s.click();
    await flush();
    expect(s.opened).toEqual([]);
    s.click(CMD);
    await flush();
    expect(s.opened).toHaveLength(1);
  });

  it("other buttons do nothing", async () => {
    const s = setup(LINES);
    s.hover("/duz");
    s.click({ button: 1 });
    s.click({ button: 1, metaKey: true });
    await flush();
    expect(s.opened).toEqual([]);
  });

  it("nothing opens without a gesture: output, hovering and time alone never do", async () => {
    const s = setup(LINES);
    s.linksAt(1);
    s.hover("/duz");
    vi.advanceTimersByTime(60_000);
    s.leaveAll();
    s.hover("/iki", CMD);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", metaKey: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await flush();
    expect(s.opened).toEqual([]);
    expect(s.menus).toEqual([]);
  });

  it("xterm's own activation of a provided link does nothing (the decision is not xterm's)", async () => {
    const s = setup(LINES);
    const link = s.hover("/duz");
    link.activate(mouse("mouseup", CMD), link.text);
    await flush();
    expect(s.opened).toEqual([]);
  });
});

describe("the right-click menu", () => {
  const LINES = ["DUZ http://127.0.0.1:3000/duz?x=1 son"];

  it("on a link: Kokpit's link menu for its real target; the terminal's own menu and the program get nothing", async () => {
    const s = setup(LINES);
    s.term.mouse = "drag";
    s.hover("/duz");
    const event = s.rightClick();
    await flush();
    expect(s.menus).toEqual(["http://127.0.0.1:3000/duz?x=1"]);
    expect(event.defaultPrevented).toBe(true);
    expect(s.seen).toEqual([]);
    expect(s.opened).toEqual([]);
  });

  it.each([
    ["browser", [{ url: "http://127.0.0.1:3000/duz?x=1", where: "project" }]],
    ["external", [{ url: "http://127.0.0.1:3000/duz?x=1", where: "external" }]],
    ["copy", []],
    [null, []],
  ] as const)("choosing %j", async (choice, opened) => {
    const s = setup(LINES);
    s.choose(choice);
    s.hover("/duz");
    s.rightClick();
    await flush();
    expect(s.opened).toEqual(opened);
  });

  it("⌃ click (the macOS context click) is treated the same: its press does not reach the program", async () => {
    const s = setup(LINES);
    s.term.mouse = "any";
    s.hover("/duz");
    s.screen.dispatchEvent(mouse("mousedown", { ctrlKey: true }));
    s.screen.dispatchEvent(mouse("mouseup", { ctrlKey: true }));
    s.screen.dispatchEvent(mouse("contextmenu", { ctrlKey: true }));
    await flush();
    expect(s.menus).toHaveLength(1);
    expect(s.seen).toEqual([]);
  });

  it("away from a link the right click is the terminal's, untouched", async () => {
    const s = setup(LINES);
    s.hoverCell(1, 1);
    const event = s.rightClick();
    await flush();
    expect(s.menus).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
    expect(s.seen).toEqual(["mousedown:2", "mouseup:2", "contextmenu:2"]);
  });
});

describe("OSC 8 hyperlinks", () => {
  const LINES = ["OSC8 Belgeler_Baglantisi sonu", "JS JS_TIKLA", "OZEL OZEL_TIKLA", "SAHTE https://ornek.invalid/sahte", "DOSYA dosya.txt"];
  const TARGET = "http://127.0.0.1:3000/osc8";

  it("xterm is told to hand over every scheme and to activate nothing itself", () => {
    const s = setup(LINES);
    const handler = s.term.options.linkHandler!;
    expect(handler.allowNonHttpProtocols).toBe(true);
    handler.activate(mouse("mouseup"), TARGET, { start: { x: 1, y: 1 }, end: { x: 2, y: 1 } });
    expect(s.opened).toEqual([]);
  });

  it("⌘ click opens the link's TARGET, not its text — also while the program tracks the mouse", async () => {
    const s = setup(LINES);
    s.term.mouse = "drag";
    s.hoverOsc("Belgeler_Baglantisi", TARGET, CMD);
    s.click(CMD);
    await flush();
    expect(s.opened).toEqual([{ url: TARGET, where: "project" }]);
    expect(s.seen).toEqual([]);
    expect(s.confirm()).toBeNull();
  });

  it("the tooltip shows the target", () => {
    const s = setup(LINES);
    s.hoverOsc("Belgeler_Baglantisi", TARGET);
    vi.advanceTimersByTime(cfg.tooltipDelayMs);
    expect(s.tipLines()[0]).toBe(TARGET);
  });

  it.each([
    ["JS_TIKLA", "javascript:document.title='x'", "Bu tür bağlantı açılmaz (javascript:)"],
    ["OZEL_TIKLA", "kokpit-test-scheme://calistir", "Bu tür bağlantı açılmaz (kokpit-test-scheme:)"],
    ["dosya.txt", "file:///tmp/dosya.txt", msg("links.text.refusedFile")],
    ["OZEL_TIKLA", "vscode://file/tmp/x", "Bu tür bağlantı açılmaz (vscode:)"],
    ["OZEL_TIKLA", "mailto:a@b.example", "Bu tür bağlantı açılmaz (mailto:)"],
  ])("%s → %s: no gesture opens it; the tooltip says why; it can still be copied from the menu", async (text, uri, why) => {
    const s = setup(LINES);
    s.choose("browser");
    s.hoverOsc(text, uri, CMD);
    vi.advanceTimersByTime(cfg.tooltipDelayMs);
    expect(s.tipLines().at(-1)).toBe(`${why} · ${msg("links.text.refusedCopy")}`);
    expect(s.tip()!.dataset.refused).toBe("true");
    s.click();
    s.click(CMD);
    s.click({ metaKey: true, altKey: true });
    s.rightClick();
    await flush();
    expect(s.opened).toEqual([]);
    expect(s.menus).toEqual([uri]);
    expect(s.confirm()).toBeNull();
  });

  it("text that reads like another host's address: the tooltip warns, and ⌘ click asks with BOTH addresses before opening", async () => {
    const s = setup(LINES);
    s.hoverOsc("https://ornek.invalid/sahte", "http://127.0.0.1:3000/gercek", CMD);
    vi.advanceTimersByTime(cfg.tooltipDelayMs);
    expect(s.tipLines()[0]).toBe("http://127.0.0.1:3000/gercek");
    expect(s.tipLines().at(-1)).toBe("Dikkat: görünen adres başka (https://ornek.invalid/sahte)");
    s.click(CMD);
    await flush();
    expect(s.opened).toEqual([]);
    const confirm = s.confirm()!;
    expect(confirm.getAttribute("role")).toBe("alertdialog");
    expect(confirm.querySelector('[data-kind="shown"]')!.textContent).toBe(`${msg("links.text.confirmShown")}: https://ornek.invalid/sahte`);
    expect(confirm.querySelector('[data-kind="target"]')!.textContent).toBe(`${msg("links.text.confirmTarget")}: http://127.0.0.1:3000/gercek`);
    const [cancel, go] = Array.from(confirm.querySelectorAll("button"));
    expect([cancel!.textContent, go!.textContent]).toEqual([msg("links.text.confirmCancel"), msg("links.text.confirmOpen")]);
    go!.click();
    await flush();
    expect(s.opened).toEqual([{ url: "http://127.0.0.1:3000/gercek", where: "project" }]);
    expect(s.confirm()).toBeNull();
  });

  it("“Vazgeç”, Escape and time each dismiss the question without opening", async () => {
    const s = setup(LINES);
    const ask = (): void => {
      s.hoverOsc("https://ornek.invalid/sahte", "http://127.0.0.1:3000/gercek", CMD);
      s.click({ metaKey: true, altKey: true });
    };
    ask();
    s.confirm()!.querySelector("button")!.click();
    expect(s.confirm()).toBeNull();
    ask();
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(escape);
    expect(s.confirm()).toBeNull();
    expect(escape.defaultPrevented).toBe(true);
    ask();
    vi.advanceTimersByTime(cfg.confirmMs);
    expect(s.confirm()).toBeNull();
    await flush();
    expect(s.opened).toEqual([]);
  });

  it("the question is asked for an open chosen from the menu too", async () => {
    const s = setup(LINES);
    s.choose("external");
    s.hoverOsc("https://ornek.invalid/sahte", "http://127.0.0.1:3000/gercek");
    s.rightClick();
    await flush();
    expect(s.opened).toEqual([]);
    Array.from(s.confirm()!.querySelectorAll("button")).at(-1)!.click();
    await flush();
    expect(s.opened).toEqual([{ url: "http://127.0.0.1:3000/gercek", where: "external" }]);
  });

  it("clicks inside the question are not link gestures and do not reach the program", async () => {
    const s = setup(LINES);
    s.hoverOsc("https://ornek.invalid/sahte", "http://127.0.0.1:3000/gercek", CMD);
    s.click(CMD);
    const title = s.confirm()!.querySelector("p")!;
    title.dispatchEvent(mouse("mousedown", CMD));
    title.dispatchEvent(mouse("mouseup", CMD));
    await flush();
    expect(s.opened).toEqual([]);
    expect(s.confirm()).not.toBeNull();
    expect(s.seen).toEqual([]);
  });

  it("an Escape with no question on screen is the program's", () => {
    setup(LINES);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(false);
  });
});

describe("tooltip, notices and clean-up", () => {
  const LINES = ["DUZ http://127.0.0.1:3000/duz?x=1 son"];

  it("the tooltip appears after a pause and goes when the pointer leaves the link", () => {
    const s = setup(LINES);
    s.hover("/duz");
    vi.advanceTimersByTime(cfg.tooltipDelayMs - 1);
    expect(s.tip()).toBeNull();
    vi.advanceTimersByTime(1);
    expect(s.tip()).not.toBeNull();
    s.leaveAll();
    vi.advanceTimersByTime(0);
    expect(s.tip()).toBeNull();
  });

  it("moving from one link straight to another replaces the tooltip with the other link's", () => {
    const s = setup(["A http://a.example/bir", "B http://b.example/iki"]);
    s.hover("/bir");
    vi.advanceTimersByTime(cfg.tooltipDelayMs);
    expect(s.tipLines()[0]).toBe("http://a.example/bir");
    s.hover("/iki");
    vi.advanceTimersByTime(cfg.tooltipDelayMs);
    expect(s.tipLines()[0]).toBe("http://b.example/iki");
    // …also when xterm reports the old link's leave only after the new link's hover.
    const first = s.linksAt(1)[0]!;
    const second = s.linksAt(2)[0]!;
    second.hover!(mouse("mousemove"), second.text);
    vi.advanceTimersByTime(cfg.tooltipDelayMs);
    first.hover!(mouse("mousemove"), first.text);
    second.leave!(mouse("mousemove"), second.text);
    vi.advanceTimersByTime(cfg.tooltipDelayMs);
    expect(s.tipLines()[0]).toBe("http://a.example/bir");
  });

  it("leaving before the pause is over shows nothing", () => {
    const s = setup(LINES);
    s.hover("/duz");
    s.leaveAll();
    vi.advanceTimersByTime(cfg.tooltipDelayMs * 2);
    expect(s.tip()).toBeNull();
  });

  it("a row that xterm re-renders (leave + hover of the same link) keeps its tooltip, and keeps waiting for it", () => {
    const s = setup(LINES);
    s.hover("/duz");
    vi.advanceTimersByTime(cfg.tooltipDelayMs - 50);
    s.hover("/duz"); // the program redrew the row
    vi.advanceTimersByTime(50);
    const tip = s.tip();
    expect(tip).not.toBeNull();
    s.hover("/duz");
    vi.advanceTimersByTime(0);
    expect(s.tip()).toBe(tip);
  });

  it("says where the link opens for each kind of project", () => {
    for (const [destination, line] of [
      ["engine", "Tıkla ya da ⌘ tıkla: Mac mini'deki tarayıcıda açılır"],
      ["client", `Tıkla ya da ⌘ tıkla: ${msg("links.text.client")}`],
      ["external", `Tıkla ya da ⌘ tıkla: ${msg("links.text.external")}`],
    ] as const) {
      const s = setup(LINES, { destination });
      s.hover("/duz");
      vi.advanceTimersByTime(cfg.tooltipDelayMs);
      expect(s.tipLines()[1]).toBe(line);
    }
  });

  it("pressing the mouse hides the tooltip", () => {
    const s = setup(LINES);
    s.hover("/duz");
    vi.advanceTimersByTime(cfg.tooltipDelayMs);
    s.screen.dispatchEvent(mouse("mousedown"));
    expect(s.tip()).toBeNull();
  });

  it("a link that could not be opened says so for a while", async () => {
    const s = setup(LINES, { openFails: "Bağlantı açılamadı: En fazla 50 sekme açılabilir" });
    s.hover("/duz", CMD);
    s.click(CMD);
    await flush();
    expect(s.note()).toBe("Bağlantı açılamadı: En fazla 50 sekme açılabilir");
    vi.advanceTimersByTime(cfg.noticeMs);
    expect(s.note()).toBeNull();
  });

  it("elsewhere than macOS Ctrl plays ⌘'s part", async () => {
    const s = setup(LINES, { isMac: false });
    s.term.mouse = "drag";
    s.hover("/duz", { ctrlKey: true });
    s.click({ ctrlKey: true });
    await flush();
    expect(s.opened).toHaveLength(1);
    s.click({ metaKey: true });
    await flush();
    expect(s.opened).toHaveLength(1);
  });

  it("dispose removes the provider, the handler, the listeners and everything it put on screen", async () => {
    const s = setup(LINES);
    s.hover("/duz", CMD);
    vi.advanceTimersByTime(cfg.tooltipDelayMs);
    expect(s.tip()).not.toBeNull();
    s.handle.dispose();
    expect(s.tip()).toBeNull();
    expect(s.providers).toHaveLength(0);
    expect(s.term.options.linkHandler).toBeNull();
    s.click(CMD);
    s.rightClick();
    await flush();
    expect(s.opened).toEqual([]);
    expect(s.menus).toEqual([]);
    expect(s.seen).toEqual(["mousedown:0", "mouseup:0", "mousedown:2", "mouseup:2", "contextmenu:2"]);
  });
});

// ---- Yollar: local file paths in the output ----

const PAGE: FileLocation = { path: "/Users/ada/Documents/Acme-ux-2026-11-05/index.html", kind: "page", browser: true };
const SOURCE: FileLocation = { path: "/p/src/app.ts", kind: "file", rootPath: "src/app.ts", browser: false };

/** A stand-in for the opener's path host: answers from a table, records every question and every open. */
function fakePaths(table: Record<string, FileLocation | string>, over: { menu?: LinkMenuChoice | null; openFails?: string } = {}) {
  const asked: PathLinkRef[] = [];
  const opened: { ref: PathLinkRef; how: string }[] = [];
  const menus: PathLinkRef[] = [];
  const known = new Map<string, PathState>();
  const stateOf = (ref: PathLinkRef): PathState => {
    const found = table[ref.path];
    return found === undefined ? { status: "failed", message: "Dosya bulunamadı" } : typeof found === "string" ? { status: "failed", message: found } : { status: "found", location: found };
  };
  const host: TerminalPathHost = {
    peek: (ref) => known.get(ref.path),
    resolve: async (ref) => {
      asked.push(ref);
      const state = stateOf(ref);
      known.set(ref.path, state);
      return state;
    },
    open: async (ref, how) => {
      opened.push({ ref, how });
      if (over.openFails !== undefined) throw new Error(over.openFails);
    },
    menu: async (ref) => {
      menus.push(ref);
      return over.menu ?? null;
    },
  };
  return { host, asked, opened, menus };
}

describe("pathsOfRow", () => {
  const found = (lines: string[], y: number, cols = COLS): [string, LinkRange][] => pathsOfRow(fakeTerm(lines, cols).term, y, cfg.maxWrappedRows, (p, range) => [p.path, range] as [string, LinkRange]) ?? [];

  it("finds the path of the `open` line and where it is drawn", () => {
    expect(found(["open ~/Documents/rapor/index.html"], 1)).toEqual([["~/Documents/rapor/index.html", { start: { x: 6, y: 1 }, end: { x: 33, y: 1 } }]]);
  });

  it("a path the terminal wrapped is one link, from any of its rows", () => {
    const lines = ["Görmek için: open ~/Documents/Acme-ux-2026-11-05/index.html"];
    const first = found(lines, 1, 30);
    expect(first.map(([p]) => p)).toEqual(["~/Documents/Acme-ux-2026-11-05/index.html"]);
    expect(found(lines, 2, 30)).toEqual(first);
    expect(first[0]![1].start.y).toBe(1);
    expect(first[0]![1].end.y).toBeGreaterThan(1);
  });

  it("text that is an address is a link, never also a path", () => {
    const { term } = fakeTerm(["http://localhost:3000/src/a.ts"]);
    expect(pathsOfRow(term, 1, cfg.maxWrappedRows, (p) => p.path)).toEqual([]);
    expect(linksOfRow(term, 1, cfg.maxWrappedRows, (url) => url)).toEqual(["http://localhost:3000/src/a.ts"]);
  });
});

describe("attachTerminalLinks: dosya yolları", () => {
  it("offers no path links when the host cannot act on them", () => {
    const t = setup(["open ~/Documents/rapor/index.html"]);
    expect(t.linksAt(1)).toEqual([]);
  });

  it("moving over a path asks the engine nothing; resting on it asks once, and the tooltip says where it opens", async () => {
    const paths = fakePaths({ "~/Documents/Acme-ux-2026-11-05/index.html": PAGE });
    const t = setup(["open ~/Documents/Acme-ux-2026-11-05/index.html"], { path: paths.host, cols: 80 });
    for (let i = 0; i < 20; i++) {
      t.hover("~/Documents");
      t.leaveAll();
    }
    t.hover("~/Documents");
    vi.advanceTimersByTime(cfg.tooltipDelayMs - 1);
    expect(paths.asked).toEqual([]);
    vi.advanceTimersByTime(1);
    // Shown at once with what the name alone says…
    expect(t.tipLines()).toEqual(["~/Documents/Acme-ux-2026-11-05/index.html", "Tıkla ya da ⌘ tıkla: Mac mini'deki tarayıcıda açılır", "sağ tık: seçenekler"]);
    expect(paths.asked).toEqual([{ path: "~/Documents/Acme-ux-2026-11-05/index.html", tail: "" }]);
    await flush();
    // …then with the file's real place.
    expect(t.tipLines()).toEqual(["/Users/ada/Documents/Acme-ux-2026-11-05/index.html", "Tıkla ya da ⌘ tıkla: Mac mini'deki tarayıcıda açılır", "sağ tık: seçenekler"]);
    // Resting there again does not ask again.
    t.leaveAll();
    vi.advanceTimersByTime(10);
    t.hover("~/Documents");
    vi.advanceTimersByTime(cfg.tooltipDelayMs);
    await flush();
    expect(paths.asked).toHaveLength(1);
  });

  it("a path that does not exist or is refused says so in the tooltip", async () => {
    const paths = fakePaths({ "~/.ssh/a.html": { path: "/Users/ada/.ssh/a.html", kind: "page", browser: false, browserRefusal: "Gizli (noktayla başlayan) klasör ve dosyalar önizlenmez" } });
    const t = setup(["bak: ~/yok/rapor.html ve ~/.ssh/a.html"], { path: paths.host, cols: 80 });
    t.hover("~/yok");
    vi.advanceTimersByTime(cfg.tooltipDelayMs);
    await flush();
    expect(t.tipLines()).toEqual(["~/yok/rapor.html", "Dosya bulunamadı · sağ tık: Yolu kopyala"]);
    expect(t.tip()?.dataset.refused).toBe("true");
    t.hover("~/.ssh");
    vi.advanceTimersByTime(cfg.tooltipDelayMs);
    await flush();
    expect(t.tipLines()).toEqual(["/Users/ada/.ssh/a.html", "Gizli (noktayla başlayan) klasör ve dosyalar önizlenmez · sağ tık: Yolu kopyala"]);
  });

  it("⌘ click opens the path, also while the program tracks the mouse; the program never sees the click", async () => {
    const paths = fakePaths({ "~/Documents/rapor/index.html": PAGE });
    const t = setup(["open ~/Documents/rapor/index.html"], { path: paths.host });
    t.term.mouse = "any";
    t.hover("~/Documents", CMD);
    await flush();
    expect(t.decorations()).toEqual({ underline: true, pointerCursor: true });
    t.click(CMD);
    expect(paths.opened).toEqual([{ ref: { path: "~/Documents/rapor/index.html", tail: "" }, how: "auto" }]);
    expect(t.seen).toEqual([]);
    expect(t.opened).toEqual([]);
  });

  it("a plain click opens it only when the program does not track the mouse", () => {
    const paths = fakePaths({ "src/app.ts": SOURCE });
    const t = setup(["src/app.ts değişti"], { path: paths.host });
    t.hover("src/app.ts");
    expect(t.decorations()).toEqual({ underline: true, pointerCursor: true });
    t.click();
    expect(paths.opened.map((o) => [o.ref.path, o.how])).toEqual([["src/app.ts", "auto"]]);
    t.term.mouse = "vt200";
    t.hover("src/app.ts");
    expect(t.decorations()).toEqual({ underline: false, pointerCursor: false });
    t.click();
    expect(paths.opened).toHaveLength(1);
    expect(t.seen.slice(-2)).toEqual(["mousedown:0", "mouseup:0"]);
  });

  it("plain clicks on paths can be turned off alone (links keep theirs)", () => {
    const paths = fakePaths({ "src/app.ts": SOURCE });
    const t = setup(["src/app.ts ve http://localhost:3000/"], { path: paths.host, config: { pathPlainClickOpens: false } });
    t.hover("src/app.ts");
    expect(t.decorations()).toEqual({ underline: false, pointerCursor: false });
    t.click();
    expect(paths.opened).toEqual([]);
    t.click(CMD);
    expect(paths.opened).toHaveLength(1);
    t.hover("http://localhost");
    t.click();
    expect(t.opened).toEqual([{ url: "http://localhost:3000/", where: "project" }]);
  });

  it("a drag, a selection, ⌥ and ⇧ clicks do not open a path", () => {
    const paths = fakePaths({ "src/app.ts": SOURCE });
    const t = setup(["src/app.ts"], { path: paths.host });
    t.hover("src/app.ts");
    t.click({ clientX: 10 }, { clientX: 40 });
    t.click({ altKey: true });
    t.click({ shiftKey: true });
    t.term.selection = true;
    t.click();
    expect(paths.opened).toEqual([]);
  });

  it("what follows an unquoted path travels with it, so the engine can find a name with a space", () => {
    const paths = fakePaths({});
    const t = setup(["yazıldı: /Volumes/Main Disk/kokpit/rapor.html (3 kB)"], { path: paths.host, cols: 80 });
    t.hover("/Volumes/Main");
    t.click(CMD);
    expect(paths.opened[0]!.ref).toEqual({ path: "/Volumes/Main", tail: " Disk/kokpit/rapor.html (3 kB)" });
  });

  it("a failed open shows the engine's message under the terminal and opens nothing else", async () => {
    const paths = fakePaths({}, { openFails: "Dosya bulunamadı" });
    const t = setup(["open ~/yok/index.html"], { path: paths.host });
    t.hover("~/yok");
    t.click(CMD);
    await flush();
    expect(t.note()).toBe("Dosya bulunamadı");
    expect(t.opened).toEqual([]);
  });

  it.each([
    ["browser", "browser"],
    ["files", "files"],
  ] as const)("right click shows the path's own menu; choosing %s asks for exactly that", async (choice, how) => {
    const paths = fakePaths({ "~/Documents/rapor/index.html": PAGE }, { menu: choice });
    const t = setup(["open ~/Documents/rapor/index.html"], { path: paths.host });
    t.term.mouse = "any";
    t.hover("~/Documents");
    const event = t.rightClick();
    expect(event.defaultPrevented).toBe(true);
    await flush();
    expect(paths.menus).toEqual([{ path: "~/Documents/rapor/index.html", tail: "" }]);
    expect(paths.opened).toEqual([{ ref: { path: "~/Documents/rapor/index.html", tail: "" }, how }]);
    // The link menu of addresses was not used, and the program got none of it.
    expect(t.menus).toEqual([]);
    expect(t.seen).toEqual([]);
  });

  it("choosing 'Yolu kopyala' or nothing opens nothing", async () => {
    for (const choice of ["copy", null] as const) {
      const paths = fakePaths({ "src/app.ts": SOURCE }, { menu: choice });
      const t = setup(["src/app.ts"], { path: paths.host });
      t.hover("src/app.ts");
      t.rightClick();
      await flush();
      expect(paths.menus).toHaveLength(1);
      expect(paths.opened).toEqual([]);
    }
  });

  it("SSH project: the tooltip says the file is remote and the engine is never asked", async () => {
    const paths = fakePaths({});
    const t = setup(["open ~/rapor/index.html"], { path: paths.host, destination: "external" });
    t.hover("~/rapor");
    vi.advanceTimersByTime(cfg.tooltipDelayMs);
    await flush();
    expect(t.tipLines()).toEqual(["~/rapor/index.html", "Dosya uzak sunucuda; Kokpit'te açılamaz · sağ tık: Yolu kopyala"]);
    expect(paths.asked).toEqual([]);
  });

  it("output alone opens nothing and asks nothing", async () => {
    const paths = fakePaths({ "~/Documents/rapor/index.html": PAGE });
    const t = setup(["open ~/Documents/rapor/index.html", "src/app.ts", "~/x/y.html"], { path: paths.host });
    for (let y = 1; y <= 3; y++) t.linksAt(y);
    vi.advanceTimersByTime(60_000);
    await flush();
    expect(paths.asked).toEqual([]);
    expect(paths.opened).toEqual([]);
  });
});
