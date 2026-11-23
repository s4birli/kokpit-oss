// Gizli tarayıcı: pure helpers for the project Chrome's window mode (the running Chrome of a profile).
import { describe, expect, it } from "vitest";
import { findProfileChrome, lsofExecutable, lsofListenPorts, singletonLockPid, verifyProfileChrome } from "./browser-window.ts";

describe("findProfileChrome", () => {
  const dir = "/Volumes/Main Disk/kokpit-data/browser-profiles/Acme";
  const UID = 501;
  const ps = [
    `  101   501 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${dir} --remote-debugging-port=39300 --headless=new about:blank`,
    `  102   501 /Applications/Google Chrome.app/Contents/Frameworks/Helper --type=renderer --user-data-dir=${dir}`,
    `  103   501 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${dir}2 --remote-debugging-port=39301`,
    `  104   501 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
  ].join("\n");

  it("finds the browser process (not a helper) of exactly that profile, whether it is headless, and its argv port", () => {
    expect(findProfileChrome(ps, dir, UID)).toEqual({ pid: 101, headless: true, port: 39300 });
    expect(findProfileChrome(ps, `${dir}2`, UID)).toEqual({ pid: 103, headless: false, port: 39301 });
    expect(findProfileChrome(`  7 501 chrome --user-data-dir=/p --remote-debugging-port=99999`, "/p", UID)).toEqual({ pid: 7, headless: false, port: null });
    expect(findProfileChrome(`  7 501 chrome --user-data-dir=/p`, "/p", UID)).toEqual({ pid: 7, headless: false, port: null });
    expect(findProfileChrome(ps, "/other", UID)).toBeNull();
  });

  it("a profile path that is a prefix of another does not match it", () => {
    expect(findProfileChrome(ps.split("\n").slice(2).join("\n"), dir, UID)).toBeNull();
  });

  it("security: a process of ANOTHER user naming our profile in its argv is never a candidate", () => {
    // Any local user (a second macOS account) can put any text into its own command line.
    const spoof = `  666   502 /tmp/evil --user-data-dir=${dir} --remote-debugging-port=40000`;
    expect(findProfileChrome(spoof, dir, UID)).toBeNull();
    // Even listed first, before our own Chrome.
    expect(findProfileChrome(`${spoof}\n${ps}`, dir, UID)).toEqual({ pid: 101, headless: true, port: 39300 });
    expect(findProfileChrome(`  666 x ${dir}`, dir, UID)).toBeNull();
  });
});

describe("verifyProfileChrome: a Chrome left on a profile is adopted (or signalled) only when the system binds it to us", () => {
  const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const good = {
    candidate: { pid: 101, headless: true, port: 39300 },
    lockPid: 101,
    executable: chromePath,
    chromePath,
    listening: [39300],
    activePort: null,
  };

  it("all bindings hold: the pid, its mode and its DevTools port", () => {
    expect(verifyProfileChrome(good)).toEqual({ pid: 101, headless: true, port: 39300 });
    // The profile's own DevToolsActivePort wins over argv — and must also be the pid's listening port.
    expect(verifyProfileChrome({ ...good, activePort: 39305, listening: [39305] })).toEqual({ pid: 101, headless: true, port: 39305 });
  });

  it("refuses when the profile's SingletonLock names another pid (argv spoofed, or a stale Chrome)", () => {
    expect(verifyProfileChrome({ ...good, lockPid: 202 })).toBeNull();
    expect(verifyProfileChrome({ ...good, lockPid: null })).toBeNull();
  });

  it("refuses a process that is not the configured Chrome executable", () => {
    expect(verifyProfileChrome({ ...good, executable: "/tmp/evil" })).toBeNull();
    expect(verifyProfileChrome({ ...good, executable: null })).toBeNull();
  });

  it("refuses a port the pid does not listen on (another process's endpoint)", () => {
    expect(verifyProfileChrome({ ...good, listening: [40000] })).toBeNull();
    expect(verifyProfileChrome({ ...good, listening: [] })).toBeNull();
    expect(verifyProfileChrome({ ...good, activePort: 40000, listening: [39300] })).toBeNull();
    expect(verifyProfileChrome({ ...good, candidate: { ...good.candidate, port: null } })).toBeNull();
  });

  it("monkey: any single broken binding refuses", () => {
    let seed = 11;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 300; i++) {
      const breaks = {
        lockPid: rnd() < 0.3 ? Math.floor(rnd() * 1000) : 101,
        executable: rnd() < 0.3 ? "/bin/sh" : chromePath,
        listening: rnd() < 0.3 ? [Math.floor(rnd() * 65535)] : [39300],
      };
      const ok = breaks.lockPid === 101 && breaks.executable === chromePath && breaks.listening.includes(39300);
      expect(verifyProfileChrome({ ...good, ...breaks }) !== null).toBe(ok);
    }
  });
});

describe("system parsers", () => {
  it("lsof -Fn: only ports the pid listens on at exactly the address the engine connects to", () => {
    const out = "p101\nf33\nn127.0.0.1:39300\nf34\nn*:5000\nf35\nn[::1]:39301\nf36\nn192.168.1.2:7000\n";
    expect(lsofListenPorts(out, "127.0.0.1")).toEqual([39300]);
    expect(lsofListenPorts("", "127.0.0.1")).toEqual([]);
  });

  it("security: a Chrome listening on ::1 only does not prove 127.0.0.1:<port> (another process may hold that)", () => {
    expect(lsofListenPorts("p101\nf35\nn[::1]:39300\n", "127.0.0.1")).toEqual([]);
    // A wildcard listener is not proof either: another process may have bound 127.0.0.1 more specifically.
    expect(lsofListenPorts("p101\nf35\nn*:39300\n", "127.0.0.1")).toEqual([]);
  });

  it("lsof -d txt -Fn: the executable is the first file", () => {
    expect(lsofExecutable("p101\nftxt\nn/Applications/Google Chrome.app/Contents/MacOS/Google Chrome\nftxt\nn/usr/lib/dyld\n")).toBe(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );
    expect(lsofExecutable("p101\n")).toBeNull();
  });

  it("SingletonLock: <host>-<pid>", () => {
    expect(singletonLockPid("mac-mini.local-101")).toBe(101);
    expect(singletonLockPid("mac-mini-local")).toBeNull();
    expect(singletonLockPid("host-0")).toBeNull();
    expect(singletonLockPid("")).toBeNull();
  });
});
