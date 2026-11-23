// End-to-end for the SPEC-adim-2 UI flows: the built Kokpit app (Electron, via Playwright `_electron`)
// against a real engine child process with a temp config and a temp HOME holding a fake ~/.ssh.
// SSH goes through a fake ssh binary (engine tunable `sshBinary`) that records its argv and runs the
// remote command locally, so the remote folder and quoting are exercised for real.
// Steps run in order and share state.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "@kokpit/shared";
import type { ElectronApplication, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  engineRequest,
  escapeRe,
  launchApp,
  launchTerminal,
  SCREENSHOT_DIR,
  startEngine,
  stopEngine,
  xtermLines,
  xtermText,
  type EngineHandle,
} from "./harness.ts";
import { diagnoseFailures } from "./diagnostics.ts";

const KEY = randomBytes(32).toString("hex");
const UI_TIMEOUT_MS = 20_000;
const SSH_KEY_NAME = "id_e2e";
const LOCAL_PROJECT = "Yerel UI";
const SSH_HOST_NAME = "Uzak Kutu";
const SSH_HOSTNAME = "uzak.example";
const SSH_USER = "e2euser";
const SSH_PROJECT = "Uzak UI";
const MARKER_TOOL = "UI İşaret";
const MARKER_OUTPUT = "UI_TOOL_OK";
const MISSING_TOOL = "Eksik Araç";
/** Computed by the shell, so the typed install command itself never matches. */
const INSTALL_COMMAND = "echo INSTALL_$((6*7))";
const INSTALL_OUTPUT = /INSTALL_42/;

let root: string;
let home: string;
let localDir: string;
let remoteDir: string;
let argsFile: string;
let userDataDir: string;
let engine: EngineHandle | undefined;
let app: ElectronApplication | undefined;
let page: Page;

diagnoseFailures("adim2", () => ({ app, page, engine }));
let builtin: Project;

async function shot(name: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `adim2-${name}.png`) });
}

const rail = (): Locator => page.getByRole("navigation", { name: "Kokpit" });
const panels = (): Locator => page.locator("section.kp-term");
const form = (): Locator => page.locator("form.kp-settings__form");
const headerTitle = (): Promise<string | null> => page.locator(".kp-header__title").textContent();

async function openSettings(tab: "Projeler" | "Sunucular" | "Araçlar"): Promise<void> {
  if ((await page.getByRole("tablist", { name: "Ayarlar" }).count()) === 0) {
    await rail().getByRole("button", { name: "Ayarlar", exact: true }).click();
  }
  await page.getByRole("tab", { name: tab }).click();
  await expect.poll(() => page.getByRole("tab", { name: tab }).getAttribute("aria-selected"), { timeout: UI_TIMEOUT_MS }).toBe("true");
}

async function closeSettings(): Promise<void> {
  await page.getByRole("button", { name: "Geri", exact: true }).click();
  await expect.poll(() => rail().isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
}

async function fill(label: string, value: string): Promise<void> {
  await form().getByLabel(label, { exact: true }).fill(value);
}

async function choose(label: string, optionLabel: string): Promise<void> {
  await form().getByLabel(label, { exact: true }).selectOption({ label: optionLabel });
}

async function save(): Promise<void> {
  await form().getByRole("button", { name: "Kaydet" }).click();
  await expect.poll(() => form().count(), { timeout: UI_TIMEOUT_MS }).toBe(0);
}

async function selectProject(name: string): Promise<void> {
  await rail().getByRole("button", { name, exact: true }).click();
  await expect.poll(headerTitle, { timeout: UI_TIMEOUT_MS }).toBe(name);
}

async function newTerminal(command = ""): Promise<Locator> {
  const before = await panels().count();
  await launchTerminal(page, command);
  await expect.poll(() => panels().count(), { timeout: UI_TIMEOUT_MS }).toBe(before + 1);
  return panels().last();
}

/** A line printed by the program (not the echoed command line, which carries a prompt and `echo`). */
async function waitForLine(panel: Locator, line: string): Promise<void> {
  await expect
    .poll(async () => (await xtermLines(panel)).some((l) => l.trim() === line), { timeout: UI_TIMEOUT_MS, interval: 100 })
    .toBe(true);
}

async function waitForText(panel: Locator, re: RegExp): Promise<void> {
  await expect.poll(() => xtermText(panel), { timeout: UI_TIMEOUT_MS, interval: 100 }).toMatch(re);
}

function toolRow(name: string): Locator {
  return page.locator("li.kp-item").filter({ has: page.getByRole("heading", { name, exact: true }) });
}

beforeAll(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e2-")));
  home = join(root, "home");
  localDir = join(root, "yerel klasör");
  remoteDir = join(root, "uzak 'klasör'");
  argsFile = join(root, "ssh-args.txt");
  userDataDir = join(root, "user-data");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  mkdirSync(localDir);
  mkdirSync(remoteDir);
  writeFileSync(join(home, ".ssh", SSH_KEY_NAME), "not a real key\n", { mode: 0o600 });
  writeFileSync(join(home, ".ssh", `${SSH_KEY_NAME}.pub`), "ssh-ed25519 AAAA e2e\n");
  writeFileSync(join(home, ".ssh", "known_hosts"), "");

  // Fake ssh: record argv, then run the remote command (last argument) locally.
  const fakeSsh = join(root, "fake-ssh");
  writeFileSync(fakeSsh, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nfor last; do :; done\nSHELL=/bin/sh exec /bin/sh -c "$last"\n`);
  chmodSync(fakeSsh, 0o755);

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
      sshBinary: fakeSsh,
    }),
  );
  engine = await startEngine(configPath, KEY, { HOME: home });
  // Never start the seeded global default tool (claude): unset tools must mean a plain shell here.
  await engineRequest(engine.url, KEY, "settings.update", { defaultToolId: null });
  const { projects } = (await engineRequest(engine.url, KEY, "projects.list", {})) as { projects: Project[] };
  builtin = projects.find((p) => p.builtin)!;
  expect(builtin).toBeTruthy();

  app = await launchApp({ KOKPIT_USER_DATA_DIR: userDataDir });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
});

afterAll(async () => {
  await app?.close().catch(() => {});
  await stopEngine(engine);
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("Adım 2 UI end-to-end", () => {
  it("0. connects to the engine; the built-in project is in the rail", async () => {
    await page.getByLabel("Motor adresi").fill(engine!.url);
    await page.getByLabel("Anahtar").fill(KEY);
    await page.getByRole("button", { name: "Bağlan" }).click();
    await expect.poll(() => rail().getByText(builtin.name, { exact: true }).isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
  });

  it("1. a local project added in Ayarlar opens a cardless terminal running its default tool", async () => {
    await openSettings("Araçlar");
    await page.getByRole("button", { name: "Araç ekle" }).click();
    await fill("Ad", MARKER_TOOL);
    await fill("Komut", `echo ${MARKER_OUTPUT}`);
    await save();
    await expect.poll(() => toolRow(MARKER_TOOL).count(), { timeout: UI_TIMEOUT_MS }).toBe(1);

    await openSettings("Projeler");
    await page.getByRole("button", { name: "Proje ekle" }).click();
    await fill("Ad", LOCAL_PROJECT);
    await fill("Klasör yolu", localDir);
    await choose("Varsayılan araç", MARKER_TOOL);
    await shot("01-project-form");
    await save();
    await closeSettings();

    await selectProject(LOCAL_PROJECT);
    // No header row: the location is the project tab's tooltip.
    const tab = page.getByRole("toolbar", { name: "Proje sekmeleri" }).getByRole("button", { name: LOCAL_PROJECT, exact: true });
    expect(await tab.getAttribute("title")).toContain(localDir);
    const panel = await newTerminal();
    await waitForLine(panel, MARKER_OUTPUT);
    expect(await rail().getByRole("button", { name: `Yeni kart: ${LOCAL_PROJECT}` }).count()).toBe(1);
    await shot("02-local-terminal-tool");
  });

  it("2. an ssh host with a key from the list + an ssh project open a terminal in the remote folder", async () => {
    await openSettings("Sunucular");
    await page.getByRole("button", { name: "Sunucu ekle" }).click();
    await fill("Ad", SSH_HOST_NAME);
    await fill("Adres", SSH_HOSTNAME);
    await fill("Kullanıcı", SSH_USER);
    const keyOptions = await form().getByLabel("Anahtar", { exact: true }).locator("option").allTextContents();
    expect(keyOptions).toContain(SSH_KEY_NAME);
    expect(keyOptions).not.toContain("known_hosts");
    await choose("Anahtar", SSH_KEY_NAME);
    await save();
    await expect.poll(() => page.getByText(SSH_HOST_NAME, { exact: true }).count(), { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(0);
    await shot("03-servers");

    await openSettings("Projeler");
    await page.getByRole("button", { name: "Proje ekle" }).click();
    await fill("Ad", SSH_PROJECT);
    await form().getByLabel("SSH sunucusu", { exact: true }).check();
    await choose("Sunucu", SSH_HOST_NAME);
    await fill("Uzak klasör", remoteDir);
    await save();
    await closeSettings();

    await selectProject(SSH_PROJECT);
    expect(await rail().getByRole("button", { name: `Yeni kart: ${SSH_PROJECT}` }).count()).toBe(0);
    const panel = await newTerminal("pwd");
    // `pwd` never contains the path itself, and a long path may soft-wrap across rows.
    await waitForText(panel, new RegExp(escapeRe(remoteDir)));
    const argv = readFileSync(argsFile, "utf8").split("\n");
    expect(argv).toContain(`${SSH_USER}@${SSH_HOSTNAME}`);
    expect(argv).toContain(join(home, ".ssh", SSH_KEY_NAME));
    await shot("04-ssh-terminal");
  });

  it("3. a missing tool shows 'kurulu değil'; 'Kur' opens its install terminal in the built-in project", async () => {
    await openSettings("Araçlar");
    await page.getByRole("button", { name: "Araç ekle" }).click();
    await fill("Ad", MISSING_TOOL);
    await fill("Komut", "eksik-arac");
    await fill("Kurulum komutu", INSTALL_COMMAND);
    await fill("Kontrol komutu", "false");
    await save();
    await expect
      .poll(() => toolRow(MISSING_TOOL).locator(".kp-badge").textContent(), { timeout: UI_TIMEOUT_MS })
      .toBe("kurulu değil");
    await shot("05-tool-missing");

    await page.getByRole("button", { name: `Kur: ${MISSING_TOOL}` }).click();
    await expect.poll(headerTitle, { timeout: UI_TIMEOUT_MS }).toBe(builtin.name);
    await waitForText(panels().last(), INSTALL_OUTPUT);
    await shot("06-install-terminal");
  });

  it("4. the built-in project offers no 'Yeni kart'", async () => {
    await selectProject(builtin.name);
    const group = rail().getByRole("group", { name: builtin.name });
    expect(await group.getByRole("button", { name: /Yeni kart/ }).count()).toBe(0);
    await shot("07-builtin-no-cards");
  });
});
