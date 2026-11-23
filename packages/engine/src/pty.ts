// PtyManager: one node-pty process per terminal, history in a RingBuffer that is
// persisted to disk, so output survives client disconnects and engine restarts.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import * as nodePty from "node-pty";
import type { TerminalInfo } from "@kokpit/shared";
import { BufferPersister, RingBuffer } from "./buffer.ts";
import { CLAUDE_CONFIG_ENV } from "./claude-accounts.ts";
import {
  EngineError,
  type DataPaths,
  type EngineConfig,
  type LaunchSpec,
  type Logger,
  type PtyManager,
  type StateStore,
  type TerminalListener,
} from "./contracts.ts";

const TERM_NAME = "xterm-256color";
const COLORTERM = "truecolor";
const HANGUP = "SIGHUP";
const FORCE_KILL = "SIGKILL";
/** Env vars that identify the terminal to the process inside it. */
const ENV_PROJECT = "KOKPIT_PROJECT_ID";
const ENV_CARD = "KOKPIT_CARD_ID";
const ENV_TERMINAL = "KOKPIT_TERMINAL_ID";
const TRAILING_CR = /\r+$/;

type OpenTarget = { projectId: string; cardId?: string; toolId?: string };

/**
 * Never inherited from the engine: zsh reads its rc files from $ZDOTDIR, so an engine started from a dev shell
 * or a test would hand that directory (and its .zshrc) to every terminal instead of the user's $HOME ones.
 */
const ENV_ZDOTDIR = "ZDOTDIR";
const ENV_CLAUDE_CONFIG = CLAUDE_CONFIG_ENV;

/** Every variable Kokpit itself sets starts with this. */
const KOKPIT_PREFIX = "KOKPIT_";
/** The `open` shim folder a Kokpit terminal puts first on its PATH (terminal-open.ts). */
const ENV_SHIM_DIR = "KOKPIT_SHIM_DIR";

/**
 * What a terminal inherits from the engine's own environment. The engine may itself run inside a Kokpit terminal
 * (a developer, a test runner): that terminal's KOKPIT_* variables — its `open` credential, shim folder, terminal
 * and project ids, CDP address, the engine's access key from the launch — and its shim folder on PATH are THAT
 * terminal's, never another one's. A terminal gets only what the engine decides for it (`terminalEnv`).
 */
export function inheritedEnv(from: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(from)) if (v !== undefined && !k.startsWith(KOKPIT_PREFIX)) env[k] = v;
  const shim = from[ENV_SHIM_DIR];
  if (shim && env.PATH !== undefined) env.PATH = env.PATH.split(":").filter((dir) => dir !== shim).join(":");
  return env;
}

function terminalEnv(
  target: OpenTarget,
  terminalId: string,
  extra: Record<string, string> = {},
  zdotdir?: string,
): Record<string, string> {
  const env = inheritedEnv(process.env);
  delete env[ENV_ZDOTDIR];
  // İş H: the Claude account comes only from the launch (claude-accounts.ts); an engine started from a terminal of
  // another account must not hand its own to every terminal.
  delete env[ENV_CLAUDE_CONFIG];
  if (zdotdir !== undefined) env[ENV_ZDOTDIR] = zdotdir;
  Object.assign(env, extra);
  // The card id comes only from the target (never from a launch's env).
  delete env[ENV_CARD];
  Object.assign(env, { TERM: TERM_NAME, COLORTERM, [ENV_PROJECT]: target.projectId, [ENV_TERMINAL]: terminalId });
  if (target.cardId !== undefined) env[ENV_CARD] = target.cardId;
  return env;
}

export interface PtyManagerDeps {
  config: EngineConfig;
  paths: DataPaths;
  store: StateStore;
  logger: Logger;
  /** Max delay before buffered output is written to disk. */
  flushIntervalMs: number;
  /** How long close()/shutdown() wait after SIGHUP before SIGKILL. */
  killGraceMs: number;
  /** ZDOTDIR for terminal shells (config `terminalZdotdir`); the engine's own is never passed on. */
  zdotdir?: string;
  spawn?: typeof nodePty.spawn;
  newId?: () => string;
  now?: () => Date;
}

interface Session {
  readonly id: string;
  readonly buffer: RingBuffer;
  readonly listeners: Set<TerminalListener>;
  readonly proc: nodePty.IPty | null;
  /** Resolves when the process has exited (immediately for restored sessions). */
  readonly exitedPromise: Promise<void>;
  exited: boolean;
  closed: boolean;
  /** İş K: the launch's cleanup (LaunchSpec.onExit), safe to call more than once. Absent for restored sessions. */
  readonly release?: () => void;
}

export function createPtyManager(deps: PtyManagerDeps): PtyManager {
  const { config, store, logger, killGraceMs } = deps;
  const spawn = deps.spawn ?? nodePty.spawn;
  const newId = deps.newId ?? randomUUID;
  const now = deps.now ?? (() => new Date());
  const persister = new BufferPersister({
    buffersDir: deps.paths.buffersDir,
    intervalMs: deps.flushIntervalMs,
    onError: (err, terminalId) => logger.error("terminal buffer write failed", { terminalId, error: String(err) }),
  });
  const sessions = new Map<string, Session>();

  // Anything still "running" belongs to a previous engine process, which took its children with it.
  for (const t of store.listTerminals()) {
    if (t.status === "running") store.upsertTerminal({ ...t, status: "exited", exitCode: null });
  }

  function requireInfo(terminalId: string): TerminalInfo {
    const info = store.getTerminal(terminalId);
    if (!info) throw new EngineError("NOT_FOUND", "terminal not found");
    return info;
  }

  /** Live session, or a dead one rebuilt from the persisted buffer. */
  function session(terminalId: string): Session {
    requireInfo(terminalId);
    let s = sessions.get(terminalId);
    if (!s) {
      const buffer = new RingBuffer(config.bufferBytes);
      try {
        buffer.append(persister.load(terminalId) ?? "");
      } catch (err) {
        logger.warn("terminal buffer unreadable", { terminalId, error: String(err) });
      }
      s = {
        id: terminalId,
        buffer,
        listeners: new Set(),
        proc: null,
        exitedPromise: Promise.resolve(),
        exited: true,
        closed: false,
      };
      sessions.set(terminalId, s);
    }
    return s;
  }

  function signal(s: Session, sig: string): void {
    if (!s.proc || s.exited) return;
    try {
      s.proc.kill(sig);
    } catch (err) {
      logger.warn("terminal kill failed", { terminalId: s.id, signal: sig, error: String(err) });
    }
  }

  function writeBuffer(s: Session): void {
    try {
      persister.write(s.id, s.buffer.toString());
    } catch (err) {
      logger.error("terminal buffer write failed", { terminalId: s.id, error: String(err) });
    }
  }

  function notify(s: Session, call: (l: TerminalListener) => void): void {
    for (const l of [...s.listeners]) {
      try {
        call(l);
      } catch (err) {
        logger.warn("terminal listener threw", { terminalId: s.id, error: String(err) });
      }
    }
  }

  function waitExited(list: Session[], ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      void Promise.all(list.map((s) => s.exitedPromise)).then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  const manager: PtyManager = {
    open(target: OpenTarget, launch: LaunchSpec, opts: { cols: number; rows: number }): TerminalInfo {
      // İş K: whatever the launch prepared for this terminal is released exactly once, however it ends.
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        try {
          launch.onExit?.();
        } catch (err) {
          logger.warn("terminal launch cleanup failed", { projectId: target.projectId, error: String(err) });
        }
      };
      if (!existsSync(launch.cwd)) {
        release();
        throw new EngineError("NOT_FOUND", "terminal directory is missing");
      }
      const id = newId();
      let proc: nodePty.IPty;
      try {
        proc = spawn(launch.file, launch.args, {
          name: TERM_NAME,
          cols: opts.cols,
          rows: opts.rows,
          cwd: launch.cwd,
          env: terminalEnv(target, id, launch.env, deps.zdotdir),
        });
      } catch (err) {
        logger.error("terminal spawn failed", { projectId: target.projectId, cardId: target.cardId, error: String(err) });
        release();
        throw new EngineError("INTERNAL", "could not start the terminal");
      }

      let markExited!: () => void;
      const exitedPromise = new Promise<void>((r) => (markExited = r));
      const s: Session = {
        id,
        buffer: new RingBuffer(config.bufferBytes),
        listeners: new Set(),
        proc,
        exitedPromise,
        exited: false,
        closed: false,
        release,
      };
      const command = launch.initialInput?.replace(TRAILING_CR, "");
      const info: TerminalInfo = {
        id,
        projectId: target.projectId,
        ...(target.cardId !== undefined ? { cardId: target.cardId } : {}),
        ...(target.toolId !== undefined ? { toolId: target.toolId } : {}),
        title: launch.title,
        ...(command ? { command } : {}),
        status: "running",
        createdAt: now().toISOString(),
      };
      store.upsertTerminal(info);
      sessions.set(id, s);

      proc.onData((data) => {
        if (s.closed) return;
        s.buffer.append(data);
        persister.schedule(id, () => s.buffer.toString());
        notify(s, (l) => l.onData(data));
      });
      proc.onExit(({ exitCode }) => {
        s.exited = true;
        markExited();
        release();
        if (s.closed) return;
        const current = store.getTerminal(id);
        if (current) store.upsertTerminal({ ...current, status: "exited", exitCode });
        writeBuffer(s);
        notify(s, (l) => l.onExit(exitCode));
        s.listeners.clear();
      });

      if (launch.initialInput) proc.write(launch.initialInput);
      logger.info("terminal opened", { terminalId: id, projectId: target.projectId, cardId: target.cardId });
      return { ...info };
    },

    list(filter: { cardId?: string; projectId?: string }): TerminalInfo[] {
      return store.listTerminals(filter);
    },

    get(terminalId: string): TerminalInfo | undefined {
      return store.getTerminal(terminalId);
    },

    pid(terminalId: string): number | undefined {
      const s = sessions.get(terminalId);
      return s && s.proc && !s.exited && !s.closed ? s.proc.pid : undefined;
    },

    history(terminalId: string): string {
      return session(terminalId).buffer.toString();
    },

    write(terminalId: string, data: string): void {
      const s = session(terminalId);
      if (s.exited || !s.proc) throw new EngineError("TERMINAL_EXITED", "terminal has exited");
      s.proc.write(data);
    },

    resize(terminalId: string, cols: number, rows: number): void {
      const s = session(terminalId);
      if (s.exited || !s.proc) return;
      try {
        s.proc.resize(cols, rows);
      } catch (err) {
        logger.warn("terminal resize failed", { terminalId, error: String(err) });
      }
    },

    close(terminalId: string): void {
      const s = session(terminalId);
      s.closed = true;
      s.listeners.clear();
      s.release?.();
      if (s.proc && !s.exited) {
        signal(s, HANGUP);
        const timer = setTimeout(() => signal(s, FORCE_KILL), killGraceMs);
        timer.unref();
        void s.exitedPromise.then(() => clearTimeout(timer));
      }
      sessions.delete(terminalId);
      store.removeTerminal(terminalId);
      try {
        persister.remove(terminalId);
      } catch (err) {
        logger.warn("terminal buffer remove failed", { terminalId, error: String(err) });
      }
      logger.info("terminal closed", { terminalId });
    },

    closeAllForCard(cardId: string): void {
      for (const t of store.listTerminals({ cardId })) manager.close(t.id);
    },

    closeAllForProject(projectId: string): void {
      for (const t of store.listTerminals({ projectId })) manager.close(t.id);
    },

    subscribe(terminalId: string, listener: TerminalListener): () => void {
      const s = session(terminalId);
      if (s.exited || s.closed) return () => {};
      s.listeners.add(listener);
      return () => {
        s.listeners.delete(listener);
      };
    },

    async shutdown(): Promise<void> {
      for (const s of sessions.values()) if (!s.closed && s.proc) writeBuffer(s);
      persister.dispose();
      const running = [...sessions.values()].filter((s) => s.proc && !s.exited);
      for (const s of running) signal(s, HANGUP);
      await waitExited(running, killGraceMs);
      const stubborn = running.filter((s) => !s.exited);
      for (const s of stubborn) signal(s, FORCE_KILL);
      await waitExited(stubborn, killGraceMs);
    },
  };
  return manager;
}
