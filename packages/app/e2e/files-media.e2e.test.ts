// Dosyalar — yer ve medya, end-to-end: the built app (Electron, Playwright `_electron`) against a real engine.
//
// Part 1 — the content is visible: in the default layout Dosyalar is a narrow column. A clicked file opens in the
// large preview (the whole window); back in the panel the preview has its own track under the tree and never ends
// up below the panel's edge. Measured at 1440×900, 1280×800 and 1000×640.
// Part 2 — media: a video streams from the engine and plays, Space toggles it, seeking works; a picture, an SVG
// (as a picture), a PDF and a sound open; a video the built-in player cannot decode says so. The media URL cannot
// navigate the window, be loaded as a script, or be replaced by another server's; it dies with the selection.
//
// The clips in fixtures/media were made with ffmpeg (see docs/kabul-testleri.md §14A); the test needs no ffmpeg.
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ElectronApplication, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { engineRequest, git, launchApp, SCREENSHOT_DIR, startEngine, stopEngine, type EngineHandle } from "./harness.ts";
import { diagnoseFailures } from "./diagnostics.ts";

const KEY = randomBytes(32).toString("hex");
const UI_TIMEOUT_MS = 20_000;
const PROJECT = "Medyalı";
const FIXTURES = fileURLToPath(new URL("./fixtures/media/", import.meta.url));
/** The clip's length and picture size, as ffmpeg made it. */
const CLIP = { seconds: 4, width: 160, height: 90 };
const PICTURE = { width: 320, height: 180 };
const LONG_LINES = 600;
const SIZES: readonly (readonly [number, number])[] = [
  [1440, 900],
  [1280, 800],
  [1000, 640],
];
/** A file is "readable" in the large preview when its text area takes at least this share of the window. */
const LARGE_MIN_SHARE = 0.9;
/** Rounding slack for layout comparisons (px). */
const PX = 1;
const PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 24 Tf 40 100 Td (Merhaba PDF) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF
`;
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><rect width="200" height="100" fill="#246"/><circle cx="100" cy="50" r="30" fill="#fc3"/><script>window.top.kacak = 1; window.kacak = 1;</script></svg>\n`;

let root: string;
let engine: EngineHandle | undefined;
let app: ElectronApplication | undefined;
let page: Page;
let decoy: http.Server;
let decoyHits: string[] = [];
let decoyOrigin: string;

diagnoseFailures("files-media", () => ({ app, page, engine }));

const rail = (): Locator => page.getByRole("navigation", { name: "Kokpit" });
const panel = (): Locator => page.getByRole("region", { name: "Dosyalar", exact: true });
const tree = (): Locator => panel().getByRole("list", { name: "Dosya ağacı" });
const entry = (name: string): Locator => tree().getByRole("button", { name, exact: true });
const preview = (): Locator => panel().getByRole("region", { name: "Önizleme" });
const isLarge = (): Promise<boolean> => preview().evaluate((el) => el.classList.contains("kp-files__preview--large"));

async function shot(name: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `dosyalar-medya-${name}.png`) });
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}
async function rect(locator: Locator): Promise<Rect> {
  return locator.evaluate((el) => {
    const b = el.getBoundingClientRect();
    return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height };
  });
}

async function setWindow(width: number, height: number): Promise<void> {
  await app!.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0]!.setContentSize(s[0]!, s[1]!), [width, height]);
  await expect.poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight]), { timeout: UI_TIMEOUT_MS }).toEqual([width, height]);
}

/** Clicks a file in the (narrow) tree and waits for the large preview. */
async function openLarge(name: string): Promise<void> {
  await entry(name).scrollIntoViewIfNeeded();
  await entry(name).click();
  await expect.poll(isLarge, { timeout: UI_TIMEOUT_MS }).toBe(true);
}
async function closeLarge(): Promise<void> {
  await page.keyboard.press("Escape");
  await expect.poll(isLarge, { timeout: UI_TIMEOUT_MS }).toBe(false);
}

const video = (): Locator => preview().locator("video");
const videoState = (): Promise<{ paused: boolean; time: number; duration: number; width: number; ready: number; src: string }> =>
  video().evaluate((v: HTMLVideoElement) => ({ paused: v.paused, time: v.currentTime, duration: v.duration, width: v.videoWidth, ready: v.readyState, src: v.currentSrc }));

function httpStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get(url, { agent: false }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
      .on("error", reject);
  });
}

beforeAll(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-files-media-")));
  const repo = join(root, "depo");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "cikti"), { recursive: true });
  mkdirSync(join(root, "home"));
  writeFileSync(join(repo, "README.md"), "# Medyalı proje\n");
  writeFileSync(join(repo, "src", "uzun.ts"), Array.from({ length: LONG_LINES }, (_, i) => `export const satir${i} = ${i};`).join("\n") + "\n");
  writeFileSync(join(repo, "src", "genis.json"), JSON.stringify(Array.from({ length: 400 }, (_, i) => ({ id: i, ad: `öğe ${i}` }))) + "\n");
  for (const f of ["klip.mp4", "cozulemez.mov", "resim.png", "ses.wav"]) copyFileSync(join(FIXTURES, f), join(repo, "cikti", f));
  writeFileSync(join(repo, "cikti", "belge.pdf"), PDF);
  writeFileSync(join(repo, "cikti", "cizim.svg"), SVG);
  writeFileSync(join(repo, "cikti", "sahte.mp4"), "<html><script>window.kacak = 1</script></html>");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "ilk");

  // Another server on this machine: whatever the page is made to ask of it must never arrive.
  decoy = http.createServer((req, res) => {
    decoyHits.push(req.url ?? "");
    res.writeHead(200, { "content-type": "image/png" });
    res.end(Buffer.from("89504e470d0a1a0a", "hex"));
  });
  await new Promise<void>((r) => decoy.listen(0, "127.0.0.1", r));
  decoyOrigin = `http://127.0.0.1:${(decoy.address() as AddressInfo).port}`;

  const configPath = join(root, "engine.json");
  writeFileSync(
    configPath,
    JSON.stringify({ dataDir: join(root, "data"), port: 0, shell: "/bin/sh", shellArgs: [], listenTailscale: false, flushIntervalMs: 100, killGraceMs: 200 }),
  );
  engine = await startEngine(configPath, KEY, { HOME: join(root, "home") });
  await engineRequest(engine.url, KEY, "settings.update", { defaultToolId: null });
  await engineRequest(engine.url, KEY, "projects.create", { name: PROJECT, location: { kind: "local", path: repo } });

  app = await launchApp({ KOKPIT_USER_DATA_DIR: join(root, "user-data") });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.getByLabel("Motor adresi").fill(engine.url);
  await page.getByLabel("Anahtar").fill(KEY);
  await page.getByRole("button", { name: "Bağlan" }).click();
  await rail().getByRole("button", { name: PROJECT, exact: true }).click();
  await entry("src").waitFor({ timeout: UI_TIMEOUT_MS });
  await entry("src").click();
  await entry("cikti").click();
  await entry("klip.mp4").waitFor({ timeout: UI_TIMEOUT_MS });
});

afterAll(async () => {
  await app?.close().catch(() => {});
  await stopEngine(engine);
  decoy?.closeAllConnections();
  await new Promise((r) => (decoy ? decoy.close(r) : r(null)));
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("Dosyalar: the content is visible (default layout, narrow column)", () => {
  it.each(SIZES)("1. %d×%d: a clicked file fills the window; back in the panel the preview stays inside it", async (width, height) => {
    await setWindow(width, height);
    const column = await rect(panel());
    // The default layout really is the narrow case this is about.
    expect(column.width).toBeLessThan(400);

    await openLarge("uzun.ts");
    await expect.poll(() => preview().locator("code").textContent(), { timeout: UI_TIMEOUT_MS }).toContain(`satir${LONG_LINES - 1}`);
    const large = await rect(preview());
    expect(large.left).toBeLessThanOrEqual(PX);
    expect(large.top).toBeLessThanOrEqual(PX);
    expect(large.width).toBeGreaterThanOrEqual(width - PX);
    expect(large.height).toBeGreaterThanOrEqual(height - PX);
    const code = await rect(preview().locator(".kp-files__code-wrap"));
    expect(code.width).toBeGreaterThanOrEqual(width * LARGE_MIN_SHARE);
    expect(code.height).toBeGreaterThanOrEqual(height * LARGE_MIN_SHARE);
    // The whole file is reachable: the text area scrolls to its last line.
    const lastVisible = await preview()
      .locator(".kp-files__code-wrap")
      .evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        return el.scrollTop + el.clientHeight >= el.scrollHeight - 1 && el.scrollHeight > el.clientHeight;
      });
    expect(lastVisible).toBe(true);
    await shot(`01-buyuk-metin-${width}x${height}`);

    await closeLarge();
    const [body, treeBox, small, smallCode] = [await rect(panel().locator(".kp-files__body")), await rect(tree()), await rect(preview()), await rect(preview().locator(".kp-files__code-wrap"))];
    // Stacked, each in its own track: the tree above, the preview below, both inside the panel.
    expect(treeBox.bottom).toBeLessThanOrEqual(small.top + PX);
    expect(small.bottom).toBeLessThanOrEqual(body.bottom + PX);
    expect(small.top).toBeGreaterThanOrEqual(body.top - PX);
    expect(small.width).toBeGreaterThanOrEqual(body.width - PX);
    // The preview gets a real share of the column, and its text is on screen (it was 0–125 px, cut off, before).
    expect(small.height).toBeGreaterThanOrEqual(body.height * 0.4);
    expect(smallCode.bottom).toBeLessThanOrEqual(body.bottom + PX);
    expect(smallCode.height).toBeGreaterThanOrEqual(small.height * 0.5);
    // The tree keeps scrolling on its own.
    expect(await tree().evaluate((el) => getComputedStyle(el).overflowY)).toBe("auto");
    await shot(`02-panelde-${width}x${height}`);
  });

  it("2. a file with long lines scrolls sideways in the large preview, line numbers staying in view", async () => {
    await setWindow(1440, 900);
    await openLarge("genis.json");
    const wrap = preview().locator(".kp-files__code-wrap");
    await expect.poll(() => wrap.evaluate((el) => el.scrollWidth > el.clientWidth), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await wrap.evaluate((el) => (el.scrollLeft = 5000));
    const [gutter, box] = [await rect(preview().locator(".kp-files__gutter")), await rect(wrap)];
    expect(gutter.left).toBeGreaterThanOrEqual(box.left - PX);
    expect(gutter.left).toBeLessThanOrEqual(box.left + PX);
    await closeLarge();
  });

  it("3. Büyüt in the panel's preview opens the same file large; Küçült returns", async () => {
    await preview().getByRole("button", { name: "Büyüt" }).click();
    await expect.poll(isLarge, { timeout: UI_TIMEOUT_MS }).toBe(true);
    await preview().getByRole("button", { name: "Küçült" }).click();
    await expect.poll(isLarge, { timeout: UI_TIMEOUT_MS }).toBe(false);
  });

  it("4. the divider between tree and preview drags, and the share survives a restart of the panel", async () => {
    const divider = panel().getByRole("separator");
    const before = Number(await divider.getAttribute("aria-valuenow"));
    const [d, body] = [await rect(divider), await rect(panel().locator(".kp-files__body"))];
    const targetY = body.top + body.height * 0.25;
    await page.mouse.move(d.left + d.width / 2, d.top + d.height / 2);
    await page.mouse.down();
    await page.mouse.move(d.left + d.width / 2, targetY, { steps: 4 });
    await page.mouse.up();
    const after = Number(await divider.getAttribute("aria-valuenow"));
    expect(after).not.toBe(before);
    expect(after).toBeGreaterThan(20);
    expect(after).toBeLessThan(30);
    const treeBox = await rect(tree());
    expect(Math.abs(treeBox.bottom - targetY)).toBeLessThanOrEqual(4);
  });
});

describe("Dosyalar: media opens inside Kokpit", () => {
  let clipUrl = "";

  it("5. a video streams from the engine and plays; Space pauses and resumes; seeking works", async () => {
    await openLarge("klip.mp4");
    await expect.poll(async () => (await videoState()).ready, { timeout: UI_TIMEOUT_MS }).toBeGreaterThanOrEqual(1);
    const loaded = await videoState();
    expect(loaded.width).toBe(CLIP.width);
    expect(loaded.duration).toBeGreaterThan(CLIP.seconds - 0.5);
    expect(loaded.duration).toBeLessThan(CLIP.seconds + 0.5);
    expect(loaded.paused).toBe(true);
    clipUrl = loaded.src;
    expect(clipUrl).toMatch(new RegExp(`^http://${engine!.host.replace(/[.[\]]/g, "\\$&")}:${engine!.port}/files/media/[A-Za-z0-9_-]{43,}$`));
    // The player fills the window under the one path line.
    const box = await rect(video());
    const [w, h] = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
    expect(box.width).toBeGreaterThanOrEqual(w! * LARGE_MIN_SHARE);
    expect(box.height).toBeGreaterThanOrEqual(h! * 0.8);

    // The player has the keyboard: Space plays…
    expect(await video().evaluate((v) => document.activeElement === v)).toBe(true);
    await page.keyboard.press("Space");
    await expect.poll(async () => (await videoState()).paused, { timeout: UI_TIMEOUT_MS }).toBe(false);
    await expect.poll(async () => (await videoState()).time, { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(0.2);
    await shot("05-video");
    // …and pauses.
    await page.keyboard.press("Space");
    await expect.poll(async () => (await videoState()).paused, { timeout: UI_TIMEOUT_MS }).toBe(true);

    // Seek near the end, then back to the start: both land (the engine answers ranges).
    for (const to of [CLIP.seconds - 1, 0.4]) {
      await video().evaluate(
        (v: HTMLVideoElement, t) =>
          new Promise<void>((resolve) => {
            v.addEventListener("seeked", () => resolve(), { once: true });
            v.currentTime = t;
          }),
        to,
      );
      const s = await videoState();
      expect(Math.abs(s.time - to)).toBeLessThan(0.3);
      expect(s.ready).toBeGreaterThanOrEqual(2);
    }
    expect(await preview().getByRole("alert").count()).toBe(0);
    await closeLarge();
    // In the narrow column the same player is still there, inside the panel.
    const [small, body] = [await rect(video()), await rect(panel().locator(".kp-files__body"))];
    expect(small.bottom).toBeLessThanOrEqual(body.bottom + PX);
    expect(small.width).toBeGreaterThan(100);
  });

  it("6. selecting another file ends the video's URL", async () => {
    expect(await httpStatus(clipUrl)).toBe(200);
    await openLarge("resim.png");
    await expect.poll(() => httpStatus(clipUrl), { timeout: UI_TIMEOUT_MS }).toBe(404);
  });

  it("7. a picture fits the preview; a click shows it at its own size", async () => {
    const img = preview().locator("img");
    await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth), { timeout: UI_TIMEOUT_MS }).toBe(PICTURE.width);
    const [box, area] = [await rect(img), await rect(preview().locator(".kp-files__media"))];
    expect(box.left).toBeGreaterThanOrEqual(area.left - PX);
    expect(box.right).toBeLessThanOrEqual(area.right + PX);
    expect(box.bottom).toBeLessThanOrEqual(area.bottom + PX);
    await shot("07-resim");
    await closeLarge();
    // Narrow column: scaled down to fit, whole picture visible.
    const fitted = await rect(img);
    const column = await rect(preview().locator(".kp-files__media"));
    expect(fitted.width).toBeLessThanOrEqual(column.width + PX);
    expect(fitted.width).toBeLessThan(PICTURE.width);
    expect(Math.abs(fitted.width / fitted.height - PICTURE.width / PICTURE.height)).toBeLessThan(0.05);
    await preview().getByRole("button", { name: "Resmi gerçek boyutunda göster" }).click();
    const actual = await rect(img);
    expect(Math.round(actual.width)).toBe(PICTURE.width);
    expect(Math.round(actual.height)).toBe(PICTURE.height);
    await preview().getByRole("button", { name: "Resmi panele sığdır" }).click();
    expect((await rect(img)).width).toBeLessThan(PICTURE.width);
  });

  it("8. an SVG is shown as a picture: nothing of it enters the page, its script does not run", async () => {
    await openLarge("cizim.svg");
    const img = preview().locator("img");
    await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth), { timeout: UI_TIMEOUT_MS }).toBe(200);
    expect(await preview().locator("svg, script").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { kacak?: number }).kacak)).toBeUndefined();
    await shot("08-svg");
    await closeLarge();
  });

  it("9. a sound gets a player", async () => {
    await openLarge("ses.wav");
    const audio = preview().locator("audio");
    await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.readyState), { timeout: UI_TIMEOUT_MS }).toBeGreaterThanOrEqual(1);
    expect(await audio.evaluate((a: HTMLAudioElement) => a.duration)).toBeGreaterThan(0.5);
    await closeLarge();
  });

  it("10. a PDF opens in the built-in viewer, in a frame that holds nothing but the media URL", async () => {
    await openLarge("belge.pdf");
    const frame = preview().locator("iframe");
    const src = await frame.getAttribute("src");
    expect(src).toMatch(/\/files\/media\/[A-Za-z0-9_-]{43,}#toolbar=0&navpanes=0$/);
    const token = /media\/([A-Za-z0-9_-]+)#/.exec(src!)![1]!;
    // The main process sees the frame loaded (not blocked) and Chromium's viewer inside it.
    await expect
      .poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.mainFrame.framesInSubtree.map((f) => f.url)), { timeout: UI_TIMEOUT_MS })
      .toEqual(expect.arrayContaining([expect.stringContaining(token), expect.stringMatching(/^chrome-extension:\/\/[a-z]+\/index\.html/)]));
    const box = await rect(frame);
    const [w, h] = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
    expect(box.width).toBeGreaterThanOrEqual(w! * LARGE_MIN_SHARE);
    expect(box.height).toBeGreaterThanOrEqual(h! * 0.8);
    // Let the viewer paint before the picture is taken (looked at by a person; see the acceptance doc).
    await page.waitForTimeout(1500);
    await shot("10-pdf");
    await preview().getByRole("button", { name: "Küçült" }).click();
    await expect.poll(isLarge, { timeout: UI_TIMEOUT_MS }).toBe(false);
  });

  it("11. a video the built-in player cannot decode says so, with the file's type, instead of a black box", async () => {
    await openLarge("cozulemez.mov");
    const alert = preview().getByRole("alert");
    await expect.poll(() => alert.count(), { timeout: UI_TIMEOUT_MS }).toBe(1);
    const text = (await alert.textContent()) ?? "";
    expect(text).toMatch(/Bu video Kokpit'te oynatılamıyor/);
    expect(text).toContain("video/quicktime");
    expect(text).toMatch(/dönüştürme yapmaz/);
    expect(await preview().locator("video").count()).toBe(0);
    await shot("11-cozulemeyen-video");
    await closeLarge();
  });

  it("12. content that is not what its extension says gets no URL", async () => {
    await openLarge("sahte.mp4");
    await expect.poll(() => preview().getByRole("alert").textContent(), { timeout: UI_TIMEOUT_MS }).toMatch(/uzantısıyla uyuşmuyor/);
    expect(await preview().locator("video").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { kacak?: number }).kacak)).toBeUndefined();
    await closeLarge();
  });
});

describe("Dosyalar: a media URL is only ever media", () => {
  let mediaUrl = "";
  const appUrl = (): string => page.url();

  /** Adds an element to the app's page and reports whether it loaded. */
  const probe = (tag: string, attr: string, url: string, extra: Record<string, string> = {}): Promise<"load" | "error" | "timeout"> =>
    page.evaluate(
      ({ tag, attr, url, extra }) =>
        new Promise<"load" | "error" | "timeout">((resolve) => {
          const el = document.createElement(tag);
          for (const [k, v] of Object.entries(extra)) el.setAttribute(k, v);
          el.addEventListener("load", () => resolve("load"));
          el.addEventListener("loadeddata", () => resolve("load"));
          el.addEventListener("error", () => resolve("error"));
          setTimeout(() => resolve("timeout"), 3000);
          el.setAttribute(attr, url);
          el.setAttribute("data-probe", "");
          document.body.appendChild(el);
        }),
      { tag, attr, url, extra },
    );

  it("13. it cannot be loaded as a script, a stylesheet, or read with fetch", async () => {
    await openLarge("klip.mp4");
    await expect.poll(async () => (await videoState()).ready, { timeout: UI_TIMEOUT_MS }).toBeGreaterThanOrEqual(1);
    mediaUrl = (await videoState()).src;
    expect(await probe("script", "src", mediaUrl)).toBe("error");
    expect(await probe("link", "href", mediaUrl, { rel: "stylesheet" })).toBe("error");
    for (const mode of ["cors", "no-cors"] as const) {
      expect(
        await page.evaluate(
          ({ u, mode }) =>
            fetch(u, { mode }).then(
              () => "read",
              () => "refused",
            ),
          { u: mediaUrl, mode },
        ),
        mode,
      ).toBe("refused");
    }
  });

  it("14. media elements and frames load from the connected engine's media URLs only", async () => {
    // The real URL does load in a media element…
    expect(await probe("video", "src", mediaUrl, { preload: "auto" })).toBe("load");
    // …but nothing is even asked of another server, whatever its URL looks like.
    decoyHits = [];
    const token = mediaUrl.slice(mediaUrl.lastIndexOf("/") + 1);
    expect(await probe("img", "src", `${decoyOrigin}/a.png`)).toBe("error");
    expect(await probe("img", "src", `${decoyOrigin}/files/media/${token}`)).toBe("error");
    expect(await probe("video", "src", `${decoyOrigin}/files/media/${token}`)).toBe("error");
    expect(await probe("audio", "src", `${decoyOrigin}/a.mp3`)).toBe("error");
    await probe("iframe", "src", `${decoyOrigin}/files/media/${token}`);
    await probe("iframe", "src", `${decoyOrigin}/`);
    // Other paths of the engine itself are not media either.
    const engineHttp = mediaUrl.slice(0, mediaUrl.indexOf("/files/"));
    expect(await probe("img", "src", `${engineHttp}/health`)).toBe("error");
    expect(await probe("img", "src", `${mediaUrl}?x=1`)).toBe("error");
    expect(decoyHits).toEqual([]);
    expect(appUrl()).toMatch(/^file:/);
    await page.evaluate(() => document.querySelectorAll("[data-probe]").forEach((el) => el.remove()));
  });

  it("15. closing the preview ends the URL", async () => {
    expect(await httpStatus(mediaUrl)).toBe(200);
    await closeLarge();
    await preview().getByRole("button", { name: "Önizlemeyi kapat" }).click();
    await expect.poll(() => httpStatus(mediaUrl), { timeout: UI_TIMEOUT_MS }).toBe(404);
    expect(await panel().getByRole("region", { name: "Önizleme" }).count()).toBe(0);
  });

  // Last: Playwright's locators wait for a navigation they saw begin, and the app refuses this one.
  it("16. it cannot navigate the window or open one; the app going away ends whatever URL is left", async () => {
    await entry("resim.png").click();
    await expect.poll(isLarge, { timeout: UI_TIMEOUT_MS }).toBe(true);
    const img = preview().locator("img");
    await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth), { timeout: UI_TIMEOUT_MS }).toBe(PICTURE.width);
    const last = (await img.getAttribute("src"))!;
    expect(await httpStatus(last)).toBe(200);

    const before = appUrl();
    expect(await page.evaluate((u) => window.open(u) === null, last)).toBe(true);
    expect(app!.windows()).toHaveLength(1);
    // From a timer: the evaluate call itself must not wait on the navigation it starts.
    await page.evaluate((u) => {
      setTimeout(() => {
        window.location.href = u;
      }, 0);
    }, last);
    await page.waitForTimeout(1000);
    expect(appUrl()).toBe(before);
    // The app is still there, the picture still shown.
    expect(await page.evaluate(() => ({ src: document.querySelector<HTMLImageElement>(".kp-files__image")?.currentSrc, tree: document.querySelectorAll(".kp-files__entry").length > 0 }))).toEqual({ src: last, tree: true });

    // The app goes away without a goodbye (killed): its connection drops, and the engine ends its URLs.
    app!.process().kill("SIGKILL");
    app = undefined;
    await expect.poll(() => httpStatus(last), { timeout: UI_TIMEOUT_MS }).toBe(404);
  });
});
