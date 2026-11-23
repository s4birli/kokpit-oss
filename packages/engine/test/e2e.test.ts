// End-to-end: runs the real engine (`node src/main.ts`) as a child process against a
// temp data dir and a temp git repo, and drives it over WebSocket like the app does.
// Maps to SPEC-adim-1 "Bitti sayılır" items 1 (key), 2, 3, 4, 5, 6 and 7 (records survive restart).
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { CLOSE_CODES, type ServerMessage } from "@kokpit/shared";
import { authenticate } from "../src/ws-auth-client.ts";
import { Client as HarnessClient, escapeRe, startEngine as startProc, stopEngine as stopProc, type EngineProc } from "./harness.ts";

const KEY = randomBytes(32).toString("base64url");

let root: string;
let repo: string;
let dataDir: string;
let configPath: string;
let engine: EngineProc | undefined;
let port: number;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}


async function startEngine(): Promise<number> {
  // ZDOTDIR as an engine started from a dev shell would have it: terminals must never get it.
  engine = await startProc({ KOKPIT_CONFIG: configPath, KOKPIT_KEY: KEY, HOME: join(root, "home"), ZDOTDIR: join(root, "leaked-zdotdir") });
  return engine.port;
}

async function stopEngine(): Promise<void> {
  await stopProc(engine);
  engine = undefined;
}

const Client = { connect: (key = KEY) => HarnessClient.connect(port, key) };

type CardT = { id: string; branch: string; worktreePath: string; projectId: string };
type TermT = { id: string; status: string; cardId: string };

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-e2e-")));
  repo = join(root, "repo");
  dataDir = join(root, "data");
  mkdirSync(join(root, "home"));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "README.md"), "e2e\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  configPath = join(root, "engine.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      dataDir,
      port: 0,
      shell: "/bin/sh",
      shellArgs: [],
      listenTailscale: false,
      flushIntervalMs: 100,
      killGraceMs: 200,
      projects: [{ name: "E2E Proje", repoPath: repo, id: "e2e" }],
    }),
  );
  port = await startEngine();
  // These scenarios type into plain shells; the seeded global default tool (claude) would take the input.
  const c = await Client.connect();
  await c.req("settings.update", { defaultToolId: null });
  await c.close();
}, 30000);

afterAll(async () => {
  await stopEngine();
  rmSync(root, { recursive: true, force: true });
});

describe("engine end-to-end", () => {
  it("rejects a wrong key with 4401 (Bitti 1)", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((r) => ws.once("open", r));
    void authenticate(ws, "wrong-key-wrong-key-wrong").catch(() => {});
    const code = await new Promise<number>((r) => ws.once("close", (c) => r(c)));
    expect(code).toBe(CLOSE_CODES.UNAUTHORIZED);
  });

  let card: CardT;
  let card2: CardT;

  it("lists projects from config and creates a card as worktree + branch (Bitti 2)", async () => {
    const c = await Client.connect();
    const { projects } = await c.req<{ projects: { id: string; name: string }[] }>("projects.list", {});
    // config project + built-ins ("Mac mini", İş B "Browser tasks")
    expect(projects.map((p) => p.id).sort()).toEqual(["e2e", "mac-mini", "web-tasks"]);
    ({ card } = await c.req<{ card: CardT }>("cards.create", { projectId: "e2e", name: "İlk Kart" }));
    expect(existsSync(card.worktreePath)).toBe(true);
    expect(card.worktreePath.startsWith(join(dataDir, "worktrees"))).toBe(true);
    expect(git(repo, "branch", "--list", card.branch)).toContain(card.branch);
    expect(git(repo, "worktree", "list")).toContain(card.worktreePath);
    await c.close();
  });

  it("opens two terminals in one card, both starting in the worktree (Bitti 3)", async () => {
    const c = await Client.connect();
    const { terminal: t1 } = await c.req<{ terminal: TermT }>("terminal.open", { cardId: card.id, cols: 80, rows: 24, command: "pwd" });
    const { terminal: t2 } = await c.req<{ terminal: TermT }>("terminal.open", { cardId: card.id, cols: 80, rows: 24 });
    c.input(t2.id, "pwd\r");
    const esc = card.worktreePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await c.waitForOutput(t1.id, new RegExp(esc));
    await c.waitForOutput(t2.id, new RegExp(esc));
    const { terminals } = await c.req<{ terminals: TermT[] }>("terminals.list", { cardId: card.id });
    expect(terminals.map((t) => t.id).sort()).toEqual([t1.id, t2.id].sort());
    await c.close();
  });

  it("terminal shells get the configured ZDOTDIR, never the engine's own", async () => {
    const c = await Client.connect();
    const { terminal } = await c.req<{ terminal: TermT }>("terminal.open", {
      cardId: card.id,
      cols: 200,
      rows: 24,
      command: `printf 'Z=<%s>\\n' "$ZDOTDIR"`,
    });
    await c.waitForOutput(terminal.id, new RegExp(`Z=<${escapeRe(engine!.zdotdir)}>`));
    expect(c.output(terminal.id)).not.toContain("leaked-zdotdir>");
    await c.req("terminal.close", { terminalId: terminal.id });
    await c.close();
  });

  let ticker: TermT;

  it("keeps a command running while no client is connected and replays what it printed (Bitti 4)", async () => {
    const a = await Client.connect();
    ({ terminal: ticker } = await a.req<{ terminal: TermT }>("terminal.open", {
      cardId: card.id,
      cols: 80,
      rows: 24,
      command: "i=0; while true; do echo tick$i; i=$((i+1)); sleep 0.1; done",
    }));
    await a.waitForOutput(ticker.id, /tick2\b/);
    await a.close();

    await new Promise((r) => setTimeout(r, 1500)); // "app closed"

    const b = await Client.connect();
    await b.req("terminal.attach", { terminalId: ticker.id, cols: 80, rows: 24 });
    const replay = (await b.waitFor((f) => f.type === "output" && f.terminalId === ticker.id && f.replay === true)) as Extract<
      ServerMessage,
      { type: "output" }
    >;
    const ticks = [...replay.data.matchAll(/tick(\d+)/g)].map((m) => Number(m[1]));
    expect(Math.max(...ticks)).toBeGreaterThanOrEqual(10); // output produced while disconnected is there
    const before = Math.max(...ticks);
    const live = await b.waitForOutput(ticker.id, new RegExp(`tick${before + 3}\\b`)); // and it is still running
    expect(live).toContain(`tick${before + 3}`);
    await b.close();
  });

  it("never mixes output between two cards (Bitti 5)", async () => {
    const c = await Client.connect();
    ({ card: card2 } = await c.req<{ card: CardT }>("cards.create", { projectId: "e2e", name: "İkinci Kart" }));
    const { terminal: ta } = await c.req<{ terminal: TermT }>("terminal.open", { cardId: card.id, cols: 80, rows: 24 });
    const { terminal: tb } = await c.req<{ terminal: TermT }>("terminal.open", { cardId: card2.id, cols: 80, rows: 24 });
    c.input(ta.id, "echo MARK_A_$((1+1))\r");
    c.input(tb.id, "echo MARK_B_$((2+2))\r");
    await c.waitForOutput(ta.id, /MARK_A_2/);
    await c.waitForOutput(tb.id, /MARK_B_4/);
    expect(c.output(ta.id)).not.toContain("MARK_B_4");
    expect(c.output(tb.id)).not.toContain("MARK_A_2");
    const { terminals: list2 } = await c.req<{ terminals: TermT[] }>("terminals.list", { cardId: card2.id });
    expect(list2.map((t) => t.id)).toEqual([tb.id]);
    await c.close();
  });

  it("refuses to delete a card with uncommitted changes, deletes a clean one (Bitti 6)", async () => {
    const c = await Client.connect();
    writeFileSync(join(card2.worktreePath, "yeni.txt"), "x\n");
    await expect(c.req("cards.delete", { cardId: card2.id })).rejects.toMatchObject({ code: "DIRTY_WORKTREE" });
    expect(existsSync(card2.worktreePath)).toBe(true);
    rmSync(join(card2.worktreePath, "yeni.txt"));
    await c.req("cards.delete", { cardId: card2.id });
    expect(existsSync(card2.worktreePath)).toBe(false);
    expect(git(repo, "branch", "--list", card2.branch)).toContain(card2.branch); // branch kept
    await c.close();
  });

  it("keeps project and card records across an engine restart (Bitti 7, process level)", async () => {
    await stopEngine();
    port = await startEngine();
    const c = await Client.connect();
    const { cards } = await c.req<{ cards: CardT[] }>("cards.list", { projectId: "e2e" });
    expect(cards.map((x) => x.id)).toEqual([card.id]);
    const { terminals } = await c.req<{ terminals: TermT[] }>("terminals.list", { cardId: card.id });
    const t = terminals.find((x) => x.id === ticker.id)!;
    expect(t.status).toBe("exited"); // processes do not survive a restart (spec allows this)
    await c.req("terminal.attach", { terminalId: ticker.id, cols: 80, rows: 24 });
    const replay = (await c.waitFor((f) => f.type === "output" && f.terminalId === ticker.id && f.replay === true)) as Extract<
      ServerMessage,
      { type: "output" }
    >;
    expect(replay.data).toMatch(/tick\d+/); // old output still readable
    await c.close();
  }, 30000);
});
