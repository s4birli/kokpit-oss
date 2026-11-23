// Girişler end-to-end: the built app against a real engine, a real (headless, test-only) Chrome and a FAKE
// `security` tool — the real macOS Keychain is never touched. The popover flow: save → list → fill → delete.
// Every Chrome started here lives under a temp dir and is killed at the end.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installFakeSecurity, type FakeSecurity } from "../../engine/test/fakes/fake-security-setup.ts";
import { diagnoseFailures } from "./diagnostics.ts";
import { ENGINE_DIR, launchApp, engineRequest, SCREENSHOT_DIR, startEngine, stopEngine, type EngineHandle } from "./harness.ts";

const KEY = randomBytes(32).toString("hex");
const UI_TIMEOUT_MS = 30_000;
const engineDefaults = JSON.parse(readFileSync(join(ENGINE_DIR, "config.defaults.json"), "utf8")) as {
  browser: { projectName: string; projectId: string };
  logins: { servicePrefix: string; secretPrefix: string };
};
const PAGE_TITLE = "Giriş sayfası";
const USER = "ayşe@ornek.example";
const SECRET = "Gizli-parola-çğı-Zx9!";
/** The page reports through its title — as lengths and a yes/no, never the values (titles travel to the app). */
const FILLED_TITLE = `dolu:${USER.length}:evet`;
const OTHER_TITLE = "Başka site";

// Whenever a field changes the page says in its title whether both hold the expected values. It never submits.
const loginPage = (title: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="margin:24px;font:16px sans-serif"><h1>${title}</h1>
<form id="f" onsubmit="document.title='gönderildi';return false">
<p><input name="user" type="text" placeholder="kullanıcı adı" style="width:320px;font-size:16px"></p>
<p><input name="pw" type="password" placeholder="parola" style="width:320px;font-size:16px"></p>
<button>Giriş</button></form>
<script>
const f = document.getElementById("f"), expected = ${JSON.stringify(SECRET)};
f.addEventListener("input", () => { document.title = "dolu:" + f.user.value.length + ":" + (f.pw.value === expected ? "evet" : "hayır"); });
</script></body></html>`;

let root: string;
let engine: EngineHandle | undefined;
let app: ElectronApplication | undefined;
let page: Page;
let fake: FakeSecurity;
let site: http.Server;
let other: http.Server;
let siteUrl: string;
let otherUrl: string;

diagnoseFailures("logins", () => ({ app, page, engine }));

const rail = (): Locator => page.getByRole("navigation", { name: "Kokpit" });
const panel = (): Locator => page.locator("section.kp-browser");
const frames = async (): Promise<number> => Number((await panel().locator("canvas").getAttribute("data-frames")) ?? "0");
const tabTitles = async (): Promise<string[]> => panel().getByRole("group", { name: "Sekmeler" }).getByRole("button").allTextContents();
const toggle = (): Locator => panel().getByRole("button", { name: "Girişler", exact: true });
const popover = (): Locator => panel().getByRole("dialog", { name: "Girişler" });
const shot = (name: string) => page.screenshot({ path: join(SCREENSHOT_DIR, `logins-${name}.png`) });

async function go(url: string, title: string): Promise<void> {
  const address = panel().getByLabel("Adres");
  await address.fill(url);
  await address.press("Enter");
  await expect.poll(tabTitles, { timeout: UI_TIMEOUT_MS }).toContain(title);
}

function killAll(needle: string): void {
  const out = execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" });
  for (const line of out.split("\n")) {
    if (!line.includes(needle) || line.includes("ps -ax")) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function serve(body: string): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` })));
}

beforeAll(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-logins-")));
  fake = installFakeSecurity(root);
  ({ server: site, url: siteUrl } = await serve(loginPage(PAGE_TITLE)));
  ({ server: other, url: otherUrl } = await serve(loginPage(OTHER_TITLE)));
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
      // Test-only: no window and no keychain dialog on the desktop (headless + mock keychain).
      browser: { headless: true, testMode: true },
      // The fake tool instead of /usr/bin/security: nothing here reaches the real Keychain.
      logins: { securityPath: fake.path, env: fake.env, envPassthrough: [], timeoutMs: 5000 },
    }),
  );
  engine = await startEngine(configPath, KEY);
  await engineRequest(engine.url, KEY, "settings.update", { defaultToolId: null });
  app = await launchApp({ KOKPIT_USER_DATA_DIR: join(root, "user-data"), KOKPIT_CHROME_HEADLESS: "1" });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
}, 120_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  await stopEngine(engine);
  await new Promise<void>((r) => (site ? site.close(() => r()) : r()));
  await new Promise<void>((r) => (other ? other.close(() => r()) : r()));
  if (root) {
    killAll(root);
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Girişler: kaydet → listele → doldur → sil", () => {
  it("0. connects, opens the project's browser and a login page; the toolbar has the Girişler button", async () => {
    await page.getByLabel("Motor adresi").fill(engine!.url);
    await page.getByLabel("Anahtar").fill(KEY);
    await page.getByRole("button", { name: "Bağlan" }).click();
    const project = rail().getByRole("button", { name: engineDefaults.browser.projectName, exact: true });
    await expect.poll(() => project.isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await project.click();
    await panel().getByRole("button", { name: "Tarayıcıyı aç" }).click();
    await expect.poll(frames, { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(0);
    await go(`${siteUrl}/`, PAGE_TITLE);
    expect(await toggle().isVisible()).toBe(true);
    expect(await toggle().getAttribute("title")).toMatch(/Girişler/);
    // One small button in the existing toolbar row — not a row of its own.
    const [button, address] = await Promise.all([toggle().boundingBox(), panel().getByLabel("Adres").boundingBox()]);
    expect(Math.abs(button!.y + button!.height / 2 - (address!.y + address!.height / 2))).toBeLessThan(6);
    expect(button!.width).toBeLessThan(48);
    await shot("00-toolbar");
  });

  it("1. the popover starts empty; 'Bu site için kaydet' takes the site from the open page", async () => {
    await toggle().click();
    await expect.poll(() => popover().getByText("Kayıtlı giriş yok.").isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await popover().getByRole("button", { name: "Bu site için kaydet" }).click();
    const form = popover().getByRole("form", { name: "Bu site için kaydet" });
    expect(await form.textContent()).toContain(siteUrl);
    expect(await form.getByLabel("Parola").getAttribute("type")).toBe("password");
    await form.getByLabel("Kullanıcı adı").fill(USER);
    await form.getByLabel("Parola").fill(SECRET);
    await shot("01-save-form");
    await form.getByRole("button", { name: "Kaydet" }).click();
    await expect.poll(() => popover().getByRole("list", { name: "Bu site" }).getByRole("listitem").allTextContents(), { timeout: UI_TIMEOUT_MS }).toEqual([expect.stringContaining(USER)]);
    await shot("02-listed");
  });

  it("2. the password is in the (fake) Keychain and nowhere in the app's window", async () => {
    const stored = `${engineDefaults.logins.secretPrefix}${Buffer.from(SECRET, "utf8").toString("base64url")}`;
    const items = fake.items();
    expect(Object.values(items)).toEqual([stored]);
    // Default policy "confirm": created with an empty trusted-application list.
    expect(Object.values(fake.trusted())).toEqual(["nobody"]);
    expect(await popover().textContent()).toMatch(/Her doldurmada.*Anahtar Zinciri onayı/);
    expect(Object.keys(items)[0]).toMatch(new RegExp(`^${engineDefaults.logins.servicePrefix.replace(/\./g, "\\.")}${engineDefaults.browser.projectId}\\n`));
    expect(await page.content()).not.toContain(SECRET);
    expect(await page.evaluate((s) => [...document.querySelectorAll("input")].some((i) => i.value === s), SECRET)).toBe(false);
    expect(fake.runLog()).not.toContain(SECRET);
    expect(fake.runLog()).not.toContain(stored);
  });

  it("3. 'Doldur' fills the page's fields — the page sees the right values — and submits nothing", async () => {
    await popover().getByRole("button", { name: `Doldur: ${USER}` }).click();
    // First fill in this project: the agent risk is named and nothing happens until the user says so.
    const ask = popover().getByRole("alertdialog", { name: "Ajan riski" });
    await expect.poll(() => ask.textContent(), { timeout: UI_TIMEOUT_MS }).toContain("Bu tarayıcıyı ajanlar da sürebiliyor; doldurulan şifreyi okuyabilirler");
    expect(await tabTitles()).toContain(PAGE_TITLE);
    await shot("03a-agent-risk");
    await ask.getByRole("button", { name: "Yine de doldur" }).click();
    await expect.poll(tabTitles, { timeout: UI_TIMEOUT_MS }).toContain(FILLED_TITLE);
    await expect.poll(() => popover().count(), { timeout: UI_TIMEOUT_MS }).toBe(0);
    expect(await tabTitles()).not.toContain("gönderildi");
    // The picture shows the filled form (dots in the password field).
    const before = await frames();
    await expect.poll(frames, { timeout: UI_TIMEOUT_MS }).toBeGreaterThanOrEqual(before);
    await shot("03-filled");
  });

  it("4. on another site the login is listed greyed with its site and cannot be filled there", async () => {
    await go(`${otherUrl}/`, OTHER_TITLE);
    await toggle().click();
    const others = popover().getByRole("list", { name: "Diğer siteler" }).getByRole("listitem");
    await expect.poll(() => others.allTextContents(), { timeout: UI_TIMEOUT_MS }).toEqual([expect.stringContaining(siteUrl)]);
    expect(await popover().getByRole("button", { name: /^Doldur/ }).count()).toBe(0);
    expect(await popover().getByText("Bu site için kayıtlı giriş yok.").isVisible()).toBe(true);
    await shot("04-other-site");
    // The engine refuses too, whatever the app shows: asked directly, it names both sites.
    const login = ((await engineRequest(engine!.url, KEY, "logins.list", { projectId: engineDefaults.browser.projectId })) as { logins: { id: string }[] }).logins[0]!;
    const refusal = await engineRequest(engine!.url, KEY, "logins.fill", { projectId: engineDefaults.browser.projectId, id: login.id }).then(
      () => "(filled)",
      (e: Error) => e.message,
    );
    expect(refusal).toContain(siteUrl);
    expect(refusal).toContain(otherUrl);
    expect(await tabTitles()).toContain(OTHER_TITLE); // untouched: the page would have changed its title
    await page.keyboard.press("Escape");
    await expect.poll(() => popover().count(), { timeout: UI_TIMEOUT_MS }).toBe(0);
  });

  it("5. delete asks first; after 'Sil' the list is empty and the Keychain item is gone", async () => {
    await go(`${siteUrl}/`, PAGE_TITLE);
    await toggle().click();
    await popover().getByRole("button", { name: `Sil: ${USER}` }).click();
    expect(Object.keys(fake.items())).toHaveLength(1);
    await shot("05-confirm-delete");
    await popover().getByRole("button", { name: `Silmeyi onayla: ${USER}` }).click();
    await expect.poll(() => popover().getByText("Kayıtlı giriş yok.").isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    expect(fake.items()).toEqual({});
  });

  it("6. a locked Keychain is explained in the popover; nothing is saved", async () => {
    fake.mode("locked");
    await popover().getByRole("button", { name: "Bu site için kaydet" }).click();
    const form = popover().getByRole("form", { name: "Bu site için kaydet" });
    await form.getByLabel("Kullanıcı adı").fill(USER);
    await form.getByLabel("Parola").fill(SECRET);
    await form.getByRole("button", { name: "Kaydet" }).click();
    await expect.poll(() => popover().getByRole("alert").textContent(), { timeout: UI_TIMEOUT_MS }).toMatch(/Anahtar zinciri kilitli/);
    await shot("06-locked");
    expect(fake.items()).toEqual({});
    fake.mode("ok");
    await page.keyboard.press("Escape");
  });

  it("7. the password never reached the engine's log", () => {
    const log = engine!.log();
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain(Buffer.from(SECRET, "utf8").toString("base64url"));
    expect(log).not.toContain(USER);
    expect(log).toContain("login saved");
    expect(log).toContain("login filled");
  });
});
