// A trace of the Tarayıcı panel's tab strip for the Electron end-to-end tests: every state the strip was in (tab
// ids, titles, which one is active) and every click on a "×", each with its wall-clock time, as the renderer saw
// them — plus the test's own notes (what it read, what it clicked, what the engine answered) and the engine's
// log lines about tabs (created / activated / close asked / destroyed). A failed step's report (diagnostics.ts,
// `extra`) carries it, so "which tab was clicked, and what did the list look like around it" is answered from the
// report alone. Cheap: one MutationObserver and one capturing click listener in the page.
import type { Page } from "playwright";

const TRACE = {
  /** The window property the page-side recorder lives under. */
  global: "__kokpitTabTrace",
  panel: "section.kp-browser",
  tab: ".kp-browser__tab",
  tabTitle: ".kp-browser__tab-select",
  tabClose: ".kp-browser__tab-close",
  idAttribute: "data-tab-id",
  /** Oldest entries are dropped beyond this (a runaway page must not grow the report without bound). */
  maxEntries: 2_000,
  /** Must match the engine's log messages about tabs (packages/engine/src/browser.ts, TAB_LOG). */
  engineLogPrefix: "browser tab ",
} as const;

export interface StripTab {
  id: string;
  title: string;
  active: boolean;
}

export type TabTraceEntry =
  | { at: string; kind: "strip"; tabs: StripTab[] }
  | { at: string; kind: "close-click"; id: string; label: string }
  | { at: string; kind: "note" | "engine"; note: string; data?: unknown };

/** The strip as it is right now: ids, titles and the active tab, in order. */
export function stripTabs(page: Page): Promise<StripTab[]> {
  return page.evaluate((sel) => {
    return Array.from(document.querySelectorAll(`${sel.panel} ${sel.tab}`), (el) => {
      const select = el.querySelector(sel.tabTitle);
      return {
        id: el.getAttribute(sel.idAttribute) ?? "",
        title: select?.textContent ?? "",
        active: select?.getAttribute("aria-pressed") === "true",
      };
    });
  }, TRACE);
}

/** Starts recording in the page (idempotent; a relaunched app is a new page and needs a new call). */
export async function startTabTrace(page: Page): Promise<void> {
  await page.evaluate((sel) => {
    const w = window as unknown as Record<string, { entries: unknown[] } | undefined>;
    if (w[sel.global]) return;
    const entries: unknown[] = [];
    w[sel.global] = { entries };
    const push = (entry: Record<string, unknown>): void => {
      entries.push({ at: new Date().toISOString(), ...entry });
      if (entries.length > sel.maxEntries) entries.shift();
    };
    const read = () =>
      Array.from(document.querySelectorAll(`${sel.panel} ${sel.tab}`), (el) => {
        const select = el.querySelector(sel.tabTitle);
        return {
          id: el.getAttribute(sel.idAttribute) ?? "",
          title: select?.textContent ?? "",
          active: select?.getAttribute("aria-pressed") === "true",
        };
      });
    let last = "";
    const sample = (): void => {
      const tabs = read();
      const key = JSON.stringify(tabs);
      if (key === last) return;
      last = key;
      push({ kind: "strip", tabs });
    };
    sample();
    // The panel (and its strip) may be remounted, so the whole document is watched; only strip changes are kept.
    new MutationObserver(sample).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    document.addEventListener(
      "click",
      (ev) => {
        const close = ev.target instanceof Element ? ev.target.closest(sel.tabClose) : null;
        if (!close) return;
        push({
          kind: "close-click",
          id: close.closest(sel.tab)?.getAttribute(sel.idAttribute) ?? "",
          label: close.getAttribute("aria-label") ?? "",
        });
      },
      true,
    );
  }, TRACE);
}

/** What the page recorded so far, oldest first; empty when recording never started (or the page is gone). */
async function pageEntries(page: Page | undefined): Promise<TabTraceEntry[]> {
  if (!page || page.isClosed()) return [];
  return page.evaluate((key) => {
    const rec = (window as unknown as Record<string, { entries: unknown[] } | undefined>)[key];
    return (rec?.entries ?? []) as TabTraceEntry[];
  }, TRACE.global);
}

/** The engine's log lines about tabs (JSON lines whose message starts with the tab prefix), as entries. */
function engineEntries(engineLog: string): TabTraceEntry[] {
  const out: TabTraceEntry[] = [];
  for (const line of engineLog.split("\n")) {
    if (!line.includes(`"${TRACE.engineLogPrefix}`)) continue;
    try {
      const { ts, msg, level: _level, ...data } = JSON.parse(line) as { ts: string; msg: string; level?: string } & Record<string, unknown>;
      out.push({ at: ts, kind: "engine", note: msg, data });
    } catch {
      /* a partial line */
    }
  }
  return out;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The test's side of the trace: its own notes, merged on demand with the page's and the engine's, by time. */
export class TabTrace {
  private readonly notes: TabTraceEntry[] = [];

  /** A line of the test's own (what it read, what it is about to click); synchronous, so it costs the step no time. */
  note(note: string, data?: unknown): void {
    this.notes.push({ at: new Date().toISOString(), kind: "note", note, ...(data === undefined ? {} : { data }) });
  }

  /** Notes the answer of `work` (e.g. the engine's tab list) when it arrives, without making the step wait for it. */
  noteLater(note: string, work: Promise<unknown>): void {
    const asked = new Date().toISOString();
    void work.then(
      (data) => this.note(note, { asked, data }),
      (err: unknown) => this.note(note, { asked, error: messageOf(err) }),
    );
  }

  /** Everything, oldest first: the strip's states and "×" clicks, the test's notes, the engine's tab log lines. */
  async entries(page: Page | undefined, engineLog = ""): Promise<TabTraceEntry[]> {
    const fromPage = await pageEntries(page).catch((err: unknown): TabTraceEntry[] => [
      { at: new Date().toISOString(), kind: "note", note: `(page trace unreadable: ${messageOf(err)})` },
    ]);
    return [...fromPage, ...this.notes, ...engineEntries(engineLog)].sort((a, b) => a.at.localeCompare(b.at));
  }
}
