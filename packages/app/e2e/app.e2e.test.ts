// End-to-end: the built Kokpit app (Electron, via Playwright `_electron`) against a real engine
// child process with a temp config, temp data dir and temp git repo. Steps run in order and share
// state; each maps to SPEC-adim-1 "Uygulama" / "Bitti sayılır".
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  engineRequest,
  escapeRe,
  git,
  launchApp,
  launchTerminal,
  SCREENSHOT_DIR,
  sleep,
  startEngine,
  stopEngine,
  xtermLines,
  xtermText,
  type EngineHandle,
} from "./harness.ts";
import { diagnoseFailures } from "./diagnostics.ts";

const KEY = randomBytes(32).toString("hex");
const WRONG_KEY = randomBytes(32).toString("hex");
const PROJECT_NAME = "E2E Proje";
const CARD_ONE = "İlk kart";
const CARD_TWO = "İkinci kart";
const UI_TIMEOUT_MS = 20_000;
/** Counter period in the long-running terminal command. */
const TICK_S = 0.5;
/** How long the app stays closed while the counter keeps running on the engine. */
const CLOSED_MS = 2_500;

let root: string;
let repo: string;
let dataDir: string;
let userDataDir: string;
let configPath: string;
let engine: EngineHandle | undefined;
let app: ElectronApplication | undefined;
let page: Page;

diagnoseFailures("app", () => ({ app, page, engine }));
/** Temp HOME: terminal shells never read the user's real rc files. */
const engineEnv = () => ({ HOME: join(root, "home") });

function writeEngineConfig(port: number): void {
  writeFileSync(
    configPath,
    JSON.stringify({
      dataDir,
      port,
      shell: "/bin/sh",
      shellArgs: [],
      listenTailscale: false,
      flushIntervalMs: 100,
      killGraceMs: 200,
      projects: [{ name: PROJECT_NAME, repoPath: repo, id: "e2e" }],
    }),
  );
}

async function openApp(): Promise<void> {
  app = await launchApp({ KOKPIT_USER_DATA_DIR: userDataDir });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
}

async function closeApp(): Promise<void> {
  const a = app;
  app = undefined;
  await a?.close();
}

async function shot(name: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `${name}.png`) });
}

const rail = (): Locator => page.getByRole("navigation", { name: "Kokpit" });
const panels = (): Locator => page.locator("section.kp-term");
const panelByTitle = (title: string): Locator => page.getByRole("region", { name: `Terminal: ${title}`, exact: true });
const banner = (): Locator => page.locator(".kp-banner");

async function connect(url: string, key: string): Promise<void> {
  await page.getByLabel("Motor adresi").fill(url);
  await page.getByLabel("Anahtar").fill(key);
  await page.getByRole("button", { name: "Bağlan" }).click();
}

async function selectCard(name: string): Promise<void> {
  await rail().getByRole("button", { name, exact: true }).click();
  await expect.poll(() => page.locator(".kp-header__title").textContent(), { timeout: UI_TIMEOUT_MS }).toBe(name);
}

async function openTerminal(command?: string): Promise<void> {
  const before = await panels().count();
  await launchTerminal(page, command);
  await expect.poll(() => panels().count(), { timeout: UI_TIMEOUT_MS }).toBe(before + 1);
}

async function typeInto(panel: Locator, text: string): Promise<void> {
  await panel.locator(".xterm").click();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

async function waitForText(panel: Locator, re: RegExp): Promise<string> {
  await expect.poll(() => xtermText(panel), { timeout: UI_TIMEOUT_MS, interval: 100 }).toMatch(re);
  return xtermText(panel);
}

/** Counter values `t<n>` printed on their own line in a panel. */
async function ticks(panel: Locator): Promise<number[]> {
  return (await xtermLines(panel)).flatMap((l) => {
    const m = /^t(\d+)$/.exec(l.trim());
    return m ? [Number(m[1])] : [];
  });
}

/** Worktree paths of the repo other than the main checkout. */
function cardWorktrees(): string[] {
  return git(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length))
    .filter((p) => p !== repo);
}

/** İş T: a terminal's state as its tab shows it (running / waiting / idle / exited). */
async function tabState(panel: Locator): Promise<string | null> {
  const id = await panel.getAttribute("data-terminal-id");
  return page.locator(`[role="tab"][id="kp-tab-${id}"]`).getAttribute("data-state");
}

async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await locator.boundingBox();
  if (!b) throw new Error("element has no box");
  return b;
}

async function setWindowSize(width: number, height: number): Promise<void> {
  await app!.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]!.setSize(w!, h!), [width, height]);
}

async function sttySize(panel: Locator, tag: string): Promise<{ rows: number; cols: number }> {
  await typeInto(panel, `echo ${tag}_$(stty size | tr ' ' x)`);
  const re = new RegExp(`${tag}_(\\d+)x(\\d+)`);
  const text = await waitForText(panel, re);
  const m = re.exec(text)!;
  return { rows: Number(m[1]), cols: Number(m[2]) };
}

beforeAll(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-")));
  repo = join(root, "repo");
  dataDir = join(root, "data");
  userDataDir = join(root, "user-data");
  configPath = join(root, "engine.json");
  mkdirSync(repo);
  mkdirSync(join(root, "home"));
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "e2e\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  writeEngineConfig(0);
  engine = await startEngine(configPath, KEY, engineEnv());
  // These scenarios type into plain shells; the seeded global default tool (claude) would take the input.
  await engineRequest(engine.url, KEY, "settings.update", { defaultToolId: null });
});

afterAll(async () => {
  await closeApp().catch(() => {});
  await stopEngine(engine);
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("Kokpit app end-to-end", () => {
  it("1. first launch asks for engine + key; a wrong key is rejected", async () => {
    await openApp();
    await expect.poll(() => page.getByRole("heading", { name: "Motora bağlan" }).isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await shot("01-connect");
    await connect(engine!.url, WRONG_KEY);
    await expect
      .poll(() => page.getByRole("status").filter({ hasText: "Anahtar reddedildi" }).isVisible(), { timeout: UI_TIMEOUT_MS })
      .toBe(true);
    // Back on the form, URL kept, key not echoed back.
    await expect.poll(() => page.getByLabel("Motor adresi").inputValue()).toBe(engine!.url);
    expect(await page.getByLabel("Anahtar").inputValue()).toBe("");
    await shot("02-wrong-key");
  });

  it("2. the right key opens the workbench with the project in the rail", async () => {
    await connect(engine!.url, KEY);
    await expect.poll(() => rail().getByText(PROJECT_NAME, { exact: true }).isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await expect.poll(() => banner().count(), { timeout: UI_TIMEOUT_MS }).toBe(0);
    await shot("03-workbench");
  });

  let wt1: string;

  it("3. 'Yeni kart' creates a git worktree + branch in the repo", async () => {
    expect(cardWorktrees()).toEqual([]);
    await rail().getByRole("button", { name: `Yeni kart: ${PROJECT_NAME}` }).click();
    await rail().getByLabel("Kart adı").fill(CARD_ONE);
    await rail().getByRole("button", { name: "Oluştur" }).click();
    await expect.poll(() => page.locator(".kp-header__title").textContent(), { timeout: UI_TIMEOUT_MS }).toBe(CARD_ONE);
    expect(await rail().getByRole("button", { name: CARD_ONE, exact: true }).getAttribute("aria-current")).toBe("true");

    const worktrees = cardWorktrees();
    expect(worktrees).toHaveLength(1);
    wt1 = worktrees[0]!;
    expect(wt1.startsWith(join(dataDir, "worktrees"))).toBe(true);
    const branchLine = (await page.locator(".kp-cardbar__branch").textContent())!;
    const branch = branchLine.split(" / ").at(-1)!.trim();
    expect(git(repo, "branch", "--list", branch)).toContain(branch);
    expect(git(wt1, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
    await shot("04-card-created");
  });

  const CMD_ONE = "echo PANEL_ONE; pwd";
  const CMD_TWO = "echo PANEL_TWO; pwd";

  it("4. two terminals side by side (tabs + Böl), both starting in the card's worktree", async () => {
    await openTerminal(CMD_ONE);
    await openTerminal(CMD_TWO);
    // İş T: each terminal is a tab, the newest active; "Böl" puts the other one next to it.
    const terminals = page.getByRole("region", { name: "Terminaller", exact: true });
    await terminals.getByRole("button", { name: "Böl", exact: true }).click();
    const one = panelByTitle(CMD_ONE);
    const two = panelByTitle(CMD_TWO);
    await expect.poll(() => one.isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await expect.poll(() => two.isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    // Left pane = the active tab (CMD_TWO); put CMD_ONE on the left as before.
    const tabOne = terminals.locator(`[role="tab"][data-title="${CMD_ONE}"]`);
    await tabOne.click();
    await expect.poll(() => tabOne.getAttribute("aria-selected"), { timeout: UI_TIMEOUT_MS }).toBe("true");
    const wtRe = new RegExp(escapeRe(wt1));
    await waitForText(one, /PANEL_ONE/);
    await waitForText(two, /PANEL_TWO/);
    // The path appears twice: never in the typed command, so once as `pwd` output (plus prompt-free sh).
    await waitForText(one, wtRe);
    await waitForText(two, wtRe);
    expect(await xtermText(one)).not.toContain("PANEL_TWO");
    expect(await xtermText(two)).not.toContain("PANEL_ONE");

    const a = await box(one);
    const b = await box(two);
    expect(Math.abs(a.y - b.y)).toBeLessThan(2); // same row
    expect(b.x).toBeGreaterThanOrEqual(a.x + a.width - 1); // side by side
    await shot("05-two-terminals");
  });

  let lastSeenTick = -1;

  it("5. a running command survives closing the app; output produced while closed is shown on relaunch", async () => {
    const one = panelByTitle(CMD_ONE);
    await typeInto(one, `i=0; while true; do echo t$i; i=$((i+1)); sleep ${TICK_S}; done`);
    await expect.poll(async () => Math.max(-1, ...(await ticks(one))), { timeout: UI_TIMEOUT_MS }).toBeGreaterThanOrEqual(2);
    lastSeenTick = Math.max(...(await ticks(one)));
    await closeApp();
    await sleep(CLOSED_MS);

    await openApp();
    // Saved settings: no connect screen, straight to the workbench.
    await expect.poll(() => rail().getByText(PROJECT_NAME, { exact: true }).isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    expect(await page.getByRole("heading", { name: "Motora bağlan" }).count()).toBe(0);
    await selectCard(CARD_ONE);
    await expect.poll(() => panels().count(), { timeout: UI_TIMEOUT_MS }).toBe(2);

    const relaunched = panelByTitle(CMD_ONE);
    const minWhileClosed = Math.floor(CLOSED_MS / 1000 / TICK_S) - 1;
    await expect
      .poll(async () => Math.max(-1, ...(await ticks(relaunched))), { timeout: UI_TIMEOUT_MS })
      .toBeGreaterThanOrEqual(lastSeenTick + minWhileClosed);
    // The value right after the last one seen before closing was printed while the app was closed.
    expect(await ticks(relaunched)).toContain(lastSeenTick + 1);
    const now = Math.max(...(await ticks(relaunched)));
    await expect.poll(async () => Math.max(...(await ticks(relaunched))), { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(now + 1);
    await shot("06-relaunched-counter");
  });

  let wt2: string;

  it("6. two cards never mix terminal output", async () => {
    await rail().getByRole("button", { name: `Yeni kart: ${PROJECT_NAME}` }).click();
    await rail().getByLabel("Kart adı").fill(CARD_TWO);
    await rail().getByRole("button", { name: "Oluştur" }).click();
    await expect.poll(() => page.locator(".kp-header__title").textContent(), { timeout: UI_TIMEOUT_MS }).toBe(CARD_TWO);
    wt2 = cardWorktrees().find((p) => p !== wt1)!;
    expect(wt2).toBeTruthy();
    expect(await panels().count()).toBe(0);

    // Markers are computed by the shell, so the typed command line itself never matches.
    await openTerminal("echo CARD_B_$((40+2))");
    await waitForText(panels().first(), /CARD_B_42/);

    await selectCard(CARD_ONE);
    await expect.poll(() => panels().count(), { timeout: UI_TIMEOUT_MS }).toBe(2);
    await typeInto(panelByTitle(CMD_TWO), "echo CARD_A_$((10+7))");
    await waitForText(panelByTitle(CMD_TWO), /CARD_A_17/);
    for (const p of await panels().all()) expect(await xtermText(p)).not.toContain("CARD_B_42");
    await shot("07-card-one");

    await selectCard(CARD_TWO);
    await expect.poll(() => panels().count(), { timeout: UI_TIMEOUT_MS }).toBe(1);
    await waitForText(panels().first(), /CARD_B_42/);
    expect(await xtermText(panels().first())).not.toContain("CARD_A_17");
    expect(await xtermText(panels().first())).not.toMatch(/PANEL_(ONE|TWO)/);
    await shot("08-card-two");

    await selectCard(CARD_ONE);
    await expect.poll(() => panels().count(), { timeout: UI_TIMEOUT_MS }).toBe(2);
    await waitForText(panelByTitle(CMD_TWO), /CARD_A_17/);
    for (const p of await panels().all()) expect(await xtermText(p)).not.toContain("CARD_B_42");
  });

  it("7. deleting a card with uncommitted changes is refused and the card stays", async () => {
    await selectCard(CARD_TWO);
    writeFileSync(join(wt2, "dirty.txt"), "uncommitted\n");
    await page.getByRole("button", { name: "Kartı sil" }).click();
    await page.getByRole("button", { name: "Silmeyi onayla" }).click();
    const alert = page.locator(".kp-cardbar__error");
    await expect.poll(() => alert.textContent(), { timeout: UI_TIMEOUT_MS }).toMatch(/dirty\.txt/);
    expect(await rail().getByRole("button", { name: CARD_TWO, exact: true }).isVisible()).toBe(true);
    expect(existsSync(wt2)).toBe(true);
    expect(cardWorktrees()).toContain(wt2);
    await shot("09-dirty-delete-refused");
  });

  it("8. engine loss shows the reconnect banner; on restart the panel re-attaches with history", async () => {
    const port = engine!.port;
    await stopEngine(engine, "SIGKILL");
    engine = undefined;
    await expect
      .poll(() => banner().textContent(), { timeout: UI_TIMEOUT_MS })
      .toContain("Motora ulaşılamıyor");
    await shot("10-reconnecting");

    writeEngineConfig(port);
    engine = await startEngine(configPath, KEY, engineEnv());
    expect(engine.port).toBe(port);
    await expect.poll(() => banner().count(), { timeout: UI_TIMEOUT_MS }).toBe(0);

    // Processes do not survive an engine restart; the re-attach reports that and replays history.
    const panel = panels().first();
    await expect.poll(() => tabState(panel), { timeout: UI_TIMEOUT_MS }).toBe("exited");
    await waitForText(panel, /CARD_B_42/);

    await selectCard(CARD_ONE);
    await expect.poll(() => panels().count(), { timeout: UI_TIMEOUT_MS }).toBe(2);
    const counter = panelByTitle(CMD_ONE);
    await expect.poll(async () => Math.max(-1, ...(await ticks(counter))), { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(lastSeenTick);
    await shot("11-reattached");
  });

  it("9. narrow window keeps the rail fixed on the left (İş L) and the dock shrinks; terminal size reaches the engine", async () => {
    await openTerminal();
    const term = panels().last();
    await expect.poll(() => tabState(term), { timeout: UI_TIMEOUT_MS }).toBe("running");
    const wide = await app!.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]!;
      return { size: w.getSize(), min: w.getMinimumSize() };
    });
    const [wideW, wideH] = wide.size as [number, number];
    const main = page.locator("main.kp-main");

    let r = await box(rail());
    let m = await box(main);
    expect(m.x).toBeGreaterThanOrEqual(r.x + r.width - 1);
    expect(Math.abs(m.y - r.y)).toBeLessThan(2);
    const wideMain = m.width;
    const before = await sttySize(term, "SZA");

    // The window cannot go below its minimum width; 700px is clamped to it.
    const narrowW = Math.max(700, wide.min[0]!);
    await setWindowSize(narrowW, wideH);
    await expect.poll(async () => (await box(main)).width, { timeout: UI_TIMEOUT_MS }).toBeLessThan(wideMain - 100);
    r = await box(rail());
    m = await box(main);
    expect(m.x).toBeGreaterThanOrEqual(r.x + r.width - 1); // still side by side
    expect(Math.abs(m.y - r.y)).toBeLessThan(2);
    await shot("12-narrow");

    await expect.poll(async () => {
      const after = await sttySize(term, `SZB${Date.now() % 100000}`);
      return after.cols !== before.cols || after.rows !== before.rows;
    }, { timeout: UI_TIMEOUT_MS, interval: 500 }).toBe(true);

    await setWindowSize(wideW, wideH);
    await expect.poll(async () => (await box(main)).x, { timeout: UI_TIMEOUT_MS }).toBeGreaterThan((await box(rail())).x + 10);
    r = await box(rail());
    m = await box(main);
    expect(m.x).toBeGreaterThanOrEqual(r.x + r.width - 1);
    expect(Math.abs(m.y - r.y)).toBeLessThan(2);
    await shot("13-wide");
  });
});
