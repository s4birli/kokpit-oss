// Failure diagnostics for the Electron end-to-end tests. A failed step leaves what a person needs to explain it:
// a screenshot, the window's and the page's state (visible? focused? how large is the dock, which tab is in front),
// the Görünüm menu, the engine's log tail and the processes this run started. Cheap: nothing runs while steps pass.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ElectronApplication, Page } from "playwright";
import { afterEach } from "vitest";
import { SCREENSHOT_DIR, type EngineHandle } from "./harness.ts";

/** Where failure reports go (under the git-ignored screenshot folder). */
export const FAILURE_DIR = join(SCREENSHOT_DIR, "failures");
const DIAGNOSTICS = {
  /** No single probe may hold a failing step up for longer than this. */
  probeTimeoutMs: 5_000,
  engineLogTailChars: 6_000,
  pageTextChars: 4_000,
  fileNameChars: 120,
  /** Temp dirs of the harness and of the tests carry this in their name, and so do their processes' arguments. */
  processMarker: "kokpit-app-e2e",
} as const;

export interface DiagnosticsSource {
  app?: ElectronApplication | undefined;
  page?: Page | undefined;
  engine?: EngineHandle | undefined;
  /** Anything else worth having in the report (e.g. a fake helper's pids); may be async. Read at failure time. */
  extra?: (() => unknown) | undefined;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The probe's answer, or a note saying why there is none; a hung app must not hang the report. */
function bounded<T>(work: Promise<T>, what: string): Promise<T | string> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(`(${what}: no answer in ${DIAGNOSTICS.probeTimeoutMs} ms)`), DIAGNOSTICS.probeTimeoutMs);
  });
  return Promise.race([work.catch((err: unknown) => `(${what}: ${messageOf(err)})`), late]).finally(() => clearTimeout(timer));
}

/** The windows as the main process sees them, and the whole native menu. */
export function windowState(app: ElectronApplication): Promise<unknown> {
  return app.evaluate(({ BrowserWindow, Menu, app: electronApp }) => ({
    focusedWindow: BrowserWindow.getFocusedWindow() !== null,
    appHidden: process.platform === "darwin" ? electronApp.isHidden() : null,
    windows: BrowserWindow.getAllWindows().map((w) => ({
      visible: w.isVisible(),
      focused: w.isFocused(),
      minimized: w.isMinimized(),
      fullScreen: w.isFullScreen(),
      bounds: w.getBounds(),
      url: w.webContents.getURL(),
    })),
    menu: (Menu.getApplicationMenu()?.items ?? []).map((top) => ({
      label: top.label,
      items: (top.submenu?.items ?? []).filter((i) => i.type !== "separator").map((i) => `${i.checked ? "[x]" : "[ ]"} ${i.label}${i.enabled ? "" : " (disabled)"}`),
    })),
  }));
}

/** The page as the renderer sees it. */
export function pageState(page: Page): Promise<unknown> {
  return page.evaluate((maxText) => {
    const rect = (el: Element | null): string => {
      if (!el) return "(none)";
      const r = el.getBoundingClientRect();
      return `${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.x)},${Math.round(r.y)}`;
    };
    return {
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      activeElement: document.activeElement ? `${document.activeElement.tagName}.${document.activeElement.className}` : null,
      dock: rect(document.querySelector(".kp-dock-root")),
      // "*" marks the tab in front.
      groups: Array.from(document.querySelectorAll(".dv-groupview"), (g) => ({
        rect: rect(g),
        tabs: Array.from(g.querySelectorAll('[role="tab"]'), (t) => `${t.getAttribute("aria-selected") === "true" ? "*" : " "}${t.getAttribute("aria-label") ?? t.textContent ?? ""}`),
        panels: Array.from(g.querySelectorAll(".kp-dock-panel"), (p) => `${p.getAttribute("data-panel-id") ?? "?"} ${rect(p)}`),
      })),
      alerts: Array.from(document.querySelectorAll('[role="alert"]'), (a) => a.textContent ?? ""),
      text: (document.body.innerText ?? "").slice(0, maxText),
    };
  }, DIAGNOSTICS.pageTextChars);
}

/** Processes this test run started (children of the runner, at any depth) and any that carry the harness's marker. */
export function suiteProcesses(): string[] {
  const rows: { pid: number; ppid: number; line: string }[] = [];
  try {
    for (const line of execFileSync("ps", ["-axo", "pid=,ppid=,stat=,etime=,command="], { encoding: "utf8" }).split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s/.exec(line);
      if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), line: line.trim() });
    }
  } catch (err) {
    return [`(ps: ${messageOf(err)})`];
  }
  const ours = new Set<number>([process.pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rows) {
      if (ours.has(r.pid) || !ours.has(r.ppid)) continue;
      ours.add(r.pid);
      grew = true;
    }
  }
  return rows.filter((r) => r.pid !== process.pid && (ours.has(r.pid) || r.line.includes(DIAGNOSTICS.processMarker))).map((r) => r.line);
}

/** Writes `<name>.png` and `<name>.json` into FAILURE_DIR; never throws. Returns the report's path. */
export async function writeDiagnostics(name: string, source: DiagnosticsSource, error?: string): Promise<string> {
  const base = join(FAILURE_DIR, name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, DIAGNOSTICS.fileNameChars));
  const { app, page, engine } = source;
  const report: Record<string, unknown> = { name, at: new Date().toISOString(), error };
  try {
    mkdirSync(FAILURE_DIR, { recursive: true });
    report.window = app ? await bounded(windowState(app), "window") : "(no app)";
    report.page = page ? await bounded(pageState(page), "page") : "(no page)";
    report.screenshot = page ? await bounded(page.screenshot({ path: `${base}.png` }).then(() => `${base}.png`), "screenshot") : "(no page)";
    report.engine = engine
      ? { url: engine.url, pid: engine.child.pid, exitCode: engine.child.exitCode, signal: engine.child.signalCode, logTail: engine.log().slice(-DIAGNOSTICS.engineLogTailChars) }
      : "(no engine)";
    report.extra = source.extra ? await bounded(Promise.resolve().then(source.extra), "extra") : undefined;
    report.processes = suiteProcesses();
    writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
  } catch (err) {
    console.warn("[e2e] failure diagnostics could not be written", err);
  }
  return `${base}.json`;
}

/**
 * Call once at the top level of an e2e file: every failed step then leaves a report (see writeDiagnostics) named
 * after the file and the step, and its path is printed. `source` is read at failure time, so it returns what
 * beforeAll (or the step itself, after a relaunch) set.
 */
export function diagnoseFailures(file: string, source: () => DiagnosticsSource): void {
  afterEach(async (ctx) => {
    if (ctx.task.result?.state !== "fail") return;
    const path = await writeDiagnostics(`${file}-${ctx.task.name}`, source(), ctx.task.result.errors?.[0]?.message);
    console.warn(`[e2e] ${file}: "${ctx.task.name}" failed; diagnostics: ${path}`);
  });
}
