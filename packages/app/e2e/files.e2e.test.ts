// İş F — Dosyalar end-to-end: the built app (Electron, Playwright `_electron`) against a real engine.
// A temp git repo is the project: browse the tree, preview text / big / binary files, `.git` hidden, a symlink
// to /etc not browsable, escapes refused by the engine. In the default layout the panel is a narrow column, so a
// clicked file opens in the large preview; Esc returns to the panel (files-media.e2e covers that and media files).
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { engineRequest, git, launchApp, SCREENSHOT_DIR, startEngine, stopEngine, type EngineHandle } from "./harness.ts";
import { diagnoseFailures } from "./diagnostics.ts";

const KEY = randomBytes(32).toString("hex");
const UI_TIMEOUT_MS = 20_000;
const PROJECT = "Dosyalı";
const SSH_PROJECT = "Uzak Dosyalar";
const SECRET = "KOKPIT-DOSYALAR-E2E-GIZLI";
const MAIN_TS = "export const merhaba = 'kokpit';\nconsole.log(merhaba);\n";
const MAX_READ = 1024;

let root: string;
let engine: EngineHandle | undefined;
let app: ElectronApplication | undefined;
let page: Page;

diagnoseFailures("files", () => ({ app, page, engine }));
let projectId: string;

const rail = (): Locator => page.getByRole("navigation", { name: "Kokpit" });
const panel = (): Locator => page.getByRole("region", { name: "Dosyalar", exact: true });
const tree = (): Locator => panel().getByRole("list", { name: "Dosya ağacı" });
const entry = (name: string): Locator => tree().getByRole("button", { name, exact: true });
const preview = (): Locator => panel().getByRole("region", { name: "Önizleme" });

const isLarge = (): Promise<boolean> => preview().evaluate((el) => el.classList.contains("kp-files__preview--large"));

/** Esc: from the large preview back to the panel (the file stays previewed under the tree). */
async function backToPanel(): Promise<void> {
  await expect.poll(isLarge, { timeout: UI_TIMEOUT_MS }).toBe(true);
  await page.keyboard.press("Escape");
  await expect.poll(isLarge, { timeout: UI_TIMEOUT_MS }).toBe(false);
}

async function shot(name: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `dosyalar-${name}.png`) });
}

async function selectProject(name: string): Promise<void> {
  await rail().getByRole("button", { name, exact: true }).click();
  await expect.poll(() => page.locator(".kp-header__title").textContent(), { timeout: UI_TIMEOUT_MS }).toBe(name);
}

beforeAll(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-files-")));
  const repo = join(root, "depo");
  mkdirSync(join(repo, "src", "lib"), { recursive: true });
  mkdirSync(join(root, "home"));
  writeFileSync(join(root, "gizli.txt"), SECRET);
  writeFileSync(join(repo, "README.md"), "# Dosyalı proje\n\nKokpit Dosyalar paneli deneme deposu.\n");
  writeFileSync(join(repo, "src", "main.ts"), MAIN_TS);
  writeFileSync(join(repo, "src", "lib", "util.ts"), "export const iki = 2;\n");
  writeFileSync(join(repo, "veri.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x0d, 0x0a]));
  writeFileSync(join(repo, "kayit.log"), "satır satır günlük\n".repeat(400));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "ilk");
  symlinkSync("/etc", join(repo, "etc-baglantisi"));
  symlinkSync(join(root, "gizli.txt"), join(repo, "kacis.txt"));

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
      files: { maxReadBytes: MAX_READ },
    }),
  );
  engine = await startEngine(configPath, KEY, { HOME: join(root, "home") });
  // Never start the seeded global default tool (claude).
  await engineRequest(engine.url, KEY, "settings.update", { defaultToolId: null });
  const created = (await engineRequest(engine.url, KEY, "projects.create", { name: PROJECT, location: { kind: "local", path: repo } })) as {
    project: { id: string };
  };
  projectId = created.project.id;
  const { host } = (await engineRequest(engine.url, KEY, "sshHosts.create", { name: "Kutu", hostname: "kutu.example" })) as {
    host: { id: string };
  };
  await engineRequest(engine.url, KEY, "projects.create", { name: SSH_PROJECT, location: { kind: "ssh", hostId: host.id, path: repo } });

  app = await launchApp({ KOKPIT_USER_DATA_DIR: join(root, "user-data") });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.getByLabel("Motor adresi").fill(engine.url);
  await page.getByLabel("Anahtar").fill(KEY);
  await page.getByRole("button", { name: "Bağlan" }).click();
  await rail().getByText(PROJECT, { exact: true }).waitFor({ timeout: UI_TIMEOUT_MS });
});

afterAll(async () => {
  await app?.close().catch(() => {});
  await stopEngine(engine);
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("Dosyalar UI end-to-end", () => {
  it("1. shows the project tree: folders first, .git hidden, outside links not browsable", async () => {
    await selectProject(PROJECT);
    await expect.poll(() => entry("src").isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    const names = await tree().locator(".kp-files__name").allTextContents();
    expect(names).toEqual(["src", "etc-baglantisi", "kacis.txt", "kayit.log", "README.md", "veri.bin"]);
    expect(await entry("etc-baglantisi").isDisabled()).toBe(true);
    expect(await entry("kacis.txt").isDisabled()).toBe(true);
    await panel().scrollIntoViewIfNeeded();
    await shot("01-agac");
  });

  it("2. expands a folder and previews a file read-only", async () => {
    await entry("src").click();
    await expect.poll(() => entry("main.ts").isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await entry("lib").click();
    await expect.poll(() => entry("util.ts").isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await entry("main.ts").click();
    await expect.poll(() => preview().locator("code").textContent(), { timeout: UI_TIMEOUT_MS }).toBe(MAIN_TS);
    expect(await preview().locator(".kp-files__gutter").textContent()).toBe("1\n2");
    expect(await preview().locator("textarea, input, [contenteditable='true']").count()).toBe(0);
    await shot("02-onizleme");
    await backToPanel();
  });

  it("3. big and binary files get notes", async () => {
    await entry("kayit.log").click();
    await expect.poll(() => preview().getByText(/Büyük dosya: ilk 1 KB gösteriliyor/).isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await shot("03-buyuk-dosya");
    await backToPanel();
    await entry("veri.bin").click();
    await expect.poll(() => preview().getByText(/İkili dosya/).isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    expect(await preview().locator("code").count()).toBe(0);
    await backToPanel();
  });

  it("4. Yenile picks up new files", async () => {
    writeFileSync(join(root, "depo", "src", "yeni.ts"), "// yeni\n");
    await panel().getByRole("button", { name: "Yenile" }).click();
    await expect.poll(() => entry("yeni.ts").isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
  });

  it("5. the engine refuses paths that leave the project", async () => {
    for (const path of ["../gizli.txt", "/etc/hosts", "kacis.txt", "etc-baglantisi/hosts"]) {
      await expect(engineRequest(engine!.url, KEY, "files.read", { projectId, path })).rejects.toThrow(/dışına/);
    }
    await expect(engineRequest(engine!.url, KEY, "files.read", { projectId, path: ".git/config" })).rejects.toThrow(/bulunamadı/);
    expect(await page.content()).not.toContain(SECRET);
  });

  it("6. ssh projects show a note instead of a tree", async () => {
    await selectProject(SSH_PROJECT);
    await expect.poll(() => panel().getByText(/SSH projelerinde Dosyalar yok/).isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    expect(await panel().getByRole("list", { name: "Dosya ağacı" }).count()).toBe(0);
  });

  it("7. returning to the project restores the open folders and the previewed file", async () => {
    await selectProject(PROJECT);
    await expect.poll(() => entry("veri.bin").getAttribute("aria-current"), { timeout: UI_TIMEOUT_MS }).toBe("true");
    // A restored file is shown in the panel, never opened large by itself.
    expect(await isLarge()).toBe(false);
    expect(await entry("src").getAttribute("aria-expanded")).toBe("true");
    expect(await entry("util.ts").isVisible()).toBe(true);
  });
});
