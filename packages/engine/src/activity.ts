// İş A — ajan özeti. Per-terminal activity: running (output within the window), waiting (a waiting
// pattern on the last screen lines, or a bell / OSC notification after the last user input), idle, exited.
// Fed by PtyManager output, input and exit (see `withActivity`), it keeps only bounded text tails.
import type { AgentState, TerminalActivity, TerminalInfo } from "@kokpit/shared";
import type { Logger, PtyManager, TerminalListener } from "./contracts.ts";

export interface ActivityOptions {
  /** Output within this long = running. */
  windowMs: number;
  /** Change events per terminal are sent at most once per this interval (trailing). */
  debounceMs: number;
  /** How many of the last non-empty screen lines are matched against the waiting patterns. */
  scanLines: number;
  /** Max length of `summary`. */
  summaryMaxLen: number;
  /** Max characters of stripped text (and of an unfinished escape sequence) kept per terminal. */
  tailChars: number;
  /** Waiting patterns for a terminal's tool (generic list when the terminal has no tool). Read on every check. */
  patternsFor(toolId: string | undefined): readonly string[];
  logger: Logger;
  now?: () => number;
}

export interface ActivityChange {
  terminalId: string;
  projectId: string;
  cardId?: string;
  activity: TerminalActivity;
}

export interface ActivityTracker {
  /** Starts tracking a live terminal (idle until it prints). */
  track(info: TerminalInfo): void;
  output(terminalId: string, data: string): void;
  input(terminalId: string, data: string): void;
  exit(terminalId: string): void;
  forget(terminalId: string): void;
  get(terminalId: string): TerminalActivity | undefined;
  onChange(cb: (change: ActivityChange) => void): () => void;
  /** Sizes of the kept buffers (tests). */
  debugSizes(terminalId: string): { pending: number; screen: number; recent: number } | undefined;
  dispose(): void;
}

// ---------- escape-sequence scanning ----------

const ESC = "\x1b";
const BEL = "\x07";
/** Introducers of string sequences terminated by BEL or ST (ESC \): OSC, DCS, SOS, PM, APC. */
const STRING_SEQ = new Set(["]", "P", "X", "^", "_"]);
/** ESC + one of these takes one more byte (charset designation etc.). */
const TWO_BYTE_SEQ = new Set(["(", ")", "*", "+", "-", ".", "/", "#", "%", " "]);
/** CSI finals that move the cursor to another line: the stripped text gets a line break. */
const CSI_LINE_BREAK = new Set(["A", "B", "E", "F", "H", "f", "d"]);
/** CSI cursor-forward: a gap between words. */
const CSI_SPACE = "C";
/** Notification OSCs: 9 (iTerm2/ConEmu), 777 (rxvt/Ghostty), 99 (kitty). `9;4;…` is ConEmu progress, not one. */
/** Escape sequences in input: CSI (arrows, replies), OSC/DCS-style strings, SS3 (app-mode arrows), ESC + key. */
// eslint-disable-next-line no-control-regex
const INPUT_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|[\]PX^_][^\x07\x1b]*(?:\x07|\x1b\\)|O.|[\s\S])/g;
const NOTIFY_OSC = /^(?:9;(?!4;)|9$|777;|99;)/;

export interface ScanResult {
  /** Printable text; CR and line-changing cursor moves become "\n". */
  text: string;
  /** A bare BEL or a notification OSC was seen. */
  notify: boolean;
  /** Unfinished escape sequence at the end, to prepend to the next chunk. */
  rest: string;
}

/** Strips escape sequences from terminal output. */
export function scanOutput(data: string): ScanResult {
  let text = "";
  let notify = false;
  let i = 0;
  const n = data.length;
  while (i < n) {
    const c = data[i]!;
    if (c === BEL) {
      notify = true;
      i++;
      continue;
    }
    if (c !== ESC) {
      if (c === "\r" || c === "\n") text += "\n";
      else if (c === "\t") text += " ";
      else if (c >= " " && c !== "\x7f" && !(c >= "\x80" && c <= "\x9f")) text += c;
      i++;
      continue;
    }
    if (i + 1 >= n) return { text, notify, rest: data.slice(i) };
    const kind = data[i + 1]!;
    if (kind === "[") {
      let j = i + 2;
      while (j < n && !(data.charCodeAt(j) >= 0x40 && data.charCodeAt(j) <= 0x7e)) j++;
      if (j >= n) return { text, notify, rest: data.slice(i) };
      const final = data[j]!;
      if (CSI_LINE_BREAK.has(final)) text += "\n";
      else if (final === CSI_SPACE) text += " ";
      i = j + 1;
      continue;
    }
    if (STRING_SEQ.has(kind)) {
      let j = i + 2;
      let end = -1;
      let after = -1;
      while (j < n) {
        if (data[j] === BEL) {
          end = j;
          after = j + 1;
          break;
        }
        if (data[j] === ESC) {
          if (j + 1 >= n) break;
          if (data[j + 1] === "\\") {
            end = j;
            after = j + 2;
            break;
          }
        }
        j++;
      }
      if (end < 0) return { text, notify, rest: data.slice(i) };
      if (kind === "]" && NOTIFY_OSC.test(data.slice(i + 2, end))) notify = true;
      i = after;
      continue;
    }
    if (TWO_BYTE_SEQ.has(kind)) {
      if (i + 2 >= n) return { text, notify, rest: data.slice(i) };
      i += 3;
      continue;
    }
    i += 2;
  }
  return { text, notify, rest: "" };
}

/**
 * Whether input came from the user (keys) rather than the terminal answering a query (focus reports,
 * device attributes, cursor position, colour replies). A bare Esc counts: it cancels prompts.
 */
export function isUserInput(data: string): boolean {
  if (data === ESC) return true;
  return data.replace(INPUT_SEQUENCE, "").length > 0;
}

// ---------- tracker ----------

const HAS_WORD = /[\p{L}\p{N}]/u;
const SPACES = /\s+/g;
const ELLIPSIS = "…";

interface Entry {
  info: { terminalId: string; projectId: string; cardId?: string; toolId?: string };
  pending: string;
  /** Stripped text since the last user input (scanned for waiting patterns). */
  screen: string;
  /** Stripped recent text (summary). */
  recent: string;
  lastOutputAt: number | undefined;
  notified: boolean;
  exited: boolean;
  state: AgentState;
  since: number;
  summary: string | undefined;
  idleTimer: NodeJS.Timeout | undefined;
  emitTimer: NodeJS.Timeout | undefined;
  lastEmitted: string | undefined;
}

function keepTail(s: string, max: number): string {
  return s.length > max ? s.slice(s.length - max) : s;
}

/** Last `count` non-empty lines of `text`, newest last. */
function lastLines(text: string, count: number): string[] {
  const out: string[] = [];
  let end = text.length;
  while (end > 0 && out.length < count) {
    const start = text.lastIndexOf("\n", end - 1);
    const line = text.slice(start + 1, end);
    if (line.trim() !== "") out.push(line);
    if (start < 0) break;
    end = start;
  }
  return out.reverse();
}

function summarize(text: string, max: number): string | undefined {
  let end = text.length;
  while (end > 0) {
    const start = text.lastIndexOf("\n", end - 1);
    const line = text.slice(start + 1, end).replace(SPACES, " ").trim();
    if (HAS_WORD.test(line)) return line.length > max ? line.slice(0, Math.max(0, max - ELLIPSIS.length)) + ELLIPSIS : line;
    if (start < 0) break;
    end = start;
  }
  return undefined;
}

export function createActivityTracker(opts: ActivityOptions): ActivityTracker {
  const now = opts.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const listeners = new Set<(c: ActivityChange) => void>();
  /** Compiled patterns by source; null = invalid (warned once). */
  const compiled = new Map<string, RegExp | null>();

  function regex(source: string): RegExp | null {
    let re = compiled.get(source);
    if (re === undefined) {
      try {
        re = new RegExp(source);
      } catch (err) {
        re = null;
        opts.logger.warn("invalid waiting pattern skipped", { pattern: source, error: String(err) });
      }
      compiled.set(source, re);
    }
    return re;
  }

  function patternOnScreen(e: Entry): boolean {
    const patterns = opts.patternsFor(e.info.toolId).map(regex).filter((r): r is RegExp => r !== null);
    if (patterns.length === 0) return false;
    return lastLines(e.screen, opts.scanLines).some((line) => patterns.some((re) => re.test(line)));
  }

  function computeState(e: Entry): AgentState {
    if (e.exited) return "exited";
    if (e.notified || patternOnScreen(e)) return "waiting";
    if (e.lastOutputAt !== undefined && now() - e.lastOutputAt < opts.windowMs) return "running";
    return "idle";
  }

  function snapshot(e: Entry): TerminalActivity {
    return {
      state: e.state,
      since: new Date(e.since).toISOString(),
      ...(e.summary !== undefined ? { summary: e.summary } : {}),
    };
  }

  function emit(e: Entry): void {
    e.emitTimer = undefined;
    const activity = snapshot(e);
    const key = JSON.stringify(activity);
    if (key === e.lastEmitted) return;
    e.lastEmitted = key;
    const change: ActivityChange = {
      terminalId: e.info.terminalId,
      projectId: e.info.projectId,
      ...(e.info.cardId !== undefined ? { cardId: e.info.cardId } : {}),
      activity,
    };
    for (const l of [...listeners]) {
      try {
        l(change);
      } catch (err) {
        opts.logger.warn("activity listener threw", { terminalId: e.info.terminalId, error: String(err) });
      }
    }
  }

  function scheduleEmit(e: Entry): void {
    if (e.emitTimer !== undefined) return;
    e.emitTimer = setTimeout(() => emit(e), opts.debounceMs);
    e.emitTimer.unref?.();
  }

  function scheduleIdleCheck(e: Entry): void {
    if (e.idleTimer !== undefined || e.lastOutputAt === undefined || e.exited) return;
    const wait = Math.max(0, e.lastOutputAt + opts.windowMs - now());
    e.idleTimer = setTimeout(() => {
      e.idleTimer = undefined;
      if (e.lastOutputAt !== undefined && now() - e.lastOutputAt < opts.windowMs) scheduleIdleCheck(e);
      else update(e);
    }, wait);
    e.idleTimer.unref?.();
  }

  function update(e: Entry): void {
    const next = computeState(e);
    if (next !== e.state) {
      e.state = next;
      e.since = now();
    }
    const summary = summarize(e.recent, opts.summaryMaxLen);
    if (summary !== undefined) e.summary = summary;
    if (JSON.stringify(snapshot(e)) !== e.lastEmitted) scheduleEmit(e);
  }

  function live(terminalId: string): Entry | undefined {
    const e = entries.get(terminalId);
    return e && !e.exited ? e : undefined;
  }

  function clearTimers(e: Entry): void {
    if (e.idleTimer !== undefined) clearTimeout(e.idleTimer);
    if (e.emitTimer !== undefined) clearTimeout(e.emitTimer);
    e.idleTimer = undefined;
    e.emitTimer = undefined;
  }

  return {
    track(info) {
      if (entries.has(info.id)) return;
      const exited = info.status === "exited";
      const e: Entry = {
        info: {
          terminalId: info.id,
          projectId: info.projectId,
          ...(info.cardId !== undefined ? { cardId: info.cardId } : {}),
          ...(info.toolId !== undefined ? { toolId: info.toolId } : {}),
        },
        pending: "",
        screen: "",
        recent: "",
        lastOutputAt: undefined,
        notified: false,
        exited,
        state: exited ? "exited" : "idle",
        since: now(),
        summary: undefined,
        idleTimer: undefined,
        emitTimer: undefined,
        lastEmitted: undefined,
      };
      e.lastEmitted = JSON.stringify(snapshot(e));
      entries.set(info.id, e);
    },

    output(terminalId, data) {
      const e = live(terminalId);
      if (!e) return;
      const r = scanOutput(e.pending + data);
      // A runaway unterminated sequence is dropped rather than kept forever.
      e.pending = r.rest.length > opts.tailChars ? "" : r.rest;
      if (r.notify) e.notified = true;
      if (r.text) {
        e.screen = keepTail(e.screen + r.text, opts.tailChars);
        e.recent = keepTail(e.recent + r.text, opts.tailChars);
      }
      e.lastOutputAt = now();
      update(e);
      scheduleIdleCheck(e);
    },

    input(terminalId, data) {
      const e = live(terminalId);
      if (!e || !isUserInput(data)) return;
      e.notified = false;
      e.screen = "";
      update(e);
    },

    exit(terminalId) {
      const e = live(terminalId);
      if (!e) return;
      e.exited = true;
      if (e.idleTimer !== undefined) clearTimeout(e.idleTimer);
      e.idleTimer = undefined;
      update(e);
    },

    forget(terminalId) {
      const e = entries.get(terminalId);
      if (!e) return;
      clearTimers(e);
      entries.delete(terminalId);
    },

    get(terminalId) {
      const e = entries.get(terminalId);
      return e ? snapshot(e) : undefined;
    },

    onChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    debugSizes(terminalId) {
      const e = entries.get(terminalId);
      return e ? { pending: e.pending.length, screen: e.screen.length, recent: e.recent.length } : undefined;
    },

    dispose() {
      for (const e of entries.values()) clearTimers(e);
      entries.clear();
      listeners.clear();
    },
  };
}

// ---------- PtyManager decorator ----------

/**
 * A PtyManager whose terminals are tracked: opened terminals are subscribed, input is reported,
 * closed ones forgotten, and `get` / `list` / `open` results carry `activity`.
 */
export function withActivity(ptys: PtyManager, tracker: ActivityTracker): PtyManager {
  const subs = new Map<string, () => void>();

  function withInfo(t: TerminalInfo): TerminalInfo {
    const activity = tracker.get(t.id) ?? (t.status === "exited" ? { state: "exited" as const, since: t.createdAt } : undefined);
    return activity ? { ...t, activity } : t;
  }

  function forget(ids: string[]): void {
    for (const id of ids) {
      subs.get(id)?.();
      subs.delete(id);
      tracker.forget(id);
    }
  }

  const listener = (id: string): TerminalListener => ({
    onData: (data) => tracker.output(id, data),
    onExit: () => {
      tracker.exit(id);
      subs.delete(id);
    },
  });

  return {
    history: (terminalId) => ptys.history(terminalId),
    pid: (terminalId) => ptys.pid?.(terminalId),
    resize: (terminalId, cols, rows) => ptys.resize(terminalId, cols, rows),
    subscribe: (terminalId, l) => ptys.subscribe(terminalId, l),
    open(target, launch, size) {
      const info = ptys.open(target, launch, size);
      tracker.track(info);
      subs.set(info.id, ptys.subscribe(info.id, listener(info.id)));
      return withInfo(info);
    },
    list(filter) {
      return ptys.list(filter).map(withInfo);
    },
    get(terminalId) {
      const t = ptys.get(terminalId);
      return t ? withInfo(t) : undefined;
    },
    write(terminalId, data) {
      ptys.write(terminalId, data);
      tracker.input(terminalId, data);
    },
    close(terminalId) {
      ptys.close(terminalId);
      forget([terminalId]);
    },
    closeAllForCard(cardId) {
      const ids = ptys.list({ cardId }).map((t) => t.id);
      ptys.closeAllForCard(cardId);
      forget(ids);
    },
    closeAllForProject(projectId) {
      const ids = ptys.list({ projectId }).map((t) => t.id);
      ptys.closeAllForProject(projectId);
      forget(ids);
    },
    async shutdown() {
      forget([...subs.keys()]);
      await ptys.shutdown();
    },
  };
}
