// Terminal output chunking: every `output` frame fits the frame limit whatever the data is.
import { describe, expect, it } from "vitest";
import {
  MAX_MESSAGE_BYTES,
  OUTPUT_LIMITS,
  jsonStringLength,
  parseServerMessage,
  peekOutputTerminalId,
  splitOutputData,
  type ServerMessage,
} from "./protocol.ts";

/** Deterministic PRNG (mulberry32): a failing case can be replayed from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pieces a terminal really carries: text of every UTF-8 width, escape sequences, and broken halves. */
const PIECES = [
  "a",
  "plain text ",
  "çğışöü",
  "€",
  "漢字",
  "😀",
  "🚀👩‍💻",
  "\x1b[0m",
  "\x1b[38;5;196m",
  "\x1b[2J\x1b[H",
  "\x1b]52;c;QUJD\x07",
  "\x1b]0;title\x1b\\",
  "\r\n",
  "\t",
  "\b",
  "\f",
  "\x00",
  "\x7f",
  '"',
  "\\",
  " ",
  "\ud83d", // lone high surrogate
  "\ude00", // lone low surrogate
];

function randomData(next: () => number, minChars: number): string {
  const parts: string[] = [];
  let n = 0;
  while (n < minChars) {
    const p = PIECES[Math.floor(next() * PIECES.length)]!;
    parts.push(p);
    n += p.length;
  }
  return parts.join("");
}

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/** The invariants of a split, whatever the input. */
function expectGoodSplit(data: string, max: number): string[] {
  const chunks = splitOutputData(data, max);
  expect(chunks.join("") === data, "chunks join back to the data").toBe(true);
  for (const [i, c] of chunks.entries()) {
    expect(c.length, "no empty chunk").toBeGreaterThan(0);
    expect(JSON.stringify(c).length, "chunk fits its budget").toBeLessThanOrEqual(max);
    // A surrogate pair of the data is never cut in two.
    const next = chunks[i + 1];
    if (next !== undefined && isHigh(c.charCodeAt(c.length - 1))) expect(isLow(next.charCodeAt(0)), "pair split").toBe(false);
  }
  return chunks;
}

describe("OUTPUT_LIMITS", () => {
  it("data budget + envelope is exactly the frame limit", () => {
    expect(OUTPUT_LIMITS.maxDataJsonChars + OUTPUT_LIMITS.envelopeChars).toBe(MAX_MESSAGE_BYTES);
    expect(OUTPUT_LIMITS.maxDataJsonChars).toBeGreaterThan(0);
  });

  it("the envelope covers the largest frame around a chunk: longest id, fully escaped, replay part with the largest counters", () => {
    const data = "x".repeat(10);
    const worst = {
      type: "output",
      terminalId: "\u0000".repeat(OUTPUT_LIMITS.maxIdChars),
      data,
      replay: true,
      part: { index: Number.MAX_SAFE_INTEGER, total: Number.MAX_SAFE_INTEGER },
    };
    expect(JSON.stringify(worst).length - JSON.stringify(data).length).toBeLessThanOrEqual(OUTPUT_LIMITS.envelopeChars);
    // …and that id really is the longest the protocol accepts.
    const frame = (terminalId: string): boolean => parseServerMessage(JSON.stringify({ type: "output", terminalId, data: "x" })).ok;
    expect(frame("i".repeat(OUTPUT_LIMITS.maxIdChars))).toBe(true);
    expect(frame("i".repeat(OUTPUT_LIMITS.maxIdChars + 1))).toBe(false);
  });

  it("a chunk at the budget, in the worst envelope, is a frame of at most the limit — and it parses", () => {
    const terminalId = "\u0000".repeat(OUTPUT_LIMITS.maxIdChars);
    const data = "\x1b".repeat(MAX_MESSAGE_BYTES);
    const chunks = splitOutputData(data);
    expect(chunks.length).toBeGreaterThan(1);
    for (const [index, chunk] of chunks.entries()) {
      const raw = JSON.stringify({ type: "output", terminalId, data: chunk, replay: true, part: { index, total: chunks.length } } satisfies ServerMessage);
      expect(raw.length).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
      expect(parseServerMessage(raw).ok).toBe(true);
    }
  });
});

describe("jsonStringLength", () => {
  it("equals JSON.stringify(s).length for every kind of character", () => {
    for (const p of [...PIECES, "", PIECES.join(""), "\ud83d😀\ude00", "x\ud83d", "\ude00x"]) {
      expect(jsonStringLength(p), JSON.stringify(p)).toBe(JSON.stringify(p).length);
    }
    for (let c = 0; c < 0x100; c++) expect(jsonStringLength(String.fromCharCode(c))).toBe(JSON.stringify(String.fromCharCode(c)).length);
  });

  it("monkey: random terminal data", () => {
    const next = rng(20261117);
    for (let i = 0; i < 300; i++) {
      const s = randomData(next, Math.floor(next() * 400));
      expect(jsonStringLength(s)).toBe(JSON.stringify(s).length);
    }
  });
});

describe("splitOutputData", () => {
  it("empty data → no chunk; small data → itself", () => {
    expect(splitOutputData("")).toEqual([]);
    expect(splitOutputData("hello")).toEqual(["hello"]);
    expect(splitOutputData("\x1b[0m😀")).toEqual(["\x1b[0m😀"]);
  });

  it("refuses a budget that cannot hold one escaped character", () => {
    expect(() => splitOutputData("abc", OUTPUT_LIMITS.minDataJsonChars - 1)).toThrow(RangeError);
    expect(splitOutputData("abc", OUTPUT_LIMITS.minDataJsonChars).join("")).toBe("abc");
  });

  it("around the boundary: budget−1, budget, budget+1 encoded characters", () => {
    const max = 64;
    // `n` plain characters encode to n + 2.
    expect(splitOutputData("x".repeat(max - 3), max)).toHaveLength(1);
    expect(splitOutputData("x".repeat(max - 2), max)).toHaveLength(1);
    expect(splitOutputData("x".repeat(max - 1), max)).toEqual(["x".repeat(max - 2), "x"]);
    expect(expectGoodSplit("x".repeat(5 * (max - 2)), max)).toHaveLength(5);
    expect(expectGoodSplit("x".repeat(5 * (max - 2) + 1), max)).toHaveLength(6);
  });

  it("the real frame limit: data of limit−1, limit, limit+1 and several × limit", () => {
    const budget = OUTPUT_LIMITS.maxDataJsonChars;
    for (const n of [budget - 3, budget - 2, budget - 1, MAX_MESSAGE_BYTES - 1, MAX_MESSAGE_BYTES, MAX_MESSAGE_BYTES + 1, 3 * MAX_MESSAGE_BYTES + 7]) {
      const chunks = expectGoodSplit("x".repeat(n), budget);
      expect(chunks.length, `n=${n}`).toBe(Math.ceil(n / (budget - 2)));
    }
  });

  it("never cuts a surrogate pair, wherever the boundary falls", () => {
    for (let lead = 0; lead < 8; lead++) {
      const data = "x".repeat(lead) + "😀".repeat(40);
      for (let max = OUTPUT_LIMITS.minDataJsonChars; max < 30; max++) expectGoodSplit(data, max);
    }
  });

  it("escaped characters count at their JSON width (a control character is six)", () => {
    const max = 2 + 6 * 4;
    expect(splitOutputData("\x1b".repeat(9), max)).toEqual(["\x1b".repeat(4), "\x1b".repeat(4), "\x1b"]);
    expect(splitOutputData("\n".repeat(13), max)).toEqual(["\n".repeat(12), "\n"]);
  });

  it("monkey: random data, random budgets — boundaries land inside multi-byte characters and escape sequences", () => {
    const next = rng(4711);
    for (let i = 0; i < 400; i++) {
      const data = randomData(next, Math.floor(next() * 600));
      const max = OUTPUT_LIMITS.minDataJsonChars + Math.floor(next() * 200);
      expectGoodSplit(data, max);
    }
  });

  it("monkey: sizes around multiples of the real budget, escape-heavy", () => {
    const next = rng(99);
    const budget = OUTPUT_LIMITS.maxDataJsonChars;
    for (const k of [1, 2, 3]) {
      for (const delta of [-1, 0, 1]) {
        const data = randomData(next, Math.floor((k * budget) / 3) + delta);
        const chunks = expectGoodSplit(data, budget);
        expect(chunks.length).toBeGreaterThanOrEqual(Math.ceil(JSON.stringify(data).length / budget));
      }
    }
  });
});

describe("output frame schema", () => {
  const ok = (m: unknown): boolean => parseServerMessage(JSON.stringify(m)).ok;

  it("accepts a replay part, and frames without one (older engines)", () => {
    expect(ok({ type: "output", terminalId: "t", data: "x", replay: true, part: { index: 0, total: 3 } })).toBe(true);
    expect(ok({ type: "output", terminalId: "t", data: "x", replay: true })).toBe(true);
    expect(ok({ type: "output", terminalId: "t", data: "x" })).toBe(true);
  });

  it("rejects a malformed part", () => {
    for (const part of [{ index: -1, total: 1 }, { index: 1, total: 1 }, { index: 0, total: 0 }, { index: 0.5, total: 2 }, { index: 0 }, "0/1"]) {
      expect(ok({ type: "output", terminalId: "t", data: "x", replay: true, part }), JSON.stringify(part)).toBe(false);
    }
  });
});

describe("peekOutputTerminalId", () => {
  const frame = (terminalId: string, data: string): string => JSON.stringify({ type: "output", terminalId, data, replay: true } satisfies ServerMessage);

  it("names the terminal of a frame too large to decode", () => {
    const raw = frame("3f2c-uuid", "x".repeat(MAX_MESSAGE_BYTES));
    expect(parseServerMessage(raw)).toEqual({ ok: false, error: "frame too large" });
    expect(peekOutputTerminalId(raw)).toBe("3f2c-uuid");
  });

  it("reads ids that needed escaping, up to the longest id", () => {
    const odd = 'a"b\\c\n\u0000ç😀';
    expect(peekOutputTerminalId(frame(odd, "x"))).toBe(odd);
    const longest = "\u0000".repeat(OUTPUT_LIMITS.maxIdChars);
    expect(peekOutputTerminalId(frame(longest, "x"))).toBe(longest);
  });

  it("truncated or malformed output frames still name their terminal", () => {
    expect(peekOutputTerminalId(frame("t1", "abc").slice(0, -4))).toBe("t1");
    expect(peekOutputTerminalId('{"type":"output","terminalId":"t1","data":42}')).toBe("t1");
  });

  it("anything else → undefined", () => {
    for (const raw of [
      "",
      "{",
      "not json",
      JSON.stringify({ type: "exit", terminalId: "t1", exitCode: 0 }),
      JSON.stringify({ type: "res", id: 1, ok: true, result: { type: "output", terminalId: "t1" } }),
      '{"type":"output","terminalId":""',
      '{"type":"output","terminalId":"unterminated',
      `{"type":"output","terminalId":"${"i".repeat(OUTPUT_LIMITS.maxIdChars + 1)}"`,
      '{"type":"output","terminalId":"bad\\x"',
    ]) {
      expect(peekOutputTerminalId(raw), raw.slice(0, 60)).toBeUndefined();
    }
    expect(peekOutputTerminalId(undefined as unknown as string)).toBeUndefined();
  });

  it("monkey: random garbage never throws", () => {
    const next = rng(7);
    for (let i = 0; i < 500; i++) {
      const junk = randomData(next, Math.floor(next() * 80));
      expect(() => peekOutputTerminalId(junk)).not.toThrow();
      expect(() => peekOutputTerminalId(`{"type":"output","terminalId":"${junk}`)).not.toThrow();
    }
  });
});
