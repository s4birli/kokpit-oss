// Smoke test of the packaged app (`pnpm dist` output): the unsigned Kokpit.app starts, resolves
// all its runtime code from app.asar (no workspace packages at runtime) and shows the connect screen.
// Run with `pnpm --filter @kokpit/app test:dist` (builds the package first).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "playwright";
import { afterAll, describe, expect, it } from "vitest";
import { APP_DIR, builderConfigValue, launchApp, SCREENSHOT_DIR } from "./harness.ts";

const UI_TIMEOUT_MS = 20_000;

function packagedExecutable(): string {
  const outDir = join(APP_DIR, builderConfigValue("output"));
  const productName = builderConfigValue("productName");
  const hits = existsSync(outDir)
    ? readdirSync(outDir)
        .map((d) => join(outDir, d, `${productName}.app`, "Contents", "MacOS", productName))
        .filter((p) => existsSync(p))
    : [];
  if (hits.length !== 1) throw new Error(`expected exactly one packaged ${productName}.app under ${outDir}, found ${hits.length}`);
  return hits[0]!;
}

let app: ElectronApplication | undefined;
let userDataDir: string | undefined;

afterAll(async () => {
  await app?.close();
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
});

describe("packaged Kokpit.app", () => {
  it("starts from app.asar and shows the connect screen", async () => {
    const executablePath = packagedExecutable();
    userDataDir = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-dist-e2e-")));
    app = await launchApp({ KOKPIT_USER_DATA_DIR: userDataDir }, executablePath);
    const page = await app.firstWindow();
    await expect
      .poll(() => page.getByRole("heading", { name: "Motora bağlan" }).isVisible(), { timeout: UI_TIMEOUT_MS })
      .toBe(true);
    expect(await app.evaluate(({ app: a }) => a.getAppPath())).toMatch(/app\.asar$/);
    expect(await app.evaluate(({ app: a }) => a.getPath("userData"))).toBe(userDataDir);
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: join(SCREENSHOT_DIR, "20-packaged-connect.png") });
  });
});
