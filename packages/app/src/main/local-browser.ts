// İş B: opens Chrome on the app's own machine for projects whose browser runs on the client, with a
// profile of its own under <userData>/<profilesDirName>/<projectId>. No remote debugging: the agent on the
// engine machine cannot drive this browser, by design.
import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { webLinkUrl } from "@kokpit/shared";
import { isSafeProjectId } from "../renderer/engine/local-browser-ipc.ts";
import defaults from "./browser.defaults.json" with { type: "json" };
import { t } from "../i18n/index.ts";

/** Overrides the Chrome executable (absolute path). */
export const CHROME_PATH_ENV = "KOKPIT_CHROME_PATH";
/** Test-only: "1" starts Chrome headless with a mock keychain, so e2e runs never show anything on the desktop. */
export const CHROME_HEADLESS_ENV = "KOKPIT_CHROME_HEADLESS";

export class LocalBrowserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalBrowserError";
  }
}

export function localChromeArgs(o: { profileDir: string; headless: boolean; url?: string | undefined }): string[] {
  return [
    `--user-data-dir=${o.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    // Test mode only: no window, and no macOS keychain dialog for a throwaway profile.
    ...(o.headless ? ["--headless=new", "--use-mock-keychain", "--password-store=basic"] : []),
    // Bağlantılar: Chrome opens the address in a new tab — of the profile's running instance, if there is one.
    ...(o.url !== undefined ? [o.url] : []),
  ];
}

export function resolveChromePath(env: NodeJS.ProcessEnv): string {
  const raw = env[CHROME_PATH_ENV];
  if (raw === undefined || raw === "") return defaults.chromePath;
  if (!isAbsolute(raw)) throw new LocalBrowserError(`${CHROME_PATH_ENV} mutlak bir yol olmalı.`);
  return raw;
}

export interface LocalBrowserDeps {
  userDataDir: string;
  env: NodeJS.ProcessEnv;
  spawn?: typeof nodeSpawn;
}

export function createLocalBrowser(deps: LocalBrowserDeps) {
  const spawn = deps.spawn ?? nodeSpawn;
  const root = join(deps.userDataDir, defaults.profilesDirName);
  return {
    /**
     * Starts Chrome for the project (Chrome itself reuses a running instance of the same profile). With `url`
     * (Bağlantılar: a link from the project's terminal) that address is shown in a new tab. Only an http(s)
     * address, in its normalized form, ever becomes a Chrome argument — never something that reads as an option.
     */
    async open(projectId: unknown, url?: unknown): Promise<void> {
      if (!isSafeProjectId(projectId)) throw new LocalBrowserError(t("main.common.invalidProjectId"));
      const link = url === undefined ? undefined : webLinkUrl(url);
      if (link === null) throw new LocalBrowserError(t("main.localBrowser.httpOnly"));
      const chromePath = resolveChromePath(deps.env);
      const profileDir = join(root, projectId);
      mkdirSync(profileDir, { recursive: true, mode: 0o700 });
      const args = localChromeArgs({ profileDir, headless: deps.env[CHROME_HEADLESS_ENV] === "1", url: link });
      const child = spawn(chromePath, args, { detached: true, stdio: "ignore" });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", (err: Error) => reject(new LocalBrowserError(t("main.localBrowser.chromeFailed", { path: chromePath, error: err.message }))));
      });
      // Chrome outlives the app; the app does not wait for it.
      child.unref();
    },
  };
}
