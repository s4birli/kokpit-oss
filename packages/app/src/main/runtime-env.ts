// Environment overrides read by the main process before the app is ready.
import { isAbsolute } from "node:path";

/** Absolute directory used instead of Electron's default userData (tests, side-by-side profiles). */
export const USER_DATA_DIR_ENV = "KOKPIT_USER_DATA_DIR";

export interface UserDataPathSetter {
  setPath(name: "userData", path: string): void;
}

/** Must run before anything reads `app.getPath("userData")`. Returns the applied path, or null. */
export function applyUserDataDir(app: UserDataPathSetter, env: NodeJS.ProcessEnv): string | null {
  const raw = env[USER_DATA_DIR_ENV];
  if (raw === undefined || raw === "") return null;
  if (!isAbsolute(raw)) throw new Error(`${USER_DATA_DIR_ENV} must be an absolute path.`);
  app.setPath("userData", raw);
  return raw;
}
