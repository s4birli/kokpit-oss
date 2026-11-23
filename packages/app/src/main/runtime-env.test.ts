// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { applyUserDataDir, USER_DATA_DIR_ENV } from "./runtime-env.ts";

function fakeApp() {
  return { setPath: vi.fn<(name: "userData", path: string) => void>() };
}

describe("applyUserDataDir", () => {
  it("does nothing when the variable is unset or empty", () => {
    const app = fakeApp();
    expect(applyUserDataDir(app, {})).toBeNull();
    expect(applyUserDataDir(app, { [USER_DATA_DIR_ENV]: "" })).toBeNull();
    expect(app.setPath).not.toHaveBeenCalled();
  });

  it("points userData at an absolute directory", () => {
    const app = fakeApp();
    expect(applyUserDataDir(app, { [USER_DATA_DIR_ENV]: "/tmp/kokpit-ud" })).toBe("/tmp/kokpit-ud");
    expect(app.setPath).toHaveBeenCalledWith("userData", "/tmp/kokpit-ud");
  });

  it("rejects a relative path instead of resolving it against an unknown cwd", () => {
    const app = fakeApp();
    expect(() => applyUserDataDir(app, { [USER_DATA_DIR_ENV]: "rel/dir" })).toThrow(USER_DATA_DIR_ENV);
    expect(app.setPath).not.toHaveBeenCalled();
  });
});
