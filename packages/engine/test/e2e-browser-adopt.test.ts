// A Chrome left running on a project's profile by an earlier engine is adopted — only when the system binds it to
// the profile (our uid, the profile's SingletonLock names its pid, it runs the configured Chrome, it listens on the
// DevTools port). A process that merely NAMES the profile and a port in its argv is neither connected to nor
// killed. Real Chrome, headless with the mock keychain; temp profiles.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBrowserManager, type BrowserManager } from "../src/browser.ts";
import { BrowserConfigSchema } from "../src/browser-config.ts";

const defaults = JSON.parse(readFileSync(new URL("../config.defaults.json", import.meta.url), "utf8")) as { browser: Record<string, unknown> };
const config = BrowserConfigSchema.parse({
  ...defaults.browser,
  headless: true,
  testMode: true,
  startTimeoutMs: 30000,
  cdpPortBase: 47000 + Math.floor(Math.random() * 20) * 100,
  cdpPortSpan: 100,
});
const haveChrome = existsSync(config.chromePath);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let root: string;
let manager: BrowserManager;
const logs: string[] = [];
const children: ChildProcess[] = [];
let fake: http.Server;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function answers(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  if (!haveChrome) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-e2e-adopt-")));
  const log = (level: string) => (msg: string, fields?: unknown) => logs.push(`${level} ${msg} ${JSON.stringify(fields ?? {})}`);
  manager = createBrowserManager({ config, dataDir: root, logger: { info: log("info"), warn: log("warn"), error: log("error") } });
  // An endpoint that looks like Chrome's DevTools: the spoofing process names its port.
  fake = http.createServer((_req, res) => {
    const port = (fake.address() as net.AddressInfo).port;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ Browser: "Chrome/1", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/x` }));
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
}, 60_000);

afterAll(async () => {
  if (!haveChrome) return;
  if (process.env.KOKPIT_E2E_LOG) (await import("node:fs")).appendFileSync(process.env.KOKPIT_E2E_LOG, logs.join("\n") + "\n----\n");
  await manager?.shutdown();
  for (const c of children) c.kill("SIGKILL");
  await new Promise<void>((r) => fake?.close(() => r()));
  await sleep(300);
  rmSync(root, { recursive: true, force: true });
}, 60_000);

describe.skipIf(!haveChrome)("adopting a Chrome left on a profile", { timeout: 90_000 }, () => {
  it("a real Chrome of ours on the profile is adopted (same process, same port)", async () => {
    const dir = join(root, config.profilesDirName, "eski");
    mkdirSync(dir, { recursive: true });
    const port = config.cdpPortBase + 99;
    const chrome = spawn(
      config.chromePath,
      [`--user-data-dir=${dir}`, "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`, "--no-first-run", "--headless=new", "--use-mock-keychain", "--password-store=basic", "about:blank"],
      { stdio: "ignore" },
    );
    children.push(chrome);
    // The leftover is up (its DevTools answers) before the engine looks for it.
    let up = false;
    for (let i = 0; i < 200 && !(up = await answers(port)); i++) await sleep(50);
    expect(up, "leftover Chrome answers on its DevTools port").toBe(true);
    await manager.open("eski");
    expect(manager.cdpUrlFor("eski")).toBe(`http://127.0.0.1:${port}`);
    expect(logs.some((l) => l.includes("reusing a running Chrome"))).toBe(true);
    expect(alive(chrome.pid!)).toBe(true);
    await manager.close("eski");
    await sleep(500);
    expect(alive(chrome.pid!)).toBe(false);
  });

  it("security: a process that only names the profile and a port in its argv is not adopted and not killed", async () => {
    const dir = join(root, config.profilesDirName, "hedef");
    mkdirSync(dir, { recursive: true });
    const fakePort = (fake.address() as net.AddressInfo).port;
    // argv is free text: this process claims to be the profile's Chrome on the fake endpoint's port.
    const spoof = spawn("/bin/bash", ["-c", `exec -a "Google Chrome --user-data-dir=${dir} --remote-debugging-port=${fakePort}" /bin/sleep 60`], {
      stdio: "ignore",
    });
    children.push(spoof);
    await sleep(300);
    await manager.open("hedef");
    expect(manager.cdpUrlFor("hedef")).not.toBe(`http://127.0.0.1:${fakePort}`);
    expect(logs.some((l) => l.includes("not provably its Chrome"))).toBe(true);
    expect(alive(spoof.pid!)).toBe(true);
    expect((await manager.state("hedef")).running).toBe(true);
    await manager.close("hedef");
    expect(alive(spoof.pid!)).toBe(true);
  });
});
