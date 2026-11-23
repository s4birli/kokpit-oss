import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliDeps, type RunResult } from "../scripts/launchd.ts";
import {
  buildPlistOptions,
  fullDiskAccessNotice,
  launchctlCommands,
  parseLaunchctlPrint,
  renderPlist,
  resolveLabel,
  stableNodePath,
  xmlEscape,
  type PlistOptions,
} from "./launchd.ts";

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "kokpit-launchd-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const nasty = "/Volumes/A & B <x> \"q\" 'y'/data";

function sample(over: Partial<PlistOptions> = {}): PlistOptions {
  return {
    label: "test.kokpit.engine",
    programArguments: ["/bin/node", "/repo/src/main.ts"],
    workingDirectory: "/home/someone",
    environment: {
      PATH: "/usr/bin:/bin",
      HOME: "/home/someone",
      KOKPIT_CONFIG: `${nasty}/engine.json`,
    },
    stdoutPath: "/home/someone/Library/Logs/kokpit/engine.out.log",
    stderrPath: "/home/someone/Library/Logs/kokpit/engine.err.log",
    keepAlive: true,
    throttleInterval: 10,
    runAtLoad: true,
    ...over,
  };
}

function plutilLint(xml: string): { status: number | null; out: string } {
  const f = join(tmp(), "x.plist");
  writeFileSync(f, xml);
  const r = spawnSync("plutil", ["-lint", f], { encoding: "utf8" });
  return { status: r.status, out: r.stdout + r.stderr };
}

function plistToJson(xml: string): Record<string, unknown> {
  const f = join(tmp(), "j.plist");
  writeFileSync(f, xml);
  return JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", f], { encoding: "utf8" }));
}

describe("xmlEscape", () => {
  it("escapes the five XML special characters", () => {
    expect(xmlEscape(`a&b<c>d"e'f`)).toBe("a&amp;b&lt;c&gt;d&quot;e&apos;f");
  });
});

describe("renderPlist", () => {
  it("escapes paths with spaces, & and <", () => {
    const xml = renderPlist(sample());
    expect(xml).toContain("/Volumes/A &amp; B &lt;x&gt;");
    expect(xml).not.toContain("A & B");
    expect(xml).not.toContain("<x>");
  });

  it.runIf(process.platform === "darwin")("passes plutil -lint and round-trips every value", () => {
    const opts = sample();
    const xml = renderPlist(opts);
    expect(plutilLint(xml).status).toBe(0);
    const p = plistToJson(xml);
    expect(p.Label).toBe(opts.label);
    expect(p.ProgramArguments).toEqual(opts.programArguments);
    expect(p.WorkingDirectory).toBe(opts.workingDirectory);
    expect(p.EnvironmentVariables).toEqual(opts.environment);
    expect(p.StandardOutPath).toBe(opts.stdoutPath);
    expect(p.StandardErrorPath).toBe(opts.stderrPath);
    expect(p.KeepAlive).toBe(true);
    expect(p.RunAtLoad).toBe(true);
    expect(p.ThrottleInterval).toBe(10);
    expect(p.ProcessType).toBe("Interactive");
  });

  it("renders false booleans and has KeepAlive/RunAtLoad keys", () => {
    const xml = renderPlist(sample({ keepAlive: false, runAtLoad: false }));
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<false\/>/);
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/);
    expect(xml).toContain("<key>KOKPIT_CONFIG</key>");
    expect(xml).not.toContain("KOKPIT_WAIT");
  });

  it("rejects a non-integer throttle interval", () => {
    expect(() => renderPlist(sample({ throttleInterval: 1.5 }))).toThrow();
    expect(() => renderPlist(sample({ throttleInterval: -1 }))).toThrow();
  });

  it("strips characters XML 1.0 cannot carry", () => {
    const xml = renderPlist(sample({ label: "a\u0000b\u001Fc" }));
    expect(xml).toContain("<string>abc</string>");
  });
});

describe("resolveLabel", () => {
  it("prefers flag, then env, then default", () => {
    expect(resolveLabel({ flag: "a", env: "b", fallback: "c" })).toBe("a");
    expect(resolveLabel({ env: "b", fallback: "c" })).toBe("b");
    expect(resolveLabel({ env: "", fallback: "c" })).toBe("c");
  });

  it("rejects labels that are unsafe as a file name", () => {
    expect(() => resolveLabel({ flag: "../evil", fallback: "c" })).toThrow();
    expect(() => resolveLabel({ flag: "a b", fallback: "c" })).toThrow();
  });
});

describe("buildPlistOptions", () => {
  const input = {
    label: "test.label",
    configPath: "/Volumes/Main Disk/cfg/engine.json",
    nodePath: "/opt/node",
    entryPath: "/repo/packages/engine/src/main.ts",
    env: { PATH: "/a:/b", HOME: "/h", SHELL: "/bin/zsh", LANG: "tr_TR.UTF-8" },
    defaultLang: "en_US.UTF-8",
    logDir: "Library/Logs/kokpit",
    throttleInterval: 10,
  };

  it("runs node directly from HOME with logs under HOME/logDir", () => {
    const o = buildPlistOptions(input);
    expect(o.programArguments).toEqual([input.nodePath, input.entryPath]);
    expect(o.workingDirectory).toBe("/h");
    expect(o.environment.KOKPIT_CONFIG).toBe(input.configPath);
    expect(Object.keys(o.environment).filter((k) => k.startsWith("KOKPIT_WAIT"))).toEqual([]);
    expect(o.environment.LANG).toBe("tr_TR.UTF-8");
    expect(o.environment.SHELL).toBe("/bin/zsh");
    expect(o.stdoutPath).toBe("/h/Library/Logs/kokpit/engine.out.log");
    expect(o.stderrPath).toBe("/h/Library/Logs/kokpit/engine.err.log");
    expect(o.keepAlive).toBe(true);
    expect(o.runAtLoad).toBe(true);
    expect(o.throttleInterval).toBe(10);
  });

  it("puts node's own directory on PATH when missing and falls back for LANG", () => {
    const o = buildPlistOptions({ ...input, env: { PATH: "/a", HOME: "/h" } });
    expect(o.environment.PATH).toBe("/opt:/a");
    expect(o.environment.LANG).toBe("en_US.UTF-8");
    expect(o.environment.SHELL).toBeUndefined();
  });

  it("drops duplicate and empty PATH entries, keeping first occurrence order", () => {
    const o = buildPlistOptions({ ...input, env: { PATH: "/a::/opt:/b:/a:/opt", HOME: "/h" } });
    expect(o.environment.PATH).toBe("/a:/opt:/b");
  });

  it("requires an absolute HOME and a relative logDir inside it", () => {
    expect(() => buildPlistOptions({ ...input, env: { PATH: "/a" } })).toThrow(/HOME/);
    expect(() => buildPlistOptions({ ...input, env: { PATH: "/a", HOME: "rel" } })).toThrow(/HOME/);
    expect(() => buildPlistOptions({ ...input, logDir: "/abs/logs" })).toThrow(/logDir/);
    expect(() => buildPlistOptions({ ...input, logDir: "../escape" })).toThrow(/logDir/);
    expect(() => buildPlistOptions({ ...input, logDir: "" })).toThrow(/logDir/);
  });
});

describe("fullDiskAccessNotice", () => {
  it("names the binary and gives the Turkish System Settings path", () => {
    const n = fullDiskAccessNotice("/opt/homebrew/Cellar/node/25.1.0/bin/node");
    expect(n).toContain("/opt/homebrew/Cellar/node/25.1.0/bin/node");
    expect(n).toContain("Sistem Ayarları › Gizlilik ve Güvenlik › Tam Disk Erişimi");
    expect(n).toContain("Cmd+Shift+G");
  });
});

describe("stableNodePath", () => {
  const real: Record<string, string> = {
    "/brew/bin/node": "/brew/Cellar/node/25.1/bin/node",
    "/brew/Cellar/node/25.1/bin/node": "/brew/Cellar/node/25.1/bin/node",
    "/other/bin/node": "/other/real/node",
  };
  const realpath = (p: string): string | null => real[p] ?? null;

  it("prefers a PATH symlink that resolves to the running node (survives upgrades)", () => {
    expect(stableNodePath("/brew/Cellar/node/25.1/bin/node", "/other/bin:/brew/bin", realpath)).toBe("/brew/bin/node");
  });

  it("falls back to execPath when no PATH entry resolves to it", () => {
    expect(stableNodePath("/brew/Cellar/node/25.1/bin/node", "/other/bin:/nowhere", realpath)).toBe(
      "/brew/Cellar/node/25.1/bin/node",
    );
    expect(stableNodePath("/x/node", undefined, realpath)).toBe("/x/node");
  });
});

describe("launchctlCommands", () => {
  it("targets the gui domain of the uid", () => {
    const c = launchctlCommands(501, "x.y", "/p/x.y.plist");
    expect(c.bootout).toEqual(["bootout", "gui/501/x.y"]);
    expect(c.bootstrap).toEqual(["bootstrap", "gui/501", "/p/x.y.plist"]);
    expect(c.kickstart).toEqual(["kickstart", "-k", "gui/501/x.y"]);
    expect(c.print).toEqual(["print", "gui/501/x.y"]);
  });
});

describe("parseLaunchctlPrint", () => {
  it("extracts the summary fields", () => {
    const out = [
      "gui/501/x.y = {",
      "\tactive count = 1",
      "\tpath = /Users/u/Library/LaunchAgents/x.y.plist",
      "\tstate = running",
      "\truns = 3",
      "\tpid = 4242",
      "\tlast exit code = 1",
      "\tenvironment = {",
      "\t\tstate = nested-should-be-ignored",
      "\t}",
      "}",
    ].join("\n");
    expect(parseLaunchctlPrint(out)).toEqual({
      state: "running",
      pid: 4242,
      runs: 3,
      lastExitCode: "1",
      path: "/Users/u/Library/LaunchAgents/x.y.plist",
    });
  });

  it("handles an empty output", () => {
    expect(parseLaunchctlPrint("")).toEqual({ state: null, pid: null, runs: null, lastExitCode: null, path: null });
  });
});

// ---------------------------------------------------------------- CLI ----
const ENGINE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ENGINE_DIR, "scripts", "launchd.ts");

interface Fake {
  deps: CliDeps;
  calls: string[];
  files: Map<string, string>;
  out: string[];
  err: string[];
}

const LAUNCHD_DEFAULTS = JSON.parse(readFileSync(join(ENGINE_DIR, "launchd", "defaults.json"), "utf8")) as {
  bootoutPollMs: number;
  bootoutMaxPolls: number;
  bootstrapRetries: number;
  bootstrapRetryDelayMs: number;
  bootstrapRetryExitCodes: number[];
};
/** launchctl print's exit status for "Could not find service". */
const NOT_FOUND = 113;

function fake(
  opts: {
    config?: unknown;
    failBootout?: boolean;
    printOut?: string;
    printStatus?: number;
    /** After bootout, `print` still finds the service this many times. */
    lingerPolls?: number;
    /** Exit codes of successive bootstrap attempts; afterwards 0. */
    bootstrapExits?: number[];
  } = {},
): Fake & { sleeps: number[] } {
  const sleeps: number[] = [];
  let bootedOut = false;
  let linger = opts.lingerPolls ?? 0;
  const bootstrapExits = [...(opts.bootstrapExits ?? [])];
  const calls: string[] = [];
  const files = new Map<string, string>();
  const out: string[] = [];
  const err: string[] = [];
  if (opts.config !== undefined) files.set("/cfg/engine.json", JSON.stringify(opts.config));
  const deps: CliDeps = {
    homedir: "/home/tester",
    uid: 4321,
    env: { PATH: "/usr/bin", HOME: "/home/tester", SHELL: "/bin/zsh" },
    execPath: "/opt/node/bin/node",
    cwd: "/cfg",
    realpath: (p) => (p === "/opt/node/bin/node" ? "/opt/node/Cellar/25.1/bin/node" : p),
    readFile: (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    writeFile: (p, d) => {
      calls.push(`write ${p}`);
      files.set(p, d);
    },
    mkdirp: (p) => void calls.push(`mkdir ${p}`),
    remove: (p) => {
      calls.push(`rm ${p}`);
      files.delete(p);
    },
    exists: (p) => files.has(p),
    run: (cmd, args): RunResult => {
      calls.push(`${cmd} ${args.join(" ")}`);
      if (cmd === "launchctl" && args[0] === "bootout") {
        bootedOut = true;
        if (opts.failBootout) return { status: 3, stdout: "", stderr: "No such process" };
      }
      if (cmd === "launchctl" && args[0] === "print") {
        if (bootedOut) {
          if (linger-- > 0) return { status: 0, stdout: "state = not running", stderr: "" };
          return { status: NOT_FOUND, stdout: "", stderr: "Could not find service" };
        }
        return { status: opts.printStatus ?? 0, stdout: opts.printOut ?? "", stderr: "" };
      }
      if (cmd === "launchctl" && args[0] === "bootstrap") {
        const status = bootstrapExits.shift() ?? 0;
        if (status !== 0) return { status, stdout: "", stderr: `Bootstrap failed: ${status}: Input/output error` };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    sleep: async (ms) => void sleeps.push(ms),
    stdout: (s) => void out.push(s),
    stderr: (s) => void err.push(s),
  };
  return { deps, calls, files, out, err, sleeps };
}

const cfg = { dataDir: "/Volumes/Main Disk/kokpit-data", port: 1 };

describe("launchd CLI (injected side effects)", () => {
  it("install --dry-run prints plist and commands, performs nothing", async () => {
    const f = fake({ config: cfg });
    const code = await runCli(["install", "--config", "/cfg/engine.json", "--dry-run"], f.deps);
    expect(code).toBe(0);
    const text = f.out.join("");
    expect(text).toContain("<string>/cfg/engine.json</string>");
    expect(text).not.toContain("run-engine.sh");
    expect(text).not.toContain("KOKPIT_WAIT");
    expect(text).toContain("<string>/home/tester/Library/Logs/kokpit/engine.err.log</string>");
    expect(text).toContain("mkdir -p /home/tester/Library/Logs/kokpit");
    expect(text).toContain("/opt/node/Cellar/25.1/bin/node");
    expect(text).toContain("Tam Disk Erişimi");
    expect(text).toContain("launchctl bootstrap gui/4321");
    expect(text).toContain("launchctl print gui/4321/dev.kokpit.engine  # repeated until not found");
    expect(text).toContain("/home/tester/Library/LaunchAgents/dev.kokpit.engine.plist");
    expect(f.calls).toEqual([]);
  });

  it("install writes the plist, lints it and (re)loads the agent in order", async () => {
    const f = fake({ config: cfg, failBootout: true });
    const code = await runCli(["install", "--config", "engine.json", "--label", "x.test"], f.deps);
    expect(code).toBe(0);
    const plist = "/home/tester/Library/LaunchAgents/x.test.plist";
    expect(f.calls).toEqual([
      "mkdir /home/tester/Library/Logs/kokpit",
      "mkdir /home/tester/Library/LaunchAgents",
      `write ${plist}`,
      `plutil -lint ${plist}`,
      "launchctl bootout gui/4321/x.test",
      "launchctl print gui/4321/x.test",
      `launchctl bootstrap gui/4321 ${plist}`,
      "launchctl kickstart -k gui/4321/x.test",
    ]);
    expect(f.files.get(plist)).toContain("<string>x.test</string>");
    expect(f.files.get(plist)).toContain("<string>/opt/node/bin/node</string>");
    expect(f.files.get(plist)).toContain(`<string>${join(ENGINE_DIR, "src", "main.ts")}</string>`);
    expect(f.out.join("")).toContain("/opt/node/Cellar/25.1/bin/node");
  });

  const lc = (f: { calls: string[] }, verb: string) => f.calls.filter((c) => c.startsWith(`launchctl ${verb} `));

  it("install waits after bootout until launchd no longer knows the service, then bootstraps", async () => {
    const f = fake({ config: cfg, lingerPolls: 3 });
    expect(await runCli(["install", "--config", "/cfg/engine.json"], f.deps)).toBe(0);
    expect(lc(f, "print")).toHaveLength(4);
    expect(f.sleeps).toEqual(Array(3).fill(LAUNCHD_DEFAULTS.bootoutPollMs));
    const bootout = f.calls.findIndex((c) => c.startsWith("launchctl bootout"));
    const lastPrint = f.calls.findLastIndex((c) => c.startsWith("launchctl print"));
    const bootstrap = f.calls.findIndex((c) => c.startsWith("launchctl bootstrap"));
    expect(bootout).toBeLessThan(lastPrint);
    expect(lastPrint).toBeLessThan(bootstrap);
  });

  it("install stops polling after bootoutMaxPolls, warns, and still bootstraps", async () => {
    const f = fake({ config: cfg, lingerPolls: 10_000 });
    expect(await runCli(["install", "--config", "/cfg/engine.json"], f.deps)).toBe(0);
    expect(lc(f, "print")).toHaveLength(LAUNCHD_DEFAULTS.bootoutMaxPolls);
    expect(f.err.join("")).toMatch(/still/i);
    expect(lc(f, "bootstrap")).toHaveLength(1);
  });

  it("install retries bootstrap on exit 5 (bootout still in progress) after a short delay", async () => {
    const f = fake({ config: cfg, bootstrapExits: [5] });
    expect(await runCli(["install", "--config", "/cfg/engine.json"], f.deps)).toBe(0);
    expect(lc(f, "bootstrap")).toHaveLength(2);
    expect(f.sleeps).toEqual([LAUNCHD_DEFAULTS.bootstrapRetryDelayMs]);
    expect(lc(f, "kickstart")).toHaveLength(1);
  });

  it("install gives up after bootstrapRetries and reports the launchctl error", async () => {
    const f = fake({ config: cfg, bootstrapExits: Array(50).fill(5) });
    expect(await runCli(["install", "--config", "/cfg/engine.json"], f.deps)).not.toBe(0);
    expect(lc(f, "bootstrap")).toHaveLength(LAUNCHD_DEFAULTS.bootstrapRetries + 1);
    expect(f.err.join("")).toContain("Input/output error");
    expect(lc(f, "kickstart")).toEqual([]);
  });

  it("install does not retry bootstrap on other exit codes", async () => {
    const f = fake({ config: cfg, bootstrapExits: [37] });
    expect(await runCli(["install", "--config", "/cfg/engine.json"], f.deps)).not.toBe(0);
    expect(lc(f, "bootstrap")).toHaveLength(1);
    expect(f.sleeps).toEqual([]);
  });

  it("label falls back to KOKPIT_LAUNCHD_LABEL", async () => {
    const f = fake({ config: cfg });
    f.deps.env.KOKPIT_LAUNCHD_LABEL = "env.label";
    await runCli(["install", "--config", "/cfg/engine.json", "--dry-run"], f.deps);
    expect(f.out.join("")).toContain("<string>env.label</string>");
  });

  it("install stops before launchctl when plutil rejects the plist", async () => {
    const f = fake({ config: cfg });
    const run = f.deps.run;
    f.deps.run = (cmd, args) => (cmd === "plutil" ? { status: 1, stdout: "", stderr: "bad" } : run(cmd, args));
    const code = await runCli(["install", "--config", "/cfg/engine.json"], f.deps);
    expect(code).not.toBe(0);
    expect(f.calls.some((c) => c.startsWith("launchctl"))).toBe(false);
  });

  it("install fails clearly on a missing config, missing dataDir or relative dataDir", async () => {
    for (const [config, msg] of [
      [undefined, /engine\.json/],
      [{ port: 1 }, /dataDir/],
      [{ dataDir: "rel/data" }, /dataDir/],
    ] as const) {
      const f = fake({ config });
      const code = await runCli(["install", "--config", "/cfg/engine.json"], f.deps);
      expect(code).not.toBe(0);
      expect(f.err.join("")).toMatch(msg);
      expect(f.calls).toEqual([]);
    }
  });

  it("install requires --config", async () => {
    const f = fake();
    expect(await runCli(["install"], f.deps)).not.toBe(0);
    expect(f.err.join("")).toContain("--config");
  });

  it("uninstall boots out and removes the plist", async () => {
    const f = fake();
    const plist = "/home/tester/Library/LaunchAgents/dev.kokpit.engine.plist";
    f.files.set(plist, "x");
    expect(await runCli(["uninstall"], f.deps)).toBe(0);
    expect(f.calls).toEqual(["launchctl bootout gui/4321/dev.kokpit.engine", `rm ${plist}`]);
  });

  it("status summarises launchctl print", async () => {
    const f = fake({
      printOut: "gui/4321/dev.kokpit.engine = {\n\tstate = running\n\tpid = 99\n\truns = 2\n\tlast exit code = (never exited)\n}\n",
    });
    expect(await runCli(["status"], f.deps)).toBe(0);
    const text = f.out.join("");
    expect(text).toContain("running");
    expect(text).toContain("99");
    expect(f.calls).toEqual(["launchctl print gui/4321/dev.kokpit.engine"]);
  });

  it("status reports a not-loaded agent with a non-zero exit", async () => {
    const f = fake({ printStatus: 113 });
    expect(await runCli(["status"], f.deps)).not.toBe(0);
    expect(f.out.join("") + f.err.join("")).toMatch(/not loaded/i);
  });

  it("print renders the plist on stdout, the Full Disk Access binary on stderr, without side effects", async () => {
    const f = fake({ config: cfg });
    expect(await runCli(["print", "--config", "/cfg/engine.json"], f.deps)).toBe(0);
    expect(f.out.join("")).toMatch(/^<\?xml/);
    expect(f.out.join("")).toMatch(/<\/plist>\n$/);
    expect(f.err.join("")).toContain("/opt/node/Cellar/25.1/bin/node");
    expect(f.calls).toEqual([]);
  });

  it("unknown command prints usage and fails", async () => {
    const f = fake();
    expect(await runCli(["frobnicate"], f.deps)).not.toBe(0);
    expect(f.err.join("")).toMatch(/usage/i);
  });
});

describe("launchd CLI (real process)", () => {
  it("--dry-run prints a plist with the config path and never touches ~/Library", () => {
    const home = tmp();
    const dataDir = join(home, "data & <stuff>");
    const configPath = join(home, "my config & <x>.json");
    writeFileSync(configPath, JSON.stringify({ dataDir }));
    const r = spawnSync(process.execPath, [CLI, "install", "--config", configPath, "--dry-run"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: home },
    });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`<string>${join(home, "my config &amp; &lt;x&gt;.json")}</string>`);
    expect(existsSync(join(home, "Library"))).toBe(false);
    expect(existsSync(join(dataDir, "logs"))).toBe(false);
    expect(r.stdout).toContain(`<string>${home}</string>`);
    expect(r.stdout).toContain(join(home, "Library", "Logs", "kokpit", "engine.out.log"));
    expect(r.stdout).toContain(realpathSync(process.execPath));
    expect(r.stdout).not.toContain("run-engine.sh");
    const xml = r.stdout.slice(r.stdout.indexOf("<?xml"), r.stdout.indexOf("</plist>") + "</plist>".length);
    if (process.platform === "darwin") expect(plutilLint(xml).status).toBe(0);
  });

  it("defaults.json holds the generic label and timing defaults", () => {
    const d = JSON.parse(readFileSync(join(ENGINE_DIR, "launchd", "defaults.json"), "utf8"));
    expect(d.label).toBe("dev.kokpit.engine");
    expect(d.logDir).toBe("Library/Logs/kokpit");
    expect(d.waitSeconds).toBeUndefined();
    expect(Number.isInteger(d.throttleInterval)).toBe(true);
    for (const k of ["bootoutPollMs", "bootoutMaxPolls", "bootstrapRetries", "bootstrapRetryDelayMs"]) {
      expect(Number.isInteger(d[k]) && d[k] > 0, k).toBe(true);
    }
    expect(d.bootstrapRetryExitCodes).toEqual([5]);
  });
});
