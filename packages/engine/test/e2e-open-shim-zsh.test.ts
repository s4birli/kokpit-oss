// Yollar: Kokpit's `open` must be the one a LOGIN zsh finds — the default terminal on macOS. A login zsh runs
// `path_helper` (/etc/zprofile), which moves /usr/bin to the front of PATH, and the user's rc files may reorder it
// again; so the terminal starts through wrappers/zsh/.zshenv. This runs the real engine with /bin/zsh -l and a temp
// ZDOTDIR standing in for the user's (never the real ~/.zshrc), and checks that the user's shell is otherwise
// exactly what it was: every rc file read once, in order, from the user's own ZDOTDIR.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, startEngine, stopEngine, type EngineProc } from "./harness.ts";

const KEY = randomBytes(32).toString("base64url");
const ZSH = "/bin/zsh";
const haveZsh = existsSync(ZSH);
const WAIT_MS = 20_000;
const SHIM_DIR = join(fileURLToPath(new URL("..", import.meta.url)), "wrappers", "bin");

let root: string;
let userZdotdir: string;
let rcLog: string;
let openedLog: string;
let engine: EngineProc | undefined;
let c: Client;
let terminalId: string;
let nextMarker = 0;

async function run(command: string): Promise<string> {
  const marker = `BITTI_${++nextMarker}_`;
  c.input(terminalId, `${command}; printf '%s%s\\n' '${marker}' "$?"\r`);
  return c.waitForOutput(terminalId, new RegExp(`${marker}\\d+\\r?\\n`), WAIT_MS);
}

beforeAll(async () => {
  if (!haveZsh) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-e2e-open-zsh-")));
  userZdotdir = join(root, "kullanici-zsh");
  rcLog = join(root, "rc.log");
  openedLog = join(root, "opened.log");
  mkdirSync(userZdotdir);
  mkdirSync(join(root, "home"));
  mkdirSync(join(root, "proje"));
  const fakeOpen = join(root, "fake-open");
  writeFileSync(fakeOpen, `#!/bin/sh\nprintf 'RUN %s\\n' "$*" >> '${openedLog}'\n`);
  chmodSync(fakeOpen, 0o755);
  // The user's own rc files: each leaves a line; .zshrc puts /usr/bin first again, as some setups do.
  writeFileSync(join(userZdotdir, ".zshenv"), `print -r -- "zshenv ZDOTDIR=$ZDOTDIR" >> '${rcLog}'\nexport KULLANICI_ZSHENV=okundu\n`);
  writeFileSync(join(userZdotdir, ".zprofile"), `print -r -- "zprofile" >> '${rcLog}'\n`);
  writeFileSync(join(userZdotdir, ".zshrc"), `print -r -- "zshrc" >> '${rcLog}'\nPATH="/usr/bin:$PATH"\nPS1='%% '\nprecmd_functions+=(kullanici_precmd)\nkullanici_precmd() { : }\n`);
  writeFileSync(join(userZdotdir, ".zlogin"), `print -r -- "zlogin" >> '${rcLog}'\n`);
  const configPath = join(root, "engine.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      dataDir: join(root, "data"),
      port: 0,
      shell: ZSH,
      shellArgs: ["-l"],
      listenTailscale: false,
      flushIntervalMs: 100,
      killGraceMs: 200,
      browser: { headless: true, testMode: true },
      files: { open: { realOpenPath: fakeOpen } },
    }),
  );
  engine = await startEngine({ KOKPIT_CONFIG: configPath, KOKPIT_KEY: KEY, HOME: join(root, "home"), KOKPIT_TERMINAL_ZDOTDIR: userZdotdir });
  c = await Client.connect(engine.port, KEY);
  await c.req("settings.update", { defaultToolId: null });
  const { project } = await c.req<{ project: { id: string } }>("projects.create", { name: "zsh", location: { kind: "local", path: join(root, "proje") } });
  terminalId = (await c.req<{ terminal: { id: string } }>("terminal.open", { projectId: project.id, cols: 200, rows: 30 })).terminal.id;
}, 60_000);

afterAll(async () => {
  if (!haveZsh) return;
  await c?.close();
  await stopEngine(engine);
  rmSync(root, { recursive: true, force: true });
}, 60_000);

describe.skipIf(!haveZsh)("Yollar: login zsh'te open Kokpit'inkidir", { timeout: 120_000 }, () => {
  it("`open` resolves to Kokpit's shim although path_helper and the user's .zshrc put /usr/bin first", async () => {
    const out = await run("printf 'OPEN=[%s]\\n' \"$(command -v open)\"");
    expect(out).toContain(`OPEN=[${join(SHIM_DIR, "open")}]`);
    // The last match: the first is the command line as the terminal echoed it.
    const path = [...(await run("printf 'YOL=[%s]\\n' \"$PATH\"")).matchAll(/YOL=\[([^\]]*)\]/g)].at(-1)![1]!.split(":");
    expect(path[0]).toBe(SHIM_DIR);
    expect(path.filter((p) => p === SHIM_DIR)).toHaveLength(1);
    expect(path).toContain("/usr/bin");
  });

  it("the user's shell is otherwise untouched: every rc file read once, in order, from the user's own ZDOTDIR", async () => {
    const out = await run("printf 'ZD=[%s] ENV=[%s] KOKPIT=[%s]\\n' \"$ZDOTDIR\" \"$KULLANICI_ZSHENV\" \"${KOKPIT_USER_ZDOTDIR-yok}\"");
    expect(out).toContain(`ZD=[${userZdotdir}] ENV=[okundu] KOKPIT=[yok]`);
    expect(readFileSync(rcLog, "utf8").trim().split("\n")).toEqual([`zshenv ZDOTDIR=${userZdotdir}`, "zprofile", "zshrc", "zlogin"]);
    // The one-time hook removed itself and left the user's own hook alone.
    const hooks = await run("printf 'HOOKS=[%s]\\n' \"$precmd_functions\"");
    expect(hooks).toContain("HOOKS=[kullanici_precmd]");
    // A shell started from this one starts like any zsh of the user: not through Kokpit's file again.
    const nested = await run(`${ZSH} -c 'printf "IC=[%s]\\n" "$ZDOTDIR"'`);
    expect(nested).toContain(`IC=[${userZdotdir}]`);
  });

  it("the shim hands what is not a page or an address to the (fake) real open", async () => {
    await run("open -a Safari x.html");
    await run("open .");
    expect(readFileSync(openedLog, "utf8").trim().split("\n")).toEqual(["RUN -a Safari x.html", "RUN ."]);
  });
});
