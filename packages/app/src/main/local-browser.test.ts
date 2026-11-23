// @vitest-environment node
// İş B: Chrome on the app's machine for `runOn: "client"` projects.
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import defaults from "./browser.defaults.json" with { type: "json" };
import { CHROME_HEADLESS_ENV, CHROME_PATH_ENV, createLocalBrowser, localChromeArgs, resolveChromePath } from "./local-browser.ts";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("localChromeArgs", () => {
  it("own profile, no first-run UI, and never remote debugging", () => {
    const args = localChromeArgs({ profileDir: "/ud/browser-profiles/p1", headless: false });
    expect(args).toEqual(["--user-data-dir=/ud/browser-profiles/p1", "--no-first-run", "--no-default-browser-check"]);
    expect(args.join(" ")).not.toMatch(/remote-debugging/);
  });
  it("test mode only: headless and no macOS keychain prompt", () => {
    const args = localChromeArgs({ profileDir: "/x", headless: true });
    expect(args).toContain("--headless=new");
    expect(args).toContain("--use-mock-keychain");
    expect(args).toContain("--password-store=basic");
    const prod = localChromeArgs({ profileDir: "/x", headless: false });
    expect(prod).not.toContain("--use-mock-keychain");
    expect(prod).not.toContain("--password-store=basic");
  });
});

describe("resolveChromePath", () => {
  it("defaults to the shipped path; env overrides with an absolute path only", () => {
    expect(defaults.chromePath).toMatch(/^\//);
    expect(resolveChromePath({})).toBe(defaults.chromePath);
    expect(resolveChromePath({ [CHROME_PATH_ENV]: "/opt/chrome" })).toBe("/opt/chrome");
    expect(() => resolveChromePath({ [CHROME_PATH_ENV]: "chrome" })).toThrow(CHROME_PATH_ENV);
    expect(resolveChromePath({ [CHROME_PATH_ENV]: "" })).toBe(defaults.chromePath);
  });
});

describe("createLocalBrowser", () => {
  function setup(env: NodeJS.ProcessEnv = {}) {
    const userData = mkdtempSync(join(tmpdir(), "kokpit-local-browser-"));
    roots.push(userData);
    const calls: { file: string; args: string[]; opts: Record<string, unknown> }[] = [];
    const unref = vi.fn();
    const spawn = vi.fn((file: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ file, args, opts });
      return {
        unref,
        once: (ev: string, cb: () => void) => {
          if (ev === "spawn") queueMicrotask(cb);
        },
        off: () => {},
      };
    });
    const lb = createLocalBrowser({ userDataDir: userData, env, spawn: spawn as never });
    return { lb, calls, userData, unref };
  }

  it("spawns Chrome detached with <userData>/browser-profiles/<id>, creating the folder", async () => {
    const { lb, calls, userData, unref } = setup({ [CHROME_PATH_ENV]: "/opt/chrome" });
    await lb.open("p1");
    const dir = join(userData, defaults.profilesDirName, "p1");
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe("/opt/chrome");
    expect(calls[0]!.args).toContain(`--user-data-dir=${dir}`);
    expect(calls[0]!.opts).toMatchObject({ detached: true, stdio: "ignore" });
    expect(unref).toHaveBeenCalled();
  });

  it("a missing Chrome is reported in Turkish", async () => {
    const userData = mkdtempSync(join(tmpdir(), "kokpit-local-browser-"));
    roots.push(userData);
    const lb = createLocalBrowser({ userDataDir: userData, env: { [CHROME_PATH_ENV]: "/yok/chrome" } });
    await expect(lb.open("p1")).rejects.toThrow(/Chrome açılamadı/);
  });

  it("headless when the test env asks", async () => {
    const { lb, calls } = setup({ [CHROME_PATH_ENV]: "/opt/chrome", [CHROME_HEADLESS_ENV]: "1" });
    await lb.open("p1");
    expect(calls[0]!.args).toContain("--headless=new");
  });

  it.each(["", ".", "..", "../x", "a/b", "/abs", "-flag", "a b", 5, null, undefined, {}, "x".repeat(201)])(
    "refuses unsafe project id %j without spawning",
    async (id) => {
      const { lb, calls } = setup({ [CHROME_PATH_ENV]: "/opt/chrome" });
      await expect(lb.open(id as string)).rejects.toThrow(/geçersiz/i);
      expect(calls).toHaveLength(0);
    },
  );

  // Bağlantılar: a link from a terminal of a project whose browser runs on this machine.
  it("with an address: Chrome gets it as its last argument, normalized (it opens a tab in the profile's running Chrome)", async () => {
    const { lb, calls, userData } = setup({ [CHROME_PATH_ENV]: "/opt/chrome" });
    await lb.open("p1", "HTTP://LocalHost:3000/a?b=1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.at(-1)).toBe("http://localhost:3000/a?b=1");
    expect(calls[0]!.args[0]).toBe(`--user-data-dir=${join(userData, defaults.profilesDirName, "p1")}`);
    expect(calls[0]!.args.join(" ")).not.toMatch(/remote-debugging/);
  });

  it("without an address nothing is added", async () => {
    const { lb, calls } = setup({ [CHROME_PATH_ENV]: "/opt/chrome" });
    await lb.open("p1");
    expect(calls[0]!.args.some((a) => /^https?:/.test(a))).toBe(false);
  });

  it.each(["--remote-debugging-port=9222", "-x", "javascript:alert(1)", "file:///etc/passwd", "chrome://settings", "about:blank", "vscode://x", "https://u:p@example.com/", "https://example.com/ --flag", "", 5, null, {}])(
    "refuses the address %j without spawning: only http(s) ever becomes a Chrome argument",
    async (url) => {
      const { lb, calls } = setup({ [CHROME_PATH_ENV]: "/opt/chrome" });
      await expect(lb.open("p1", url)).rejects.toThrow(/adres/i);
      expect(calls).toHaveLength(0);
    },
  );
});
