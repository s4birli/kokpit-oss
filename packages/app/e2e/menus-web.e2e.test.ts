// İş M — Menüler ve web sekmeleri end-to-end: the built app (Electron, Playwright `_electron`) against a real engine.
// The native menu bar is driven from the main process (Menu.getApplicationMenu() … click()). The "sites" are local
// https test pages (self-signed certificate, trusted only through the test-only env flag for 127.0.0.1) given through
// the test-only site list override; the user's real sites are never loaded.
// Plain http (NAS panosu): a local http server on 127.0.0.1 stands in for the NAS's Tailscale address (loopback IP
// literals are inside the app's http allowance); the real NAS pages are never contacted.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clickMenu, engineRequest, launchApp, menuItem, SCREENSHOT_DIR, startEngine, stopEngine, type EngineHandle } from "./harness.ts";
import { diagnoseFailures } from "./diagnostics.ts";

const KEY = randomBytes(32).toString("hex");
const UI_TIMEOUT_MS = 20_000;
const PROJECT = "Menü Projesi";
/** İş D: a second project, whose layout has no Web panel until it is opened there. */
const OTHER = "Öteki Menü Projesi";
const COOKIE = "kokpit_web_e2e";
const FIRST = "WEB-E2E-ILK-GIRIS";
const KEPT = "WEB-E2E-OTURUM-KORUNDU";

let root: string;
let engine: EngineHandle | undefined;
let server: https.Server | undefined;
let base: string;
/** The plain-http "NAS panosu" stand-in and every request it received (Host header + path). */
let httpServer: http.Server | undefined;
let httpBase: string;
let httpPort: number;
const httpHits: { host: string; path: string }[] = [];
const NAS_PANO = "nas-pano";
/** A public address that is never routed (TEST-NET-1): "http to a public address" without leaving the machine. */
const PUBLIC_HTTP = "http://192.0.2.1/";
let app: ElectronApplication | undefined;
let page: Page;

diagnoseFailures("menus-web", () => ({ app, page, engine }));

const rail = (): Locator => page.getByRole("navigation", { name: "Kokpit" });
const webPanel = (): Locator => page.locator("section.kp-web");
const siteStrip = (): Locator => webPanel().getByRole("group", { name: "Site sekmeleri" });
const activeSite = (): Promise<string | null> => siteStrip().locator('button[aria-pressed="true"]').textContent();
const siteTabs = (): Promise<string[]> => siteStrip().locator(".kp-browser__tab-select").allTextContents();
const dockTabs = async (): Promise<string[]> =>
  (await page.getByRole("tab").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""))).filter(Boolean).sort();

function testPage(site: string, cookie: string | undefined): string {
  const marker = cookie?.includes(`${COOKIE}=1`) ? KEPT : FIRST;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${site}</title>
<style>html,body{margin:0;height:100%;background:#246;color:#fff;font:24px sans-serif}</style></head>
<body><h1>${site.toUpperCase()} ${marker}</h1><p id="probe"></p>
<script>
  document.getElementById("probe").textContent =
    "kokpit:" + typeof window.kokpit + " require:" + typeof window.require + " process:" + typeof window.process;
</script></body></html>`;
}

function makeCert(dir: string): { key: Buffer; cert: Buffer } {
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=127.0.0.1"], {
    stdio: "ignore",
  });
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

/** `newDefaults`: sites a later version of the app adds to its defaults (the saved list must pick them up once). */
async function openApp(newDefaults: { id: string; title: string; url: string }[] = []): Promise<void> {
  app = await launchApp({
    KOKPIT_USER_DATA_DIR: join(root, "user-data"),
    KOKPIT_TEST_WEB_TRUST_HOST: "127.0.0.1",
    KOKPIT_TEST_WEB_SITES: JSON.stringify([
      { id: "home", title: "Ana sayfa", url: `${base}/home` },
      { id: "wiki", title: "Wiki", url: `${base}/wiki` },
      ...newDefaults,
    ]),
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
}

async function closeApp(): Promise<void> {
  await app?.close();
  app = undefined;
}

interface ViewState {
  url: string;
  text: string;
  visible: boolean | null;
  storagePath: string | null;
}

/** The web-site views main laid into the window (Playwright cannot see native views). */
async function webViews(): Promise<ViewState[]> {
  const all = await app!.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const out: { url: string; text: string; visible: boolean | null; storagePath: string | null }[] = [];
    for (const v of win?.contentView.children ?? []) {
      const wc = (v as unknown as { webContents?: Electron.WebContents }).webContents;
      if (!wc || wc.isDestroyed()) continue;
      const text = (await wc.executeJavaScript("document.body ? document.body.innerText : ''").catch(() => "")) as string;
      const getVisible = (v as unknown as { getVisible?: () => boolean }).getVisible;
      out.push({ url: wc.getURL(), text, visible: getVisible ? getVisible.call(v) : null, storagePath: wc.session.storagePath });
    }
    return out;
  });
  return all.filter((v) => /Partitions\/web-/.test(v.storagePath ?? ""));
}

const viewOf = async (site: string): Promise<ViewState | undefined> => (await webViews()).find((v) => v.storagePath?.endsWith(`Partitions/web-${site}`));

/** Runs `js` inside a site's page (as the page itself would). */
async function inView(site: string, js: string): Promise<void> {
  await app!.evaluate(
    async ({ BrowserWindow }, { suffix, code }) => {
      for (const v of BrowserWindow.getAllWindows()[0]!.contentView.children) {
        const wc = (v as unknown as { webContents?: Electron.WebContents }).webContents;
        if (wc && !wc.isDestroyed() && wc.session.storagePath?.endsWith(suffix)) await wc.executeJavaScript(code).catch(() => {});
      }
    },
    { suffix: `Partitions/web-${site}`, code: js },
  );
}

const hitsOn = (host: string): string[] => httpHits.filter((h) => h.host.startsWith(host)).map((h) => h.path);

async function shot(name: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `menus-web-${name}.png`) });
  // The native view is not in the page screenshot: capture the whole window from main.
  const png = await app!.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    const view = win.contentView.children.find(
      (c) => (c as unknown as { getVisible?: () => boolean; webContents?: unknown }).webContents && (c as unknown as { getVisible: () => boolean }).getVisible(),
    ) as Electron.WebContentsView | undefined;
    const img = await (view ?? win).webContents.capturePage();
    return img.toPNG().toString("base64");
  });
  writeFileSync(join(SCREENSHOT_DIR, `menus-web-${name}-view.png`), Buffer.from(png, "base64"));
}

beforeAll(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-menus-")));
  mkdirSync(join(root, "home"));
  mkdirSync(join(root, "proje"));
  mkdirSync(join(root, "oteki"));
  server = https.createServer(makeCert(root), (req, res) => {
    const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
    if (!req.headers.cookie?.includes(`${COOKIE}=1`)) headers["set-cookie"] = `${COOKIE}=1; Max-Age=3600; Path=/; Secure; HttpOnly; SameSite=Lax`;
    res.writeHead(200, headers);
    res.end(testPage((req.url ?? "/").replace(/^\//, "") || "root", req.headers.cookie));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // The http "NAS panosu": `/pano` answers 302 → `/login` like the real dashboard; `/disari` redirects to the
  // same server under a host NAME (not allowed over http); every page also asks for a picture from that name.
  httpServer = http.createServer((req, res) => {
    const path = req.url ?? "/";
    httpHits.push({ host: req.headers.host ?? "", path });
    if (path === "/pano") return void res.writeHead(302, { location: "/login" }).end();
    if (path === "/disari") return void res.writeHead(302, { location: `http://localhost:${httpPort}/gizli` }).end();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>NAS</title></head><body><h1>NAS-PANO ${path}</h1>` +
        `<img src="http://localhost:${httpPort}/piksel" alt=""><img src="/kendi-piksel" alt=""></body></html>`,
    );
  });
  await new Promise<void>((resolve) => httpServer!.listen(0, "127.0.0.1", resolve));
  httpPort = (httpServer.address() as AddressInfo).port;
  httpBase = `http://127.0.0.1:${httpPort}`;

  const configPath = join(root, "engine.json");
  writeFileSync(
    configPath,
    JSON.stringify({ dataDir: join(root, "data"), port: 0, shell: "/bin/sh", shellArgs: [], listenTailscale: false, flushIntervalMs: 100, killGraceMs: 200 }),
  );
  engine = await startEngine(configPath, KEY, { HOME: join(root, "home") });
  await engineRequest(engine.url, KEY, "settings.update", { defaultToolId: null });
  await engineRequest(engine.url, KEY, "projects.create", { name: PROJECT, location: { kind: "local", path: join(root, "proje") } });
  await engineRequest(engine.url, KEY, "projects.create", { name: OTHER, location: { kind: "local", path: join(root, "oteki") } });

  await openApp();
  await page.getByLabel("Motor adresi").fill(engine.url);
  await page.getByLabel("Anahtar").fill(KEY);
  await page.getByRole("button", { name: "Bağlan" }).click();
  await rail().waitFor({ timeout: UI_TIMEOUT_MS });
});

afterAll(async () => {
  await app?.close().catch(() => {});
  await stopEngine(engine);
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await new Promise<void>((resolve) => (httpServer ? httpServer.close(() => resolve()) : resolve()));
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("İş M: menüler ve web sekmeleri", () => {
  it("1. first launch: the Ana sayfa tab is open and active, isolated on its own partition", async () => {
    await expect.poll(activeSite, { timeout: UI_TIMEOUT_MS }).toBe("Ana sayfa");
    await expect.poll(async () => (await viewOf("home"))?.text ?? "", { timeout: UI_TIMEOUT_MS }).toContain(`HOME ${FIRST}`);
    const home = (await viewOf("home"))!;
    expect(home.url).toBe(`${base}/home`);
    expect(home.visible).toBe(true);
    expect(home.text).toContain("kokpit:undefined require:undefined process:undefined");
    expect(await dockTabs()).toContain("Web");
    expect(await menuItem(app!, ["Görünüm", "Web"])).toEqual({ checked: true, enabled: true });
    await shot("01-ilk-acilis");
  });

  it("2. the menu bar has Görünüm, Git and Yardım; the in-app Görünüm bar is gone", async () => {
    const labels = await app!.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items.map((i) => i.label));
    expect(labels).toEqual(expect.arrayContaining(["Görünüm", "Git", "Yardım"]));
    const git = await app!.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items.find((i) => i.label === "Git")!.submenu!.items.map((i) => i.label));
    expect(git.filter(Boolean)).toEqual(["Ana sayfa", "Wiki", "Siteleri düzenle…"]);
    expect(await page.getByRole("toolbar", { name: "Görünüm" }).count()).toBe(0);
  });

  it("3. Görünüm › Ajanlar closes and reopens the panel; the checkbox follows", async () => {
    await rail().getByRole("button", { name: PROJECT, exact: true }).click();
    await expect.poll(() => page.locator(".kp-header__title").textContent(), { timeout: UI_TIMEOUT_MS }).toBe(PROJECT);
    // The site tabs are not per project: Ana sayfa is still there.
    expect(await activeSite()).toBe("Ana sayfa");
    await expect.poll(dockTabs, { timeout: UI_TIMEOUT_MS }).toContain("Ajanlar");
    await clickMenu(app!, ["Görünüm", "Ajanlar"]);
    await expect.poll(dockTabs, { timeout: UI_TIMEOUT_MS }).not.toContain("Ajanlar");
    await expect.poll(async () => (await menuItem(app!, ["Görünüm", "Ajanlar"]))?.checked, { timeout: UI_TIMEOUT_MS }).toBe(false);
    await shot("02-ajanlar-kapali");
    await clickMenu(app!, ["Görünüm", "Ajanlar"]);
    await expect.poll(dockTabs, { timeout: UI_TIMEOUT_MS }).toContain("Ajanlar");
    await expect.poll(async () => (await menuItem(app!, ["Görünüm", "Ajanlar"]))?.checked, { timeout: UI_TIMEOUT_MS }).toBe(true);
  });

  it("4. Git › Wiki opens a second site tab; only the active site is on screen", async () => {
    await clickMenu(app!, ["Git", "Wiki"]);
    await expect.poll(activeSite, { timeout: UI_TIMEOUT_MS }).toBe("Wiki");
    expect(await siteTabs()).toEqual(["Ana sayfa", "Wiki"]);
    await expect.poll(async () => (await viewOf("wiki"))?.text ?? "", { timeout: UI_TIMEOUT_MS }).toContain("WIKI");
    await expect.poll(async () => (await viewOf("wiki"))?.visible, { timeout: UI_TIMEOUT_MS }).toBe(true);
    await expect.poll(async () => (await viewOf("home"))?.visible, { timeout: UI_TIMEOUT_MS }).toBe(false);
    await shot("03-wiki");
  });

  it("5. Görünüm and Yardım items reach the renderer as menu commands (font/zoom/Claude rehberi)", async () => {
    await page.evaluate(() => {
      const w = window as unknown as { __cmds: unknown[]; kokpit: { menu: { onCommand(l: (c: unknown) => void): () => void } } };
      w.__cmds = [];
      w.kokpit.menu.onCommand((c) => w.__cmds.push(c));
    });
    await clickMenu(app!, ["Görünüm", "Terminal yazısını büyüt"]);
    await clickMenu(app!, ["Görünüm", "Tarayıcıyı uzaklaştır"]);
    await clickMenu(app!, ["Yardım", "Claude komutları"]);
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __cmds: unknown[] }).__cmds), { timeout: UI_TIMEOUT_MS })
      .toEqual([{ type: "terminal.font.larger" }, { type: "browser.zoom.out" }, { type: "claude.help" }]);
  });

  it("6. Git › Siteleri düzenle… opens Ayarlar › Siteler; a new site appears in the Git menu; views step aside meanwhile", async () => {
    await clickMenu(app!, ["Git", "Siteleri düzenle…"]);
    await expect.poll(() => page.getByRole("tab", { name: "Siteler" }).getAttribute("aria-selected"), { timeout: UI_TIMEOUT_MS }).toBe("true");
    await expect.poll(async () => (await viewOf("wiki"))?.visible, { timeout: UI_TIMEOUT_MS }).toBe(false);
    const add = page.getByRole("group", { name: "Site ekle" });
    await add.getByLabel("Ad", { exact: true }).fill("Ek sayfa");
    // Plain http is refused for a host name and for a public address (each with its reason)…
    await add.getByLabel("Adres", { exact: true }).fill("http://ek.example.com/ek");
    await add.getByRole("button", { name: "Ekle" }).click();
    expect(await add.getByText(/Http:\/\/ yalnız IP adresiyle yazılan Tailscale\/yerel adresler için kabul edilir/).isVisible()).toBe(true);
    await add.getByLabel("Adres", { exact: true }).fill(PUBLIC_HTTP);
    await add.getByRole("button", { name: "Ekle" }).click();
    expect(await add.getByText(/Http:\/\/ yalnız Tailscale ve yerel adresler için kabul edilir/).isVisible()).toBe(true);
    expect(await page.getByRole("listitem").count()).toBe(2);
    await add.getByLabel("Adres", { exact: true }).fill(`${base}/ek`);
    await add.getByRole("button", { name: "Ekle" }).click();
    await page.getByRole("button", { name: "Kaydet" }).click();
    await expect.poll(() => page.getByRole("status").filter({ hasText: "Kaydedildi." }).count(), { timeout: UI_TIMEOUT_MS }).toBe(1);
    await shot("04-siteler");
    await expect.poll(() => menuItem(app!, ["Git", "Ek sayfa"]), { timeout: UI_TIMEOUT_MS }).toEqual({ checked: false, enabled: true });
    // Picking a site from Git leaves the settings and shows it.
    await clickMenu(app!, ["Git", "Ek sayfa"]);
    await expect.poll(activeSite, { timeout: UI_TIMEOUT_MS }).toBe("Ek sayfa");
    // A new site's id comes from its host — for an IP address the whole address and the port; its view has a
    // partition of its own.
    await expect.poll(async () => (await viewOf(`127-0-0-1-${new URL(base).port}`))?.text ?? "", { timeout: UI_TIMEOUT_MS }).toContain("EK");
    // Back to Wiki for the relaunch check.
    await clickMenu(app!, ["Git", "Wiki"]);
    await expect.poll(activeSite, { timeout: UI_TIMEOUT_MS }).toBe("Wiki");
  });

  it("7. relaunch: the tabs come back (Wiki active) and the sites are still logged in (cookie kept)", async () => {
    // Let the debounced UI state save land.
    await page.waitForTimeout(1000);
    await closeApp();
    // This launch's app also brings a NEW default site (as an update would): "NAS panosu" over plain http.
    await openApp([{ id: NAS_PANO, title: "NAS panosu", url: `${httpBase}/pano` }]);
    await rail().waitFor({ timeout: UI_TIMEOUT_MS });
    await expect.poll(activeSite, { timeout: UI_TIMEOUT_MS }).toBe("Wiki");
    expect(await siteTabs()).toEqual(["Ana sayfa", "Wiki", "Ek sayfa"]);
    await expect.poll(async () => (await viewOf("wiki"))?.text ?? "", { timeout: UI_TIMEOUT_MS }).toContain(`WIKI ${KEPT}`);
    // Not a first launch any more: Ana sayfa did not take over.
    expect(await activeSite()).toBe("Wiki");
    await shot("05-yeniden-acilis");
  });

  it("8. İş D: the Web panel's place is per project — a project without it takes the site view off screen; back in the first it returns, not reloaded", async () => {
    await expect.poll(async () => (await viewOf("wiki"))?.visible, { timeout: UI_TIMEOUT_MS }).toBe(true);
    const mark = `isaret-${Date.now()}`;
    await app!.evaluate(async ({ BrowserWindow }, value) => {
      for (const v of BrowserWindow.getAllWindows()[0]!.contentView.children) {
        const wc = (v as unknown as { webContents?: Electron.WebContents }).webContents;
        if (wc && !wc.isDestroyed() && wc.getURL().endsWith("/wiki")) await wc.executeJavaScript(`document.getElementById("probe").textContent = ${JSON.stringify(value)}`);
      }
    }, mark);
    await expect.poll(async () => (await viewOf("wiki"))?.text ?? "", { timeout: UI_TIMEOUT_MS }).toContain(mark);

    // The other project starts from the default layout: no Web panel, so no native view may stay over the dock.
    await rail().getByRole("button", { name: OTHER, exact: true }).click();
    await expect.poll(() => page.locator(".kp-header__title").textContent(), { timeout: UI_TIMEOUT_MS }).toBe(OTHER);
    await expect.poll(dockTabs, { timeout: UI_TIMEOUT_MS }).not.toContain("Web");
    await expect.poll(async () => (await webViews()).filter((v) => v.visible).length, { timeout: UI_TIMEOUT_MS }).toBe(0);
    await expect.poll(async () => (await menuItem(app!, ["Görünüm", "Web"]))?.checked, { timeout: UI_TIMEOUT_MS }).toBe(false);
    await shot("06-oteki-proje-web-yok");

    // Back: the panel is where this project had it, and it is the same page (the mark is still in it).
    await rail().getByRole("button", { name: PROJECT, exact: true }).click();
    await expect.poll(() => page.locator(".kp-header__title").textContent(), { timeout: UI_TIMEOUT_MS }).toBe(PROJECT);
    await expect.poll(dockTabs, { timeout: UI_TIMEOUT_MS }).toContain("Web");
    await expect.poll(async () => (await viewOf("wiki"))?.visible, { timeout: UI_TIMEOUT_MS }).toBe(true);
    expect((await viewOf("wiki"))?.text).toContain(mark);
    expect(await activeSite()).toBe("Wiki");
    await expect.poll(async () => (await menuItem(app!, ["Görünüm", "Web"]))?.checked, { timeout: UI_TIMEOUT_MS }).toBe(true);

    // Opened in the other project too, it shows the same tabs and the same page; switching between two layouts
    // that both hold it keeps it on screen.
    await rail().getByRole("button", { name: OTHER, exact: true }).click();
    await expect.poll(() => page.locator(".kp-header__title").textContent(), { timeout: UI_TIMEOUT_MS }).toBe(OTHER);
    await clickMenu(app!, ["Görünüm", "Web"]);
    await expect.poll(dockTabs, { timeout: UI_TIMEOUT_MS }).toContain("Web");
    expect(await siteTabs()).toEqual(["Ana sayfa", "Wiki", "Ek sayfa"]);
    await expect.poll(async () => (await viewOf("wiki"))?.visible, { timeout: UI_TIMEOUT_MS }).toBe(true);
    expect((await viewOf("wiki"))?.text).toContain(mark);
    await rail().getByRole("button", { name: PROJECT, exact: true }).click();
    await expect.poll(() => page.locator(".kp-header__title").textContent(), { timeout: UI_TIMEOUT_MS }).toBe(PROJECT);
    await expect.poll(async () => (await viewOf("wiki"))?.visible, { timeout: UI_TIMEOUT_MS }).toBe(true);
    expect((await viewOf("wiki"))?.text).toContain(mark);
    await shot("07-iki-projede-web");
  });

  it("9. a new default site reaches the saved list once: Git lists NAS panosu; Git › NAS panosu opens it over plain http (private IP literal)", async () => {
    const git = await app!.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items.find((i) => i.label === "Git")!.submenu!.items.map((i) => i.label));
    expect(git.filter(Boolean)).toEqual(["Ana sayfa", "Wiki", "Ek sayfa", "NAS panosu", "Siteleri düzenle…"]);
    const saved = JSON.parse(readFileSync(join(root, "user-data", "web-sites.json"), "utf8")) as { sites: { id: string }[]; seededDefaults: string[] };
    expect(saved.sites.map((s) => s.id).at(-1)).toBe(NAS_PANO);
    expect(saved.seededDefaults).toEqual(["home", "wiki", NAS_PANO]);

    await clickMenu(app!, ["Git", "NAS panosu"]);
    await expect.poll(activeSite, { timeout: UI_TIMEOUT_MS }).toBe("NAS panosu");
    // Like the real dashboard it answers 302 → /login on its own origin: followed inside the view.
    await expect.poll(async () => (await viewOf(NAS_PANO))?.text ?? "", { timeout: UI_TIMEOUT_MS }).toContain("NAS-PANO /login");
    const view = (await viewOf(NAS_PANO))!;
    expect(view.url).toBe(`${httpBase}/login`);
    expect(view.visible).toBe(true);
    await expect.poll(() => hitsOn("127.0.0.1"), { timeout: UI_TIMEOUT_MS }).toEqual(expect.arrayContaining(["/pano", "/login", "/kendi-piksel"]));
    await shot("08-nas-panosu-http");
  });

  it("10. the http site stays on its own origin: no host name, no public address, no redirect away, no foreign http request", async () => {
    // The page asked for a picture from a host NAME over http: the request never left the app.
    expect(hitsOn("localhost")).toEqual([]);
    // The page tries to leave: a host name, a public address, another port — then a same-origin page, which loads.
    await inView(NAS_PANO, `location.href = "http://localhost:${httpPort}/isimle"`);
    await inView(NAS_PANO, `location.href = ${JSON.stringify(PUBLIC_HTTP)}`);
    await inView(NAS_PANO, `location.href = "http://127.0.0.1:${httpPort + 1}/baska-kapi"`);
    await inView(NAS_PANO, `location.href = "/sonra"`);
    await expect.poll(async () => (await viewOf(NAS_PANO))?.text ?? "", { timeout: UI_TIMEOUT_MS }).toContain("NAS-PANO /sonra");
    expect((await viewOf(NAS_PANO))!.url).toBe(`${httpBase}/sonra`);
    // A same-origin address that redirects to a host name: the redirect is not followed.
    await inView(NAS_PANO, `location.href = "/disari"`);
    await expect.poll(() => hitsOn("127.0.0.1"), { timeout: UI_TIMEOUT_MS }).toContain("/disari");
    await inView(NAS_PANO, `fetch("http://localhost:${httpPort}/fetch").catch(() => {})`);
    await inView(NAS_PANO, `fetch("/kendi-fetch").catch(() => {})`);
    await expect.poll(() => hitsOn("127.0.0.1"), { timeout: UI_TIMEOUT_MS }).toContain("/kendi-fetch");
    expect((await viewOf(NAS_PANO))!.url.startsWith(httpBase)).toBe(true);
    expect(hitsOn("localhost")).toEqual([]);
    expect(httpHits.map((h) => h.path)).not.toEqual(expect.arrayContaining(["/isimle"]));
    expect(httpHits.map((h) => h.path)).not.toEqual(expect.arrayContaining(["/gizli"]));
  });

  it("11. an https site is never downgraded to http, not even to the allowed private address", async () => {
    await clickMenu(app!, ["Git", "Wiki"]);
    await expect.poll(activeSite, { timeout: UI_TIMEOUT_MS }).toBe("Wiki");
    await inView("wiki", `location.href = "${httpBase}/https-siteden"`);
    await inView("wiki", `fetch("${httpBase}/https-siteden-fetch", { mode: "no-cors" }).catch(() => {})`);
    await inView("wiki", `document.getElementById("probe").textContent = "hala-wiki"`);
    await expect.poll(async () => (await viewOf("wiki"))?.text ?? "", { timeout: UI_TIMEOUT_MS }).toContain("hala-wiki");
    // Give a wrongly allowed request the time to arrive before saying none did.
    await inView(NAS_PANO, `fetch("/son-isaret").catch(() => {})`);
    await expect.poll(() => hitsOn("127.0.0.1"), { timeout: UI_TIMEOUT_MS }).toContain("/son-isaret");
    expect((await viewOf("wiki"))!.url).toBe(`${base}/wiki`);
    expect(httpHits.map((h) => h.path).filter((p) => p.startsWith("/https-siteden"))).toEqual([]);
  });
});
