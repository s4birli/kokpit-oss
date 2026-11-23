// Helpers for the Electron end-to-end tests: a real engine child process, Electron launch,
// and reading xterm text from the DOM.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, type ElectronApplication, type Locator, type Page } from "playwright";
import { createClientHandshake } from "@kokpit/shared";

export const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
export const ENGINE_DIR = fileURLToPath(new URL("../../engine/", import.meta.url));
export const SCREENSHOT_DIR = fileURLToPath(new URL("./screenshots/", import.meta.url));
const ENGINE_STARTUP_TIMEOUT_MS = 20_000;
/** Background-agent polling is off unless a test turns it on: no test may run the real `claude agents`. */
const BG_AGENTS_OFF = { KOKPIT_BG_AGENTS_POLL_MS: "0" };
/**
 * İş M: no test may load the user's real sites (Ana sayfa, Wiki, …): the app starts with an empty site list
 * unless a test passes its own (local https pages). Test-only; ignored by a packaged app.
 */
const NO_WEB_SITES = { KOKPIT_TEST_WEB_SITES: "[]" };
/**
 * i18n: the suite runs the private configuration — Turkish app and engine — unless a test asks otherwise (the
 * English smoke test passes KOKPIT_TEST_LANGUAGE / KOKPIT_LANGUAGE "en"). The app's is a default (a language picked
 * in Ayarlar wins); test-only, ignored by a packaged app.
 */
export const TEST_LANGUAGE = "tr";
const APP_LANGUAGE = { KOKPIT_TEST_LANGUAGE: TEST_LANGUAGE };
const ENGINE_LANGUAGE = { KOKPIT_LANGUAGE: TEST_LANGUAGE };
/**
 * Adım 9 İş T: the engine sweeps (deletes old files in) its Playwright MCP output folder at startup. No test engine
 * may do that to — or hand terminals — the user's real `$TMPDIR/kokpit-playwright-mcp`: each gets a temp parent dir
 * (removed when the engine exits) unless the test passes its own ("" = named in the test's config file).
 */
const PLAYWRIGHT_OUTPUT_PARENT_ENV = "KOKPIT_PLAYWRIGHT_MCP_OUTPUT_PARENT_DIR";

/** A scalar of `electron-builder.yml` (no YAML dependency: first `key:` line at any indent). */
export function builderConfigValue(key: string): string {
  const yml = readFileSync(fileURLToPath(new URL("../electron-builder.yml", import.meta.url)), "utf8");
  const m = new RegExp(`^\\s*${key}:\\s*(.+)$`, "m").exec(yml);
  if (!m) throw new Error(`${key} missing in electron-builder.yml`);
  return m[1]!.trim();
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}

export interface EngineHandle {
  child: ChildProcess;
  host: string;
  port: number;
  url: string;
  log(): string;
}

function wsUrl(host: string, port: number): string {
  return `ws://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

/**
 * Starts `node src/main.ts` of the engine package and resolves once it logs "listening".
 * `extraEnv` (e.g. a temp HOME with a fake ~/.ssh) is layered over the test's environment. Terminal shells
 * get an empty temp ZDOTDIR (removed when the engine exits), so zsh never loads the user's real rc files.
 */
export function startEngine(configPath: string, key: string, extraEnv: Record<string, string> = {}): Promise<EngineHandle> {
  return new Promise((resolve, reject) => {
    const ownZdotdir = extraEnv.KOKPIT_TERMINAL_ZDOTDIR === undefined;
    const zdotdir = extraEnv.KOKPIT_TERMINAL_ZDOTDIR ?? realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-zdotdir-")));
    const ownOutputParent = extraEnv[PLAYWRIGHT_OUTPUT_PARENT_ENV] === undefined;
    const outputParent = extraEnv[PLAYWRIGHT_OUTPUT_PARENT_ENV] ?? realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-pw-output-")));
    const child = spawn(process.execPath, ["src/main.ts"], {
      cwd: ENGINE_DIR,
      env: {
        ...process.env,
        KOKPIT_TERMINAL_ZDOTDIR: zdotdir,
        ...BG_AGENTS_OFF,
        ...ENGINE_LANGUAGE,
        ...extraEnv,
        [PLAYWRIGHT_OUTPUT_PARENT_ENV]: outputParent,
        KOKPIT_CONFIG: configPath,
        KOKPIT_KEY: key,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (ownZdotdir) child.once("exit", () => rmSync(zdotdir, { recursive: true, force: true }));
    if (ownOutputParent) child.once("exit", () => rmSync(outputParent, { recursive: true, force: true }));
    let out = "";
    let err = "";
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      child.kill("SIGKILL");
      reject(new Error(`engine did not start:\n${out}\n${err}`));
    }, ENGINE_STARTUP_TIMEOUT_MS);
    child.stdout!.on("data", (d: Buffer) => {
      out += d.toString();
      if (done) return;
      for (const line of out.split("\n")) {
        if (!line.includes('"listening"')) continue;
        try {
          const entry = JSON.parse(line) as { addresses?: { host: string; port: number }[] };
          const addr = entry.addresses?.[0];
          if (!addr) continue;
          done = true;
          clearTimeout(timer);
          resolve({ child, host: addr.host, port: addr.port, url: wsUrl(addr.host, addr.port), log: () => out + err });
          return;
        } catch {
          /* partial line */
        }
      }
    });
    child.stderr!.on("data", (d: Buffer) => (err += d.toString()));
    child.on("exit", (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error(`engine exited early (${code ?? signal}):\n${out}\n${err}`));
    });
  });
}

export async function stopEngine(engine: EngineHandle | undefined, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  const child = engine?.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    // A paused engine (pauseEngine) would never see the signal.
    child.kill("SIGCONT");
    child.kill(signal);
  });
}

/**
 * Freezes the engine process: sockets still connect (the kernel accepts them) but nothing is answered, as on an
 * engine machine too busy to reply. Returns the function that lets it run again; call it in a `finally`.
 */
export function pauseEngine(engine: EngineHandle): () => void {
  engine.child.kill("SIGSTOP");
  return () => void engine.child.kill("SIGCONT");
}

/**
 * Yerel bağlantı: the app's one-click local-engine detection is off in tests, so no test reads this Mac's real
 * engine.json / engine.key or sees the real engine. local-connect.e2e turns it on with a temp HOME.
 */
export const LOCAL_ENGINE_DETECT_OFF = { KOKPIT_LOCAL_ENGINE_DETECT: "0" };

/** Environment for Electron without anything that would switch it to dev/Node mode. */
export function electronEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k === "ELECTRON_RENDERER_URL" || k === "ELECTRON_RUN_AS_NODE") continue;
    env[k] = v;
  }
  return { ...env, ...LOCAL_ENGINE_DETECT_OFF, ...extra };
}

/** Launches the built app (out/) from source, or a packaged binary when `executablePath` is given. */
export async function launchApp(env: Record<string, string>, executablePath?: string): Promise<ElectronApplication> {
  return _electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: [APP_DIR] }),
    cwd: APP_DIR,
    env: electronEnv({ ...NO_WEB_SITES, ...NO_EXTERNAL_BROWSER, ...APP_LANGUAGE, ...env }),
  });
}

/** İş M: a native menu item by its labels, e.g. ["Görünüm", "Ajanlar"]; read in the main process. */
export async function menuItem(app: ElectronApplication, path: readonly string[]): Promise<{ checked: boolean; enabled: boolean } | null> {
  return app.evaluate(({ Menu }, labels) => {
    let items = Menu.getApplicationMenu()?.items ?? [];
    let found: Electron.MenuItem | undefined;
    for (const label of labels) {
      found = items.find((i) => i.label === label);
      if (!found) return null;
      items = found.submenu?.items ?? [];
    }
    return found ? { checked: found.checked, enabled: found.enabled } : null;
  }, path);
}

/** İş M: clicks a native menu item (as the user would from the menu bar). */
export async function clickMenu(app: ElectronApplication, path: readonly string[]): Promise<void> {
  const ok = await app.evaluate(({ Menu, BrowserWindow }, labels) => {
    let items = Menu.getApplicationMenu()?.items ?? [];
    let found: Electron.MenuItem | undefined;
    for (const label of labels) {
      found = items.find((i) => i.label === label);
      if (!found) return false;
      items = found.submenu?.items ?? [];
    }
    if (!found?.enabled) return false;
    const win = BrowserWindow.getAllWindows()[0];
    found.click(undefined, win, win?.webContents);
    return true;
  }, path);
  if (!ok) throw new Error(`menu item ${path.join(" › ")} not found or disabled`);
}

/**
 * Bağlantılar: no test may open the user's real default browser. Every address the app would hand to it is kept in
 * the main process instead (`externalOpens`). Test-only; ignored by a packaged app.
 */
const NO_EXTERNAL_BROWSER = { KOKPIT_TEST_EXTERNAL_OPEN: "record" };
/** The addresses the app "opened in the default browser" since the last call (recorded, never opened). */
export async function externalOpens(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => ((globalThis as unknown as { __kokpitExternalOpens?: string[] }).__kokpitExternalOpens ?? []).splice(0));
}

/** The Terminal panel's launcher (Araç, Başlangıç komutu, Yeni terminal): its menu, or its empty state. */
export const terminalLauncher = (page: Page): Locator => page.getByRole("group", { name: "Yeni terminal" });

/**
 * Opens a terminal the only way the app offers: the Terminal panel's launcher. An empty panel shows it already;
 * otherwise "+ Yeni terminal ▾" opens it. An empty `command` starts the tool chosen in the picker.
 */
export async function launchTerminal(page: Page, command = ""): Promise<void> {
  const launcher = terminalLauncher(page);
  if ((await launcher.count()) === 0) await page.getByRole("button", { name: "+ Yeni terminal ▾" }).click();
  await launcher.getByLabel("Başlangıç komutu").fill(command);
  await launcher.getByRole("button", { name: "Yeni terminal", exact: true }).click();
}

/** Visible lines of an xterm panel, read from its DOM renderer. */
export async function xtermLines(panel: Locator): Promise<string[]> {
  return panel
    .locator(".xterm-rows")
    .evaluate((el) => Array.from(el.children, (row) => (row.textContent ?? "").replace(/ /g, " ").trimEnd()));
}

/**
 * Visible text of an xterm panel with rows concatenated, so a line soft-wrapped across rows
 * (e.g. a long path) still matches as one string.
 */
export async function xtermText(panel: Locator): Promise<string> {
  return (await xtermLines(panel)).join("");
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** One request to the engine over its WebSocket (hello, req, res), outside the app. Rejects on an engine error. */
export function engineRequest(url: string, key: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    // The mutual handshake: the key never crosses the wire, and nothing is asked before the engine proved itself.
    const handshake = createClientHandshake({ kind: "key", key });
    let authed = false;
    let steps = Promise.resolve();
    ws.addEventListener("open", () => ws.send(JSON.stringify(handshake.hello())));
    ws.addEventListener("error", () => reject(new Error(`engine request ${method}: socket error`)));
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        type: string;
        id?: number;
        ok?: boolean;
        result?: unknown;
        error?: { message: string };
      };
      if (!authed) {
        steps = steps.then(async () => {
          // A frame that came in while the engine's hello.ok was still being verified (e.g. a browser.changed
          // broadcast to every client) is not part of the handshake: handing it on failed the request ("protocol").
          if (authed) return;
          const step = await handshake.receive(msg);
          if (step.kind === "send") ws.send(JSON.stringify(step.frame));
          else if (step.kind === "fail") reject(new Error(`engine request ${method}: handshake ${step.reason}`));
          else {
            authed = true;
            ws.send(JSON.stringify({ type: "req", id: 1, method, params }));
          }
        });
        return;
      }
      if (msg.type !== "res" || msg.id !== 1) return;
      ws.close();
      if (msg.ok) resolve(msg.result);
      else reject(new Error(`engine request ${method}: ${msg.error?.message ?? "failed"}`));
    });
  });
}
