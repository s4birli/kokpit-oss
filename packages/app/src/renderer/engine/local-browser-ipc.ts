// İş B: contract between the renderer, the preload and Electron main for opening Chrome on this machine
// (projects with `browser.runOn: "client"`). Shared so the main process validates with the same rule.

export const LOCAL_BROWSER_IPC = { openLocal: "browser:openLocal" } as const;

/** Exposed as `window.kokpit.browser`. */
export interface LocalBrowserBridge {
  /**
   * Opens Chrome with this machine's own profile for the project, in its own window. Bağlantılar: with `url` (an
   * http(s) link from the project's terminal) that address is shown in a new tab of it.
   */
  openLocal(projectId: string, url?: string): Promise<void>;
}

const MAX_PROJECT_ID = 200;
const SAFE_PROFILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/** Same rule as the engine's profile dirs: a plain name that cannot escape the profiles folder. */
export function isSafeProjectId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= MAX_PROJECT_ID &&
    SAFE_PROFILE_NAME.test(id) &&
    id !== "." &&
    id !== ".."
  );
}
