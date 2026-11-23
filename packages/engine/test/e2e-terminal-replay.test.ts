// End-to-end: a terminal whose history buffer is full must come back whole after a re-attach.
// Runs the real engine with its DEFAULT `bufferBytes` against a temp data dir; the terminal runs a deterministic
// program (fixtures/flood.ts — never a real tool) in /bin/sh.
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_MESSAGE_BYTES, type ServerMessage } from "@kokpit/shared";
import { FLOOD_DONE, floodText, tickLine } from "./fixtures/flood.ts";
import { Client, startEngine, stopEngine, type EngineProc } from "./harness.ts";

const KEY = randomBytes(32).toString("base64url");
const FLOOD = fileURLToPath(new URL("./fixtures/flood.ts", import.meta.url));
const { bufferBytes: BUFFER_BYTES } = JSON.parse(readFileSync(new URL("../config.defaults.json", import.meta.url), "utf8")) as { bufferBytes: number };
/** The program prints this many buffers' worth, so the buffer is full and has wrapped. */
const FLOOD_BUFFERS = 3;
const TICK_MS = 25;
const TICKS_AFTER_ATTACH = 8;
const FLOOD_WAIT_MS = 60_000;
const LIVE_WAIT_MS = 20_000;
const POLL_MS = 50;
/** Frames looked at for the end-of-flood marker (it may straddle two frames). */
const TAIL_FRAMES = 50;
/** Ticks the expected stream is built with — far more than the test can live through. */
const EXPECTED_TICKS = 100_000;
/** The replay must hold at least this share of the buffer: the whole history, not a tail of it. */
const MIN_REPLAY_FILL = 0.9;
/** Characters of the received stream used to find where it starts in the expected one. */
const ANCHOR_CHARS = 200;

type OutputFrame = Extract<ServerMessage, { type: "output" }>;
type TermT = { id: string };

let root: string;
let engine: EngineProc | undefined;

const utf8 = (s: string): number => Buffer.byteLength(s, "utf8");
/** What the terminal shows for program output: the pty turns every `\n` into `\r\n`. */
const viaPty = (s: string): string => s.replace(/\n/g, "\r\n");
/**
 * Under back-pressure the macOS tty sometimes writes a line end as `\r\r\n`. That is in the stream the engine reads
 * (and so in its history); only the comparison with what the program wrote has to look past it.
 */
const sameLineEnds = (s: string): string => s.replace(/\r+\n/g, "\r\n");
const outputs = (c: Client, terminalId: string): OutputFrame[] => c.frames.filter((f): f is OutputFrame => f.type === "output" && f.terminalId === terminalId);

async function waitUntil(what: string, pred: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-e2e-replay-")));
  mkdirSync(join(root, "home"));
  mkdirSync(join(root, "work"));
  const configPath = join(root, "engine.json");
  writeFileSync(
    configPath,
    JSON.stringify({ dataDir: join(root, "data"), port: 0, shell: "/bin/sh", shellArgs: [], listenTailscale: false, flushIntervalMs: 100, killGraceMs: 200 }),
  );
  engine = await startEngine({ KOKPIT_CONFIG: configPath, KOKPIT_KEY: KEY, HOME: join(root, "home") });
  const c = await Client.connect(engine.port, KEY);
  await c.req("settings.update", { defaultToolId: null });
  await c.req("projects.create", { name: "Gecmis", location: { kind: "local", path: join(root, "work") } });
  await c.close();
}, 30_000);

afterAll(async () => {
  await stopEngine(engine);
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("terminal history replay with a full buffer", () => {
  it("re-attach replays the whole buffer in order, inside the frame limit, and live output continues without a gap", async () => {
    const a = await Client.connect(engine!.port, KEY);
    const { projects } = await a.req<{ projects: { id: string; name: string }[] }>("projects.list", {});
    const projectId = projects.find((p) => p.name === "Gecmis")!.id;
    const { terminal } = await a.req<{ terminal: TermT }>("terminal.open", {
      projectId,
      cols: 80,
      rows: 24,
      toolId: null,
      command: `exec '${process.execPath}' '${FLOOD}' ${FLOOD_BUFFERS * BUFFER_BYTES} ${TICK_MS}`,
    });
    const floodEnd = `${FLOOD_DONE}\r\n${viaPty(tickLine(0))}`;
    await waitUntil(
      "the flood to finish",
      () =>
        outputs(a, terminal.id)
          .slice(-TAIL_FRAMES)
          .map((f) => f.data)
          .join("")
          .includes(floodEnd),
      FLOOD_WAIT_MS,
    );
    const seenLive = a.output(terminal.id);
    await a.close();

    const b = await Client.connect(engine!.port, KEY);
    await b.req("terminal.attach", { terminalId: terminal.id, cols: 80, rows: 24 });
    await waitUntil("live output after the replay", () => outputs(b, terminal.id).filter((f) => f.replay !== true).length >= TICKS_AFTER_ATTACH, LIVE_WAIT_MS);
    await b.req("terminal.close", { terminalId: terminal.id });
    await b.close();

    // 1. No frame over the protocol limit (the receiver drops those).
    const sizes = b.raw.map((r) => r.length);
    console.log(`[replay] frames=${sizes.length} largest=${Math.max(...sizes)} limit=${MAX_MESSAGE_BYTES} bufferBytes=${BUFFER_BYTES}`);
    expect(sizes.filter((n) => n > MAX_MESSAGE_BYTES)).toEqual([]);
    expect(b.frames.length).toBe(b.raw.length);

    // 2. Replay first, then live; nothing marked replay after the first live frame.
    const out = outputs(b, terminal.id);
    const firstLive = out.findIndex((f) => f.replay !== true);
    expect(firstLive).toBeGreaterThan(0);
    expect(out.slice(firstLive).some((f) => f.replay === true)).toBe(false);
    const replay = out
      .slice(0, firstLive)
      .map((f) => f.data)
      .join("");
    console.log(`[replay] chunks=${firstLive} replayChars=${replay.length} replayUtf8=${utf8(replay)} replayJson=${JSON.stringify(replay).length}`);

    // 3. The buffer came back (nearly) full — not a truncated tail.
    expect(utf8(replay)).toBeLessThanOrEqual(BUFFER_BYTES);
    expect(utf8(replay)).toBeGreaterThan(BUFFER_BYTES * MIN_REPLAY_FILL);

    // 4. The replay is, character for character, the end of what the first client saw live.
    const cut = (text: string): string => text.slice(0, text.indexOf(FLOOD_DONE));
    expect(replay).toContain(FLOOD_DONE);
    expect(cut(seenLive).endsWith(cut(replay))).toBe(true);

    // 5. Replay + live is one contiguous piece of what the program wrote: nothing lost, doubled or reordered.
    const ticks = Array.from({ length: EXPECTED_TICKS }, (_, n) => tickLine(n)).join("");
    const expected = viaPty(floodText(FLOOD_BUFFERS * BUFFER_BYTES) + ticks);
    const got = sameLineEnds(out.map((f) => f.data).join(""));
    const at = expected.indexOf(got.slice(0, ANCHOR_CHARS));
    expect(at).toBeGreaterThan(0);
    expect(got === expected.slice(at, at + got.length)).toBe(true);
  }, 120_000);
});
