// Installs the fake `claude` (fake-claude-agents.mjs) into a temp bin dir with scripted background sessions.
// Shared by the engine and Electron end-to-end tests. Session entries follow the sanitized real shape in
// test/fixtures/claude-agents/agents-all.json.
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./fake-claude-agents.mjs", import.meta.url));

export interface FakeClaudeSession {
  id: string;
  cwd: string;
  name: string;
  state: string;
  kind?: string;
  status?: string;
  pid?: number;
  startedAt?: number;
  sessionId?: string;
}

export type FakeRateLimits = Partial<Record<"five_hour" | "seven_day", { utilization: number; resetsAt: number }>>;

export interface FakeClaude {
  /** Directory holding the `claude` executable (prepend it to PATH). */
  binDir: string;
  /** Env the fake needs (FAKE_CLAUDE_STATE, FAKE_CLAUDE_LOG). */
  env: Record<string, string>;
  setSessions(sessions: FakeClaudeSession[]): void;
  /** İş H: sessions seen when CLAUDE_CONFIG_DIR is `dir` (the default list is kept). */
  setSessionsFor(dir: string, sessions: FakeClaudeSession[]): void;
  sessions(): FakeClaudeSession[];
  /**
   * Claude kullanımı: what `claude -p` reports as rate limits for the account dir (`undefined` = the default
   * account). `utilization` is a 0–1 fraction, `resetsAt` epoch seconds.
   */
  setRateLimits(dir: string | undefined, windows: FakeRateLimits): void;
  /** Every argv the fake was called with, in order. */
  calls(): string[][];
}

export function installFakeClaude(root: string, sessions: FakeClaudeSession[]): FakeClaude {
  const binDir = join(root, "fake-claude-bin");
  mkdirSync(binDir, { recursive: true });
  const binary = join(binDir, "claude");
  copyFileSync(SCRIPT, binary);
  chmodSync(binary, 0o755);
  const statePath = join(root, "fake-claude-state.json");
  const logPath = join(root, "fake-claude-calls.jsonl");
  type State = { sessions: FakeClaudeSession[]; byConfigDir?: Record<string, FakeClaudeSession[]>; rateLimits?: Record<string, FakeRateLimits> };
  const read = (): State => JSON.parse(readFileSync(statePath, "utf8")) as State;
  const save = (s: State) => writeFileSync(statePath, JSON.stringify(s));
  const write = (s: FakeClaudeSession[]) => save({ ...read(), sessions: s });
  save({ sessions });
  writeFileSync(logPath, "");
  return {
    binDir,
    env: { FAKE_CLAUDE_STATE: statePath, FAKE_CLAUDE_LOG: logPath },
    setSessions: write,
    setSessionsFor: (dir, s) => {
      const st = read();
      save({ ...st, byConfigDir: { ...st.byConfigDir, [dir]: s } });
    },
    setRateLimits: (dir, windows) => {
      const st = read();
      save({ ...st, rateLimits: { ...st.rateLimits, [dir ?? ""]: windows } });
    },
    sessions: () => (JSON.parse(readFileSync(statePath, "utf8")) as { sessions: FakeClaudeSession[] }).sessions,
    calls: () =>
      readFileSync(logPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[]),
  };
}
