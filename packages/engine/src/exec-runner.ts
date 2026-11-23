// Runs a program (execFile, never a shell) with a time limit and an output cap, and reports how it ended instead of
// throwing: used for the CLIs the engine reads (claude agents, usage probes, and optional modules' tools).
import { execFile } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
  /** Exit code; null when the process did not exit normally. */
  code: number | null;
  /** Set when the process could not run or was stopped by us. */
  error?: "ENOENT" | "TIMEOUT" | "TOO_BIG" | "SPAWN";
}

export type ProcessRunner = (
  file: string,
  args: string[],
  /** `env` (İş H): the child's whole environment; absent = the engine's own. */
  /** `cwd` (Claude kullanımı): the child's working folder; absent = the engine's own. */
  opts: { timeoutMs: number; maxOutputBytes: number; env?: NodeJS.ProcessEnv; cwd?: string },
) => Promise<RunResult>;

const KILL_SIGNAL = "SIGKILL";

export const execCapped: ProcessRunner = (file, args, { timeoutMs, maxOutputBytes, env, cwd }) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: maxOutputBytes, killSignal: KILL_SIGNAL, encoding: "utf8", windowsHide: true, ...(env ? { env } : {}), ...(cwd !== undefined ? { cwd } : {}) },
      (err, stdout, stderr) => {
        const out = { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
        if (!err) return resolve({ ...out, code: 0 });
        const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: unknown; signal?: string | null };
        if (e.code === "ENOENT") return resolve({ ...out, code: null, error: "ENOENT" });
        if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return resolve({ ...out, code: null, error: "TOO_BIG" });
        if (e.killed || e.signal === KILL_SIGNAL) return resolve({ ...out, code: null, error: "TIMEOUT" });
        if (typeof e.code === "number") return resolve({ ...out, code: e.code });
        resolve({ ...out, code: null, error: "SPAWN" });
      },
    );
  });
