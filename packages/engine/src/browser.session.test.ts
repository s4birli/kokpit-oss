// Session cookies (logins without an expiry) survive Chrome restarts: Chrome always starts with
// --restore-last-session ("Continue where you left off"). Writing session.restore_on_startup into the profile's
// Preferences does not work — Chrome resets that tracked pref when it was not written by Chrome itself.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chromeArgs, hasSavedSession, RESTORE_SESSION_ARG } from "./browser.ts";

const base = { profileDir: "/data/browser-profiles/p", port: 9333, headless: false, testMode: false, windowWidth: 1280, windowHeight: 800 };

describe("chromeArgs: session restore", () => {
  it("always restores the last session (tabs and session cookies), headless or not", () => {
    for (const o of [base, { ...base, headless: true, testMode: true }, { ...base, hasSavedSession: true }]) {
      expect(chromeArgs(o)).toContain(RESTORE_SESSION_ARG);
    }
    expect(RESTORE_SESSION_ARG).toBe("--restore-last-session");
  });

  it("opens about:blank only for a profile without a saved session (no extra blank tab per restart)", () => {
    expect(chromeArgs(base).at(-1)).toBe("about:blank");
    expect(chromeArgs({ ...base, hasSavedSession: false }).at(-1)).toBe("about:blank");
    expect(chromeArgs({ ...base, hasSavedSession: true })).not.toContain("about:blank");
  });
});

describe("chromeArgs: quiet (the Masaüstü's real Chrome)", () => {
  it("a visible Chrome with no startup window, no restored session (its windows would come back on screen) and no identity change", () => {
    const args = chromeArgs({ ...base, window: "visible", quiet: true, hasSavedSession: true });
    expect(args).toContain("--no-startup-window");
    expect(args).not.toContain(RESTORE_SESSION_ARG);
    expect(args).not.toContain("about:blank");
    expect(args.some((a) => a.startsWith("--headless"))).toBe(false);
    expect(args.some((a) => a.startsWith("--user-agent"))).toBe(false);
    // Kept painting while minimized: the stream is its only viewer.
    for (const flag of ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"]) {
      expect(args).toContain(flag);
    }
    // Same hardening as every Chrome: DevTools on loopback only.
    expect(args).toContain("--remote-debugging-address=127.0.0.1");
  });

  it("not quiet: as before", () => {
    expect(chromeArgs({ ...base, window: "visible" })).not.toContain("--no-startup-window");
  });
});

describe("hasSavedSession", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-sessions-")));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is true once Chrome wrote Default/Sessions into the profile", () => {
    expect(hasSavedSession(dir)).toBe(false);
    mkdirSync(join(dir, "Default"));
    expect(hasSavedSession(dir)).toBe(false);
    mkdirSync(join(dir, "Default", "Sessions"));
    expect(hasSavedSession(dir)).toBe(true);
  });

  it("a missing profile folder is simply false", () => {
    expect(hasSavedSession(join(dir, "yok"))).toBe(false);
  });
});
