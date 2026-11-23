import type { TerminalInfo } from "@kokpit/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActivityTracker, scanOutput, isUserInput, type ActivityChange, type ActivityTracker } from "./activity.ts";

const WINDOW_MS = 1000;
const DEBOUNCE_MS = 100;
const SCAN_LINES = 5;
const SUMMARY_MAX = 40;
const TAIL_CHARS = 2000;
const CLAUDE = ["Do you want to proceed\\?", "❯ *1\\. *Yes"];
const GENERIC = ["\\[[yY]/[nN]\\]"];

function info(id: string, extra: Partial<TerminalInfo> = {}): TerminalInfo {
  return { id, projectId: "p", title: id, status: "running", createdAt: new Date(0).toISOString(), ...extra };
}

let tracker: ActivityTracker;
let changes: ActivityChange[];
let warn: ReturnType<typeof vi.fn<(msg: string, extra?: Record<string, unknown>) => void>>;

function make(patterns: Record<string, string[]> = { claude: CLAUDE }) {
  warn = vi.fn<(msg: string, extra?: Record<string, unknown>) => void>();
  tracker = createActivityTracker({
    windowMs: WINDOW_MS,
    debounceMs: DEBOUNCE_MS,
    scanLines: SCAN_LINES,
    summaryMaxLen: SUMMARY_MAX,
    tailChars: TAIL_CHARS,
    patternsFor: (toolId) => (toolId !== undefined && patterns[toolId]) || GENERIC,
    logger: { info() {}, warn, error() {} },
  });
  changes = [];
  tracker.onChange((c) => changes.push(c));
}

const state = (id = "t") => tracker.get(id)?.state;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-16T10:00:00.000Z"));
  make();
});
afterEach(() => {
  tracker.dispose();
  vi.useRealTimers();
});

describe("scanOutput", () => {
  it("strips CSI/OSC/charset sequences, keeps text, turns cursor moves into line breaks", () => {
    const r = scanOutput("\x1b[1;32mhello\x1b[0m\x1b[2;1Hworld\x1b(B\x1b]0;title\x07!");
    expect(r.text).toBe("hello\nworld!");
    expect(r.notify).toBe(false);
    expect(r.rest).toBe("");
  });

  it("cursor-forward becomes a space so words stay apart", () => {
    expect(scanOutput("Do\x1b[1Cyou").text).toBe("Do you");
  });

  it("a bare BEL is a notification; a BEL ending an OSC title is not", () => {
    expect(scanOutput("done\x07").notify).toBe(true);
    expect(scanOutput("\x1b]0;my title\x07").notify).toBe(false);
    expect(scanOutput("\x1b]2;x\x1b\\").notify).toBe(false);
  });

  it("OSC 9, OSC 777 and OSC 99 are notifications; OSC 9;4 (progress) is not", () => {
    expect(scanOutput("\x1b]9;Claude needs you\x07").notify).toBe(true);
    expect(scanOutput("\x1b]777;notify;Claude;waiting\x1b\\").notify).toBe(true);
    expect(scanOutput("\x1b]99;;hi\x1b\\").notify).toBe(true);
    expect(scanOutput("\x1b]9;4;3;\x07").notify).toBe(false);
  });

  it("returns an unfinished escape sequence as rest, so a split sequence is joined with the next chunk", () => {
    const a = scanOutput("abc\x1b]9;need");
    expect(a.text).toBe("abc");
    expect(a.notify).toBe(false);
    expect(a.rest).toBe("\x1b]9;need");
    const b = scanOutput(a.rest + " you\x07");
    expect(b.notify).toBe(true);
    expect(scanOutput("x\x1b[3").rest).toBe("\x1b[3");
    expect(scanOutput("x\x1b").rest).toBe("\x1b");
  });

  it("drops other control characters, CR starts a new line", () => {
    expect(scanOutput("a\bb\tc\r\nd\re").text).toBe("ab c\n\nd\ne");
  });
});

describe("isUserInput", () => {
  it("counts keystrokes, Enter, Ctrl-C and a bare Esc", () => {
    for (const s of ["y", "\r", "\x03", "\x1b", "hello"]) expect(isUserInput(s)).toBe(true);
  });
  it("ignores terminal replies (focus, device attributes, cursor reports) and bare arrows", () => {
    for (const s of ["\x1b[I", "\x1b[O", "\x1b[?1;2c", "\x1b[12;40R", "\x1b[A", "\x1b]11;rgb:0000/0000/0000\x1b\\"]) {
      expect(isUserInput(s)).toBe(false);
    }
  });
});

describe("activity tracker", () => {
  it("a new terminal is idle; output makes it running; silence for the window makes it idle again", () => {
    tracker.track(info("t"));
    expect(state()).toBe("idle");
    tracker.output("t", "compiling...\r\n");
    expect(state()).toBe("running");
    vi.advanceTimersByTime(WINDOW_MS - 1);
    expect(state()).toBe("running");
    vi.advanceTimersByTime(1);
    expect(state()).toBe("idle");
  });

  it("continuous output keeps it running", () => {
    tracker.track(info("t"));
    for (let i = 0; i < 20; i++) {
      tracker.output("t", `line ${i}\r\n`);
      vi.advanceTimersByTime(WINDOW_MS / 2);
      expect(state()).toBe("running");
    }
  });

  it("a waiting pattern of the terminal's tool in the last lines means waiting, even through ANSI noise", () => {
    tracker.track(info("t", { toolId: "claude" }));
    tracker.output("t", "\x1b[2K\x1b[1G\x1b[1mDo\x1b[1Cyou want to\x1b[22m proceed?\x1b[0m\r\n\x1b[36m❯ 1. Yes\x1b[39m\r\n  2. No\r\n");
    expect(state()).toBe("waiting");
    vi.advanceTimersByTime(WINDOW_MS * 5);
    expect(state()).toBe("waiting");
  });

  it("matches a pattern split across output chunks", () => {
    tracker.track(info("t", { toolId: "claude" }));
    tracker.output("t", "Do you want to pro");
    expect(state()).toBe("running");
    tracker.output("t", "ceed?\r\n");
    expect(state()).toBe("waiting");
  });

  it("uses the generic patterns for terminals without a tool, not another tool's", () => {
    tracker.track(info("t"));
    tracker.output("t", "Do you want to proceed?\r\n");
    expect(state()).toBe("running");
    tracker.output("t", "Overwrite file? [y/N] ");
    expect(state()).toBe("waiting");
  });

  it("a pattern scrolled out of the last scanned lines no longer counts", () => {
    tracker.track(info("t", { toolId: "claude" }));
    tracker.output("t", "Do you want to proceed?\r\n");
    expect(state()).toBe("waiting");
    tracker.output("t", Array.from({ length: SCAN_LINES }, (_, i) => `out ${i}`).join("\r\n"));
    expect(state()).toBe("running");
  });

  it("blank lines do not push a prompt out of the scanned lines", () => {
    tracker.track(info("t", { toolId: "claude" }));
    tracker.output("t", "Do you want to proceed?" + "\r\n   \r\n".repeat(SCAN_LINES * 2));
    expect(state()).toBe("waiting");
  });

  it("user input answers the prompt: the screen scanned for patterns starts over", () => {
    tracker.track(info("t", { toolId: "claude" }));
    tracker.output("t", "Do you want to proceed?\r\n❯ 1. Yes\r\n");
    expect(state()).toBe("waiting");
    tracker.input("t", "1");
    expect(state()).toBe("running");
    vi.advanceTimersByTime(WINDOW_MS);
    expect(state()).toBe("idle");
  });

  it("terminal replies sent as input do not dismiss a waiting state", () => {
    tracker.track(info("t", { toolId: "claude" }));
    tracker.output("t", "Do you want to proceed?\r\n");
    tracker.input("t", "\x1b[I");
    tracker.input("t", "\x1b[?1;2c");
    expect(state()).toBe("waiting");
  });

  it("a bell after the last input means waiting until the next input", () => {
    tracker.track(info("t"));
    tracker.input("t", "make\r");
    tracker.output("t", "done\x07");
    expect(state()).toBe("waiting");
    vi.advanceTimersByTime(WINDOW_MS * 3);
    expect(state()).toBe("waiting");
    tracker.input("t", "x");
    expect(state()).not.toBe("waiting");
  });

  it("an OSC 9 notification (iTerm2 style) means waiting; OSC 9;4 progress does not", () => {
    tracker.track(info("t"));
    tracker.output("t", "\x1b]9;4;3;\x07working\r\n");
    expect(state()).toBe("running");
    tracker.output("t", "\x1b]9;Claude is waiting for your input\x07");
    expect(state()).toBe("waiting");
  });

  it("an OSC 777 notification split across chunks means waiting", () => {
    tracker.track(info("t"));
    tracker.output("t", "\x1b]777;notify;Cla");
    expect(state()).toBe("running");
    tracker.output("t", "ude;needs you\x1b\\");
    expect(state()).toBe("waiting");
  });

  it("exit wins over everything and stops timers", () => {
    tracker.track(info("t", { toolId: "claude" }));
    tracker.output("t", "Do you want to proceed?\r\n");
    tracker.exit("t");
    expect(state()).toBe("exited");
    tracker.output("t", "late");
    vi.advanceTimersByTime(WINDOW_MS * 2);
    expect(state()).toBe("exited");
  });

  it("since is the time the state was entered", () => {
    tracker.track(info("t"));
    const t0 = tracker.get("t")!.since;
    vi.advanceTimersByTime(300);
    tracker.output("t", "a\r\n");
    const t1 = tracker.get("t")!.since;
    expect(Date.parse(t1) - Date.parse(t0)).toBe(300);
    vi.advanceTimersByTime(200);
    tracker.output("t", "b\r\n");
    expect(tracker.get("t")!.since).toBe(t1);
  });

  it("summary is the last meaningful stripped line, bounded", () => {
    tracker.track(info("t"));
    tracker.output("t", "\x1b[32mfirst line\x1b[0m\r\nsecond   line  \r\n╰──────╯\r\n\r\n");
    expect(tracker.get("t")!.summary).toBe("second line");
    tracker.output("t", "x".repeat(SUMMARY_MAX * 3));
    const s = tracker.get("t")!.summary!;
    expect(s.length).toBeLessThanOrEqual(SUMMARY_MAX);
    expect(s.endsWith("…")).toBe(true);
  });

  it("summary survives user input (only pattern scanning starts over)", () => {
    tracker.track(info("t"));
    tracker.output("t", "Build ok\r\n");
    tracker.input("t", "\r");
    expect(tracker.get("t")!.summary).toBe("Build ok");
  });

  it("change events are throttled and carry project, card and activity", () => {
    tracker.track(info("t", { projectId: "proj", cardId: "card" }));
    for (let i = 0; i < 50; i++) tracker.output("t", `line ${i}\r\n`);
    expect(changes).toHaveLength(0);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ terminalId: "t", projectId: "proj", cardId: "card" });
    expect(changes[0]!.activity).toMatchObject({ state: "running", summary: "line 49" });
    vi.advanceTimersByTime(WINDOW_MS);
    expect(changes.at(-1)!.activity.state).toBe("idle");
  });

  it("no event when nothing visible changed", () => {
    tracker.track(info("t"));
    tracker.output("t", "same\r\n");
    vi.advanceTimersByTime(DEBOUNCE_MS);
    const n = changes.length;
    tracker.output("t", "\x1b[0m");
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(changes).toHaveLength(n);
  });

  it("forget drops the terminal and its timers; unknown ids are ignored", () => {
    tracker.track(info("t"));
    tracker.output("t", "x\r\n");
    tracker.forget("t");
    expect(tracker.get("t")).toBeUndefined();
    vi.advanceTimersByTime(WINDOW_MS * 2);
    expect(changes).toHaveLength(0);
    expect(() => {
      tracker.output("nope", "x");
      tracker.input("nope", "x");
      tracker.exit("nope");
      tracker.forget("nope");
    }).not.toThrow();
  });

  it("an invalid pattern is skipped (warned once), the rest still work", () => {
    make({ claude: ["(broken", "Do you want to proceed\\?"] });
    tracker.track(info("t", { toolId: "claude" }));
    tracker.output("t", "Do you want to proceed?\r\n");
    tracker.output("t", "Do you want to proceed?\r\n");
    expect(state()).toBe("waiting");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("picks up edited patterns without re-tracking", () => {
    const patterns: Record<string, string[]> = { claude: [] };
    make(patterns);
    tracker.track(info("t", { toolId: "claude" }));
    tracker.output("t", "Allow this? ");
    expect(state()).toBe("running");
    patterns.claude = ["Allow this\\?"];
    tracker.output("t", "\x1b[0m");
    expect(state()).toBe("waiting");
  });

  it("monkey: random output streams never throw, keep state valid and bounded memory", () => {
    const alphabet = ["a", "Z", " ", "\r", "\n", "\x07", "\x1b", "[", "]", "9", ";", "4", "\\", "❯", "?", "\x00", "\u00ff", "1", "m", "H"];
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    tracker.track(info("t", { toolId: "claude" }));
    for (let i = 0; i < 2000; i++) {
      let chunk = "";
      const len = rand(200);
      for (let j = 0; j < len; j++) chunk += alphabet[rand(alphabet.length)];
      if (rand(10) === 0) tracker.input("t", chunk.slice(0, 5));
      else tracker.output("t", chunk);
      if (rand(5) === 0) vi.advanceTimersByTime(rand(WINDOW_MS * 2));
      const a = tracker.get("t")!;
      expect(["running", "waiting", "idle"]).toContain(a.state);
      expect(Number.isNaN(Date.parse(a.since))).toBe(false);
      if (a.summary !== undefined) expect(a.summary.length).toBeLessThanOrEqual(SUMMARY_MAX);
    }
    // An endless unterminated escape sequence must not grow memory without bound.
    tracker.output("t", "\x1b]9;" + "x".repeat(TAIL_CHARS * 10));
    expect(tracker.debugSizes("t")!.pending).toBeLessThanOrEqual(TAIL_CHARS);
    expect(tracker.debugSizes("t")!.screen).toBeLessThanOrEqual(TAIL_CHARS);
  });
});
