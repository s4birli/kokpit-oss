// "Seni bekleyen" and the collapsible rail: the built Kokpit app (Electron) against a real engine whose PATH starts
// with a fake `claude` that prints Claude Code's permission prompt and waits. The real `claude` never runs.
// With 0, 1, 3 and 12 waiting sessions, at three window sizes, rail expanded and collapsed:
// - collapsed, the rail is the same narrow strip whatever waits: a count badge inside it, nothing beyond its right
//   edge, nothing over the dock or the project tabs, no sideways scroll;
// - expanded, the list is capped (its own scroll) so the projects stay on screen, and long names are cut with "…"
//   (full text in the tooltip);
// - the badge opens the list, and a waiting session chosen there gets its terminal — the rail goes back to the strip.
// Every bound is read from the window or the stylesheet. Steps run in order and share state.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, TerminalInfo, Tool } from "@kokpit/shared";
import type { ElectronApplication, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { engineRequest, launchApp, SCREENSHOT_DIR, sleep, startEngine, stopEngine, type EngineHandle } from "./harness.ts";
import { diagnoseFailures } from "./diagnostics.ts";

const KEY = randomBytes(32).toString("hex");
const UI_TIMEOUT_MS = 20_000;
const DIMS = { cols: 100, rows: 30 };
/** How long a window size must hold before it is measured (macOS may clamp a size larger than the display). */
const SETTLE_MS = 300;
/** Sub-pixel layout: an edge may be off by less than a pixel. */
const ROUNDING_PX = 1;
/** The engine's limit for a name (shared protocol). */
const NAME_MAX = 100;

/** Claude Code's permission prompt, then a blocking read: the terminal waits for the user until the test ends. */
const FAKE_CLAUDE = `#!/bin/sh
printf '\\033[1mBash command\\033[0m\\r\\n  npm test\\r\\n\\033[1mDo\\033[1Cyou want to proceed?\\033[0m\\r\\n\\033[36m\\342\\235\\257 1. Yes\\033[39m\\r\\n  2. No, and tell Claude what to do differently (esc)\\r\\n'
read answer
echo "answered"
exec sleep 600
`;

const PLAIN_PROJECT = "Bekleme Projesi";
const LONG_PROJECT = "Çok uzun adlı bir müşteri projesi: ödeme altyapısı ve raporlama ekranlarının yeniden yazımı";
const UNBROKEN_PROJECT = "BoşluksuzÇokUzunProjeAdı".repeat(5).slice(0, NAME_MAX);
const UNBROKEN_TOOL = "BoşluksuzUzunAjanAdı".repeat(5).slice(0, NAME_MAX);
const PROJECT_NAMES = [PLAIN_PROJECT, LONG_PROJECT, UNBROKEN_PROJECT];
/** Waiting sessions on screen, step by step. */
const COUNTS = [0, 1, 3, 12] as const;
const WINDOWS = [
  { id: "1440x900", width: 1440, height: 900 },
  { id: "1000x640", width: 1000, height: 640 },
  { id: "1920x1080", width: 1920, height: 1080 },
] as const;

let root: string;
let engine: EngineHandle | undefined;
let app: ElectronApplication | undefined;
let page: Page;
let projects: Project[] = [];
let toolIds: string[] = [];
const opened: TerminalInfo[] = [];
const metrics: Record<string, unknown> = {};

diagnoseFailures("rail-waiting", () => ({ app, page, engine }));

const rail = (): Locator => page.getByRole("navigation", { name: "Kokpit" });
const waiting = (): Locator => rail().getByRole("region", { name: "Seni bekleyen" });
const badge = (): Locator => rail().getByRole("button", { name: /oturum seni bekliyor$/ });
const collapseButton = (): Locator => rail().getByRole("button", { name: "Sol listeyi daralt" });
const expandButton = (): Locator => rail().getByRole("button", { name: "Sol listeyi genişlet" });
const headerTitle = (): Promise<string | null> => page.locator(".kp-header__title").textContent();

async function shot(name: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `rail-waiting-${name}.png`) });
}
function saveMetrics(): void {
  writeFileSync(join(SCREENSHOT_DIR, "rail-waiting-metrics.json"), JSON.stringify(metrics, null, 2));
}

/** Asks for a content size and waits until the window keeps one (the display may allow less than asked). */
async function setWindow(size: { width: number; height: number }): Promise<{ width: number; height: number }> {
  await app!.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0]!.setContentSize(s.width, s.height), size);
  const read = (): Promise<{ width: number; height: number }> => page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  let last = await read();
  await expect
    .poll(
      async () => {
        await sleep(SETTLE_MS);
        const now = await read();
        const same = now.width === last.width && now.height === last.height;
        last = now;
        return same;
      },
      { timeout: UI_TIMEOUT_MS },
    )
    .toBe(true);
  return last;
}

async function setCollapsed(collapsed: boolean): Promise<void> {
  const button = collapsed ? collapseButton() : expandButton();
  if ((await button.count()) > 0) await button.click();
  await (collapsed ? expandButton() : collapseButton()).waitFor({ timeout: UI_TIMEOUT_MS });
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface RailGeometry {
  viewport: { width: number; height: number };
  /** The document's own width: wider than the viewport means a horizontal scrollbar / cut content. */
  scrollWidth: number;
  rail: Rect;
  /** The rail's own content is wider than the rail (it would scroll sideways). */
  railOverflowX: number;
  /** Tokens of theme.css, in px. */
  railBasis: number;
  railCollapsedMax: number;
  hitMin: number;
  dock: Rect | null;
  tabs: Rect | null;
  /** Elements of the rail that reach beyond its left or right edge. */
  beyond: string[];
  /** What is on top just right of the rail, at several heights: must never be part of the rail. */
  railOverContent: string[];
  toggle: Rect | null;
  settings: Rect | null;
  waiting: Rect | null;
  badge: Rect | null;
  badgeOnTop: boolean;
  list: (Rect & { maxHeight: number; scrollHeight: number; clientHeight: number; overflowY: string }) | null;
  projectsHeading: Rect | null;
  /** Waiting rows: text cut with "…" must be in the row's tooltip; nothing sticks out of its row. */
  rows: { title: string; text: string; cut: boolean; sticksOut: boolean }[];
}

function railGeometry(): Promise<RailGeometry> {
  return page.evaluate((rounding) => {
    const rect = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const nav = document.querySelector(".kp-rail");
    if (!nav) throw new Error("the rail is not on screen");
    const r = nav.getBoundingClientRect();
    const px = (token: string): number => {
      const probe = document.createElement("div");
      probe.style.cssText = `position:absolute;visibility:hidden;width:var(${token})`;
      document.body.append(probe);
      const w = probe.getBoundingClientRect().width;
      probe.remove();
      return w;
    };
    const describe = (el: Element): string => `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} "${(el.textContent ?? "").slice(0, 30)}"`;
    const beyond = [...nav.querySelectorAll("*")]
      .filter((el) => {
        const b = el.getBoundingClientRect();
        return b.width > 0 && b.height > 0 && (b.right > r.right + rounding || b.left < r.left - rounding);
      })
      .map((el) => {
        const b = el.getBoundingClientRect();
        return `${describe(el)} [${Math.round(b.left)}–${Math.round(b.right)}]`;
      });
    const railOverContent: string[] = [];
    for (let i = 1; i < 20; i++) {
      const y = (innerHeight * i) / 20;
      const top = document.elementFromPoint(r.right + rounding + 1, y);
      if (top && nav.contains(top)) railOverContent.push(`${describe(top)} at y=${Math.round(y)}`);
    }
    const listEl = nav.querySelector(".kp-waiting__list");
    const badgeEl = nav.querySelector(".kp-rail__waiting");
    const badgeRect = rect(badgeEl);
    const heading = [...nav.querySelectorAll("h2")].find((h) => h.textContent?.trim() === "Projeler") ?? null;
    return {
      viewport: { width: innerWidth, height: innerHeight },
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      rail: rect(nav)!,
      railOverflowX: nav.scrollWidth - nav.clientWidth,
      railBasis: px("--rail-basis"),
      railCollapsedMax: px("--rail-collapsed-max"),
      hitMin: px("--hit-min"),
      dock: rect(document.querySelector(".kp-layout")),
      tabs: rect(document.querySelector(".kp-ptabs")),
      beyond,
      railOverContent,
      toggle: rect(nav.querySelector(".kp-rail__collapse")),
      settings: rect([...nav.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Ayarlar") ?? null),
      waiting: rect(nav.querySelector(".kp-waiting")),
      badge: badgeRect,
      badgeOnTop:
        !!badgeEl && !!badgeRect && badgeEl.contains(document.elementFromPoint(badgeRect.x + badgeRect.width / 2, badgeRect.y + badgeRect.height / 2)),
      list: listEl
        ? {
            ...rect(listEl)!,
            maxHeight: parseFloat(getComputedStyle(listEl).maxHeight),
            scrollHeight: listEl.scrollHeight,
            clientHeight: listEl.clientHeight,
            overflowY: getComputedStyle(listEl).overflowY,
          }
        : null,
      projectsHeading: rect(heading),
      rows: [...nav.querySelectorAll(".kp-waiting__item")].map((row) => {
        const parts = [...row.querySelectorAll("span")];
        const rr = row.getBoundingClientRect();
        return {
          title: row.getAttribute("title") ?? "",
          text: row.textContent ?? "",
          cut: parts.some((s) => s.scrollWidth > s.clientWidth),
          sticksOut: parts.some((s) => {
            const b = s.getBoundingClientRect();
            return b.right > rr.right + rounding || b.left < rr.left - rounding;
          }),
        };
      }),
    };
  }, ROUNDING_PX);
}

const right = (r: Rect): number => r.x + r.width;
const bottom = (r: Rect): number => r.y + r.height;
const overlap = (a: Rect, b: Rect): boolean => a.x < right(b) && b.x < right(a) && a.y < bottom(b) && b.y < bottom(a);

/** What is wrong with the rail in this state; empty when all is as it should be. */
function problems(g: RailGeometry, state: { count: number; collapsed: boolean; stripWidth: number | null }): string[] {
  const out: string[] = [];
  const check = (ok: boolean, text: string): void => {
    if (!ok) out.push(text);
  };
  check(g.scrollWidth === g.viewport.width, `document is ${g.scrollWidth} wide in a ${g.viewport.width} viewport`);
  check(g.railOverflowX === 0, `the rail scrolls sideways by ${g.railOverflowX} px`);
  check(g.beyond.length === 0, `beyond the rail's edges: ${g.beyond.join("; ")}`);
  check(g.railOverContent.length === 0, `the rail covers what is right of it: ${g.railOverContent.join("; ")}`);
  check(g.rail.x === 0 && g.rail.y >= 0 && bottom(g.rail) <= g.viewport.height, "the rail is not inside the window");
  for (const [name, r] of [["dock", g.dock], ["project tabs", g.tabs]] as const) {
    if (!r) continue;
    check(r.x >= right(g.rail), `${name} start at ${r.x}, the rail ends at ${right(g.rail)}`);
    check(right(r) <= g.viewport.width, `${name} end at ${right(r)}, the window at ${g.viewport.width}`);
  }
  check(g.dock === null || g.dock.x === right(g.rail), `dock starts at ${g.dock?.x}, the rail ends at ${right(g.rail)}`);
  check(g.toggle !== null && right(g.toggle) <= right(g.rail) && g.toggle.y >= 0, "the collapse/expand button is not inside the rail");

  if (state.collapsed) {
    check(g.rail.width <= g.railCollapsedMax, `the strip is ${g.rail.width} px wide, --rail-collapsed-max is ${g.railCollapsedMax}`);
    check(state.stripWidth === null || g.rail.width === state.stripWidth, `the strip is ${g.rail.width} px wide; with nothing waiting it is ${state.stripWidth}`);
    check(g.waiting === null, `the "Seni bekleyen" block is still in the collapsed rail (${g.waiting?.width}×${g.waiting?.height})`);
    if (state.count === 0) check(g.badge === null, "a badge although nothing waits");
    else {
      check(g.badge !== null, "no badge although sessions wait");
      if (g.badge) {
        check(g.badge.x >= g.rail.x && right(g.badge) <= right(g.rail) && bottom(g.badge) <= g.viewport.height, "the badge is not inside the strip");
        check(g.badge.width >= g.hitMin && g.badge.height >= g.hitMin, `the badge is ${g.badge.width}×${g.badge.height}, smaller than --hit-min`);
        check(g.badgeOnTop, "the badge is covered");
        check(g.toggle === null || !overlap(g.badge, g.toggle), "the badge overlaps the expand button");
      }
    }
  } else {
    check(g.rail.width === g.railBasis, `the rail is ${g.rail.width} px wide, --rail-basis is ${g.railBasis}`);
    check(g.badge === null, "the badge shows while the rail is expanded");
    check(g.settings !== null && right(g.settings) <= right(g.rail), "Ayarlar is not inside the rail");
    check((g.waiting !== null) === state.count > 0, `"Seni bekleyen" ${g.waiting ? "shows" : "is missing"} with ${state.count} waiting`);
    check(g.rows.length === state.count, `${g.rows.length} waiting rows, ${state.count} waiting sessions`);
    if (g.list) {
      check(Number.isFinite(g.list.maxHeight), "the waiting list has no height cap");
      check(g.list.height <= g.list.maxHeight + ROUNDING_PX, `the waiting list is ${g.list.height} px tall, its cap is ${g.list.maxHeight}`);
      check(g.list.scrollHeight <= g.list.clientHeight || g.list.overflowY === "auto", "the waiting list is cut without its own scroll");
    }
    // The projects stay on screen however many sessions wait.
    check(g.projectsHeading !== null && bottom(g.projectsHeading) <= g.viewport.height, `"Projeler" is at ${g.projectsHeading?.y}, the window is ${g.viewport.height} tall`);
    for (const row of g.rows) {
      check(!row.sticksOut, `a waiting row's text sticks out of it: ${row.text.slice(0, 40)}`);
      check(!row.cut || row.title.length > 0, `a cut waiting row has no tooltip: ${row.text.slice(0, 40)}`);
    }
  }
  return out;
}

/** Opens fake-claude terminals until `count` sessions wait; spread over the projects and the two tools. */
async function waitFor(count: number): Promise<void> {
  while (opened.length < count) {
    const i = opened.length;
    const { terminal } = (await engineRequest(engine!.url, KEY, "terminal.open", {
      projectId: projects[i % projects.length]!.id,
      toolId: toolIds[i % toolIds.length]!,
      ...DIMS,
    })) as { terminal: TerminalInfo };
    opened.push(terminal);
  }
  await setCollapsed(false);
  await expect.poll(() => rail().locator(".kp-waiting__item").count(), { timeout: UI_TIMEOUT_MS }).toBe(count);
}

beforeAll(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-rail-waiting-")));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), FAKE_CLAUDE);
  chmodSync(join(bin, "claude"), 0o755);

  const configPath = join(root, "engine.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      dataDir: join(root, "data"),
      port: 0,
      shell: "/bin/sh",
      shellArgs: [],
      listenTailscale: false,
      flushIntervalMs: 100,
      killGraceMs: 200,
      activityWindowMs: 800,
      activityDebounceMs: 100,
    }),
  );
  engine = await startEngine(configPath, KEY, { HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` });
  await engineRequest(engine.url, KEY, "settings.update", { defaultToolId: null });
  for (const [i, name] of PROJECT_NAMES.entries()) {
    const dir = join(root, `proje-${i}`);
    mkdirSync(dir);
    const { project } = (await engineRequest(engine.url, KEY, "projects.create", { name, location: { kind: "local", path: dir } })) as { project: Project };
    projects.push(project);
  }
  // A second tool with a long name without a space; it runs the same fake and waits on the same prompt.
  const { tools } = (await engineRequest(engine.url, KEY, "tools.list", {})) as { tools: Tool[] };
  const claude = tools.find((t) => t.id === "claude")!;
  const { tool } = (await engineRequest(engine.url, KEY, "tools.create", {
    name: UNBROKEN_TOOL,
    command: "claude",
    waitingPatterns: claude.waitingPatterns ?? [],
  })) as { tool: Tool };
  toolIds = [claude.id, tool.id];

  app = await launchApp({ KOKPIT_USER_DATA_DIR: join(root, "user-data") });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
});

afterAll(async () => {
  await app?.close().catch(() => {});
  await stopEngine(engine);
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("Seni bekleyen and the collapsed rail", () => {
  /** The collapsed strip's width with nothing waiting, per window size. */
  const stripWidth: Record<string, number> = {};

  it("0. connects and opens a project", async () => {
    await page.getByLabel("Motor adresi").fill(engine!.url);
    await page.getByLabel("Anahtar").fill(KEY);
    await page.getByRole("button", { name: "Bağlan" }).click();
    await rail().getByRole("button", { name: PLAIN_PROJECT, exact: true }).click({ timeout: UI_TIMEOUT_MS });
    await expect.poll(headerTitle, { timeout: UI_TIMEOUT_MS }).toBe(PLAIN_PROJECT);
    await page.locator(".kp-layout").waitFor({ timeout: UI_TIMEOUT_MS });
  });

  for (const count of COUNTS) {
    it(`${count} waiting: expanded and collapsed, at every window size`, async () => {
      await waitFor(count);
      const wrong: string[] = [];
      for (const size of WINDOWS) {
        const got = await setWindow(size);
        metrics[`${size.id}.window`] = got;
        for (const collapsed of [false, true]) {
          await setCollapsed(collapsed);
          const label = `${count}-${size.id}-${collapsed ? "dar" : "genis"}`;
          const g = await railGeometry();
          await shot(label);
          if (collapsed && count === 0) stripWidth[size.id] = g.rail.width;
          metrics[label] = { rail: g.rail, waiting: g.waiting, badge: g.badge, list: g.list, dock: g.dock, projectsHeading: g.projectsHeading, scrollWidth: g.scrollWidth, beyond: g.beyond };
          saveMetrics();
          for (const p of problems(g, { count, collapsed, stripWidth: stripWidth[size.id] ?? null })) wrong.push(`${label}: ${p}`);
        }
        await setCollapsed(false);
      }
      expect(wrong).toEqual([]);
    });
  }

  it("the badge names the count and lists the sessions; cut names are whole in the tooltip", async () => {
    await setWindow(WINDOWS[0]);
    await setCollapsed(false);
    const titles = await rail().locator(".kp-waiting__item").evaluateAll((rows) => rows.map((r) => r.getAttribute("title") ?? ""));
    expect(titles.some((t) => t.includes(UNBROKEN_TOOL) && t.includes(UNBROKEN_PROJECT))).toBe(true);
    await setCollapsed(true);
    const count = COUNTS.at(-1)!;
    expect(await badge().getAttribute("aria-label")).toBe(`${count} oturum seni bekliyor`);
    expect((await badge().textContent())?.trim()).toBe(String(count));
    const tip = (await badge().getAttribute("title")) ?? "";
    for (const name of [...PROJECT_NAMES, UNBROKEN_TOOL, "Claude"]) expect(tip).toContain(name);
  });

  it("the badge opens the list with the keyboard; the chosen session gets its terminal and the rail is a strip again", async () => {
    await setCollapsed(true);
    const strip = (await rail().boundingBox())!.width;
    await badge().focus();
    await page.keyboard.press("Enter");
    await collapseButton().waitFor({ timeout: UI_TIMEOUT_MS });
    // The focus is on the first waiting session: Enter jumps to it.
    const first = rail().locator(".kp-waiting__item").first();
    await expect.poll(() => first.evaluate((el) => el === document.activeElement), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await shot("rozet-acildi");
    // Longest waiting first: the first session opened.
    const target = opened[0]!;
    await page.keyboard.press("Enter");
    await expect.poll(headerTitle, { timeout: UI_TIMEOUT_MS }).toBe(projects.find((p) => p.id === target.projectId)!.name);
    const panel = page.locator(`section.kp-term[data-terminal-id="${target.id}"]`);
    await expect.poll(() => panel.evaluate((el) => el.contains(document.activeElement)), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await expandButton().waitFor({ timeout: UI_TIMEOUT_MS });
    expect((await rail().boundingBox())!.width).toBe(strip);
    await shot("rozet-terminale-gitti");

    // Answering there: one session fewer on the badge.
    await page.keyboard.type("1");
    await page.keyboard.press("Enter");
    const left = COUNTS.at(-1)! - 1;
    await expect.poll(() => badge().getAttribute("aria-label"), { timeout: UI_TIMEOUT_MS }).toBe(`${left} oturum seni bekliyor`);
  });

  it("clicking the badge and a session with the mouse does the same", async () => {
    await badge().click();
    const rows = rail().locator(".kp-waiting__item");
    await rows.first().waitFor({ timeout: UI_TIMEOUT_MS });
    const target = opened[1]!;
    await rows.first().click();
    const panel = page.locator(`section.kp-term[data-terminal-id="${target.id}"]`);
    await expect.poll(() => panel.evaluate((el) => el.contains(document.activeElement)), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await expandButton().waitFor({ timeout: UI_TIMEOUT_MS });
  });
});
