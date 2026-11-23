// İş W — Akış end-to-end: the built app (Electron, Playwright `_electron`) against a real engine.
// A temp project holds docs/akis fixtures: a real flow Mermaid must draw (as an SVG image) and a malicious one
// (init directive asking for "loose", HTML/script labels, click callbacks, javascript: links) that must not run
// anything nor reach window.kokpit. "Akışı çiz / güncelle" runs the engine's default command — `claude` with the
// shipped prompt — against a fake `claude` on PATH that records its prompt and writes a new flow file.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "@kokpit/shared";
import type { ElectronApplication, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clickMenu, engineRequest, launchApp, menuItem, SCREENSHOT_DIR, startEngine, stopEngine, xtermText, type EngineHandle } from "./harness.ts";
import { diagnoseFailures } from "./diagnostics.ts";

const KEY = randomBytes(32).toString("hex");
const UI_TIMEOUT_MS = 20_000;
const FLOW_PROJECT = "Akışlı";
const EMPTY_PROJECT = "Akışsız";
const SSH_PROJECT = "Uzak Akış";
const LABEL = "KOKPIT-AKIS-E2E";
const NEW_TITLE = "Yeni çizilen akış";
const PROMPT_HEAD = "Bu projenin ana iş akışlarını";

const GOOD_FLOW = `%% title: Giriş akışı
flowchart TD
  A([Başla]) --> B[${LABEL}]
  B --> C{Şifre doğru mu?}
  C -- Evet --> D[Oturum aç]
  C -- Hayır --> E[Hata göster]
`;

const EVIL_FLOW = `%% title: Kötü niyetli
%%{init: {"securityLevel": "loose", "htmlLabels": true, "flowchart": {"htmlLabels": true}}}%%
flowchart TD
  A["<img src=x onerror='window.__pwned=1'>resim"] --> B["<script>window.__pwned=2</script>betik"]
  B --> C[bağlantı]
  C --> D["<a href='javascript:window.__pwned=5'>a</a>"]
  click A callback "geri çağırma"
  click B call pwn()
  click C "javascript:window.__pwned=3" _self
`;

let root: string;
let emptyDir: string;
let promptLog: string;
let engine: EngineHandle | undefined;
let app: ElectronApplication | undefined;
let page: Page;

diagnoseFailures("flow", () => ({ app, page, engine }));

const rail = (): Locator => page.getByRole("navigation", { name: "Kokpit" });
const flowPanel = (): Locator => page.getByRole("region", { name: "Akış", exact: true });
const flowImage = (): Locator => flowPanel().locator("img.kp-flow__img");

/** İş D: layouts are per project — a panel opened in one project is not open in the next; open it here too. */
async function openPanelHere(name: string): Promise<void> {
  await expect.poll(() => menuItem(app!, ["Görünüm", name]), { timeout: UI_TIMEOUT_MS }).toEqual({ checked: false, enabled: true });
  await clickMenu(app!, ["Görünüm", name]);
}

async function shot(name: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `akis-${name}.png`) });
}

async function selectProject(name: string): Promise<void> {
  await rail().getByRole("button", { name, exact: true }).click();
  await expect.poll(() => page.locator(".kp-header__title").textContent(), { timeout: UI_TIMEOUT_MS }).toBe(name);
}

/** The drawn SVG: the image's data: URL decoded, once the image has really loaded. */
async function drawnSvg(): Promise<string> {
  return flowImage().evaluate(async (img: HTMLImageElement) => {
    if (!img.complete) await img.decode().catch(() => {});
    if (img.naturalWidth === 0) return "";
    return decodeURIComponent(img.src.slice(img.src.indexOf(",") + 1));
  });
}

/** Visible text of an SVG (Mermaid splits labels into one tspan per word). */
const svgText = (svg: string): string => svg.replace(/<style>[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, "");
const drawnText = async (): Promise<string> => svgText(await drawnSvg());

const pwned = (): Promise<unknown> => page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned);

function writeAt(path: string, content: string, mtimeSec: number): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  utimesSync(path, mtimeSec, mtimeSec);
}

beforeAll(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-flow-")));
  const flowDir = join(root, "akisli");
  emptyDir = join(root, "akissiz");
  const bin = join(root, "bin");
  promptLog = join(root, "claude-prompt.txt");
  mkdirSync(join(root, "home"));
  mkdirSync(emptyDir);
  mkdirSync(bin);
  writeAt(join(flowDir, "docs", "akis", "giris.mmd"), GOOD_FLOW, 1_800_000_000);
  writeAt(join(flowDir, "docs", "akis", "kotu.mmd"), EVIL_FLOW, 1_700_000_000);
  writeAt(join(flowDir, "docs", "akis", "notlar.md"), "# akış değil", 1_900_000_000);

  // Fake claude: records its prompt, writes one flow where it runs, says so, exits.
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh
printf '%s' "$1" > '${promptLog}'
mkdir -p docs/akis
printf '%%%% title: ${NEW_TITLE}\\nflowchart LR\\n  X[Yeni] --> Y{Tamam mı?}\\n' > docs/akis/yeni.mmd
echo "FAKE-CLAUDE-OK $(printf '%s' "$1" | head -n 1 | cut -d' ' -f1-3)"
`,
  );
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
    }),
  );
  engine = await startEngine(configPath, KEY, { HOME: join(root, "home"), PATH: `${bin}:${process.env.PATH ?? ""}` });
  // Never start the seeded global default tool.
  await engineRequest(engine.url, KEY, "settings.update", { defaultToolId: null });
  await engineRequest(engine.url, KEY, "projects.create", { name: FLOW_PROJECT, location: { kind: "local", path: flowDir } });
  await engineRequest(engine.url, KEY, "projects.create", { name: EMPTY_PROJECT, location: { kind: "local", path: emptyDir } });
  const { host } = (await engineRequest(engine.url, KEY, "sshHosts.create", { name: "Kutu", hostname: "kutu.example" })) as {
    host: { id: string };
  };
  const { project } = (await engineRequest(engine.url, KEY, "projects.create", {
    name: SSH_PROJECT,
    location: { kind: "ssh", hostId: host.id, path: flowDir },
  })) as { project: Project };
  expect(project.location.kind).toBe("ssh");

  app = await launchApp({ KOKPIT_USER_DATA_DIR: join(root, "user-data") });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.getByLabel("Motor adresi").fill(engine.url);
  await page.getByLabel("Anahtar").fill(KEY);
  await page.getByRole("button", { name: "Bağlan" }).click();
  await rail().getByText(FLOW_PROJECT, { exact: true }).waitFor({ timeout: UI_TIMEOUT_MS });
});

afterAll(async () => {
  await app?.close().catch(() => {});
  await stopEngine(engine);
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("Akış UI end-to-end", () => {
  it("1. Görünüm › Akış lists the project's flows and Mermaid draws the newest as an SVG image", async () => {
    await selectProject(FLOW_PROJECT);
    // Hidden in the default layout.
    expect(await flowPanel().count()).toBe(0);
    await clickMenu(app!, ["Görünüm", "Akış"]); // İş M: Görünüm is the native menu
    await expect.poll(() => flowPanel().isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    const options = flowPanel().getByRole("option");
    await expect.poll(() => options.count(), { timeout: UI_TIMEOUT_MS }).toBe(2);
    expect(await options.first().textContent()).toContain("Giriş akışı");
    expect(await flowPanel().getByText("notlar.md").count()).toBe(0);
    await expect.poll(drawnText, { timeout: UI_TIMEOUT_MS }).toContain(LABEL);
    const svg = await drawnSvg();
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svgText(svg)).toContain("Şifre doğru mu?");
    const box = await flowImage().boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(50);
    await shot("01-panel");
  });

  it("2. zoom and Tam ekran", async () => {
    await flowPanel().getByRole("button", { name: "Yakınlaştır" }).click();
    expect(await flowImage().evaluate((img) => (img.parentElement as HTMLElement).style.transform)).toContain("scale(1.25)");
    await flowPanel().getByRole("button", { name: "Sığdır" }).click();
    await flowPanel().getByRole("button", { name: "Tam ekran" }).click();
    const box = await flowPanel().boundingBox();
    const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    expect(box?.width).toBeGreaterThanOrEqual(size.width - 1);
    expect(box?.height).toBeGreaterThanOrEqual(size.height - 1);
    await shot("02-tam-ekran");
    await flowPanel().getByRole("button", { name: "Tam ekrandan çık" }).click();
  });

  it("3. a malicious flow runs nothing and cannot reach window.kokpit", async () => {
    // The bridge exists in the app's own page; a planted global is what a click callback would call.
    expect(await page.evaluate(() => typeof (window as unknown as { kokpit?: unknown }).kokpit)).toBe("object");
    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      w.callback = () => (w.__pwned = "callback");
      w.pwn = () => (w.__pwned = "pwn");
    });
    await flowPanel().getByRole("option", { name: /Kötü niyetli/ }).click();
    await expect.poll(drawnText, { timeout: UI_TIMEOUT_MS }).toContain("bağlantı");
    const svg = await drawnSvg();
    expect(svg).not.toMatch(/<script/i);
    expect(svg).not.toMatch(/onerror/i);
    expect(svg).not.toMatch(/javascript:/i);
    expect(svg).not.toMatch(/<foreignObject/i);
    // Clicks land on an image: nothing is wired to them.
    const box = (await flowImage().boundingBox())!;
    for (const [fx, fy] of [[0.5, 0.15], [0.5, 0.4], [0.5, 0.65], [0.5, 0.9]] as const) {
      await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
    }
    await page.waitForTimeout(500);
    expect(await pwned()).toBeUndefined();
    // Nothing from the diagram became markup in the page, and the app still has only its own scripts.
    expect(await flowPanel().locator("svg, script, foreignObject, a[href^='javascript:']").count()).toBe(0);
    expect(await page.evaluate(() => document.querySelectorAll("[onerror]").length)).toBe(0);
    await shot("03-kotu-niyetli");
  });

  it("4. an empty project explains; Akışı çiz / güncelle starts claude with the shipped prompt and the new flow appears", async () => {
    await selectProject(EMPTY_PROJECT);
    await openPanelHere("Akış");
    await expect.poll(() => flowPanel().getByText(/henüz akış şeması yok/).isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    const cmd = await flowPanel().locator(".kp-flow__cmd").textContent();
    expect(cmd).toMatch(/^claude "\$\(cat '.*akis-ciz\.md'\)"$/);
    await shot("04-bos");
    await flowPanel().getByRole("button", { name: "Akışı çiz / güncelle" }).first().click();
    const terminal = page.locator("section.kp-term").last();
    await expect.poll(() => xtermText(terminal), { timeout: UI_TIMEOUT_MS, interval: 100 }).toContain("FAKE-CLAUDE-OK Bu projenin ana");
    await shot("05-ciz-terminali");
    // The fake claude got the whole prompt as its argument.
    expect(existsSync(promptLog)).toBe(true);
    const prompt = readFileSync(promptLog, "utf8");
    expect(prompt.startsWith(PROMPT_HEAD)).toBe(true);
    expect(prompt).toContain("docs/akis");
    expect(prompt).toContain("%% title:");
    // Back on Akış: the file it wrote shows up by itself and is drawn.
    await expect.poll(() => flowPanel().getByRole("option", { name: new RegExp(NEW_TITLE) }).count(), { timeout: UI_TIMEOUT_MS }).toBe(1);
    await expect.poll(drawnText, { timeout: UI_TIMEOUT_MS }).toContain("Tamam mı?");
    await shot("06-yeni-akis");
  });

  it("5. ssh projects get a note and no button", async () => {
    await selectProject(SSH_PROJECT);
    await openPanelHere("Akış");
    await expect.poll(() => flowPanel().getByText(/SSH projelerinde Akış yok/).isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    expect(await flowPanel().getByRole("button", { name: "Akışı çiz / güncelle" }).count()).toBe(0);
    await shot("07-ssh");
  });
});
