import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BufferPersister, RingBuffer } from "./buffer.ts";
import { EngineError } from "./contracts.ts";

const utf8 = (s: string): number => Buffer.byteLength(s, "utf8");
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("RingBuffer", () => {
  it("starts empty", () => {
    const b = new RingBuffer(10);
    expect(b.toString()).toBe("");
    expect(b.byteLength).toBe(0);
  });

  it("keeps everything under the cap", () => {
    const b = new RingBuffer(100);
    b.append("hello ");
    b.append("world");
    expect(b.toString()).toBe("hello world");
    expect(b.byteLength).toBe(11);
  });

  it("counts UTF-8 bytes, not code units", () => {
    const b = new RingBuffer(100);
    b.append("ş🙂");
    expect(b.byteLength).toBe(2 + 4);
  });

  it("drops from the front when over the cap", () => {
    const b = new RingBuffer(5);
    b.append("abcdefgh");
    expect(b.toString()).toBe("defgh");
    expect(b.byteLength).toBe(5);
  });

  it("prefers cutting just after a newline near the cut point", () => {
    const b = new RingBuffer(16);
    b.append("0123456789\n");
    b.append("abcdefghij\n");
    // excess = 6 bytes; the next newline is at index 10, within the scan window → cut after it.
    expect(b.toString()).toBe("abcdefghij\n");
  });

  it("hard-cuts when no newline is near", () => {
    const b = new RingBuffer(10);
    b.append("x".repeat(30));
    expect(b.toString()).toBe("x".repeat(10));
  });

  it("never splits a surrogate pair", () => {
    const b = new RingBuffer(6);
    b.append("a🙂🙂");
    // 9 bytes; must drop ≥3 → dropping 'a' alone is not enough, so the first emoji goes too.
    expect(b.toString()).toBe("🙂");
    expect(b.byteLength).toBe(4);
  });

  it("drops a code point larger than the cap entirely", () => {
    const b = new RingBuffer(3);
    b.append("🙂");
    expect(b.toString()).toBe("");
    expect(b.byteLength).toBe(0);
  });

  it("cap 0 keeps nothing", () => {
    const b = new RingBuffer(0);
    b.append("abc");
    expect(b.toString()).toBe("");
  });

  it("rejects an invalid cap", () => {
    expect(() => new RingBuffer(-1)).toThrow();
    expect(() => new RingBuffer(1.5)).toThrow();
    expect(() => new RingBuffer(Number.NaN)).toThrow();
  });

  it("handles many small appends without quadratic cost", () => {
    const b = new RingBuffer(1024);
    const t0 = performance.now();
    for (let i = 0; i < 200_000; i++) b.append("line " + i + "\n");
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(b.byteLength).toBeLessThanOrEqual(1024);
    expect(b.toString().endsWith("line 199999\n")).toBe(true);
  });

  describe("monkey", () => {
    const alphabet = ["a", "Z", "\n", "\r", " ", "ş", "ğ", "€", "中", "🙂", "👩‍💻", "\u001b[31m", "\t", "é"];
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)] as T;
    const randomString = (maxParts: number): string => {
      let s = "";
      const n = Math.floor(Math.random() * maxParts);
      for (let i = 0; i < n; i++) s += pick(alphabet);
      return s;
    };

    it("keeps byteLength ≤ cap, a valid UTF-16 suffix of all input", () => {
      for (let round = 0; round < 300; round++) {
        const cap = Math.floor(Math.random() * 200);
        const b = new RingBuffer(cap);
        let all = "";
        const appends = 1 + Math.floor(Math.random() * 40);
        for (let i = 0; i < appends; i++) {
          const s = randomString(60);
          all += s;
          b.append(s);
          const out = b.toString();
          expect(b.byteLength).toBeLessThanOrEqual(cap);
          expect(b.byteLength).toBe(utf8(out));
          expect(all.endsWith(out)).toBe(true);
          expect(LONE_SURROGATE.test(out)).toBe(false);
        }
      }
    });
  });
});

describe("BufferPersister", () => {
  const INTERVAL = 50;
  let dir: string;
  let p: BufferPersister;

  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), "kokpit-buf-")), "buffers");
    p = new BufferPersister({ buffersDir: dir, intervalMs: INTERVAL });
    vi.useFakeTimers();
  });
  afterEach(() => {
    p.dispose();
    vi.useRealTimers();
    rmSync(join(dir, ".."), { recursive: true, force: true });
  });

  it("schedules nothing after dispose (output arriving during shutdown never writes later)", () => {
    p.dispose();
    p.schedule("t1", () => "late");
    vi.advanceTimersByTime(INTERVAL * 2);
    expect(existsSync(dir)).toBe(false);
  });

  it("writes debounced, reading the latest content at write time", () => {
    let content = "a";
    const read = () => content;
    p.schedule("t1", read);
    content = "ab";
    p.schedule("t1", read);
    expect(existsSync(join(dir, "t1.log"))).toBe(false);
    vi.advanceTimersByTime(INTERVAL);
    expect(readFileSync(join(dir, "t1.log"), "utf8")).toBe("ab");
  });

  it("keeps writing under continuous output (throttle, not endless debounce)", () => {
    let n = 0;
    const read = () => String(n);
    for (let i = 0; i < 10; i++) {
      n = i;
      p.schedule("t1", read);
      vi.advanceTimersByTime(INTERVAL / 2);
    }
    expect(existsSync(join(dir, "t1.log"))).toBe(true);
  });

  it("flushNow writes pending immediately; load reads it back", () => {
    p.schedule("t1", () => "çıktı 🙂\n");
    p.flushNow();
    expect(p.load("t1")).toBe("çıktı 🙂\n");
  });

  it("load of a missing buffer is undefined", () => {
    expect(p.load("nope")).toBeUndefined();
  });

  it("writes atomically: no temp files left behind", () => {
    p.schedule("t1", () => "x");
    p.flushNow();
    expect(readdirSync(dir)).toEqual(["t1.log"]);
  });

  it("remove deletes the file and cancels a pending write", () => {
    p.schedule("t1", () => "x");
    p.flushNow();
    p.schedule("t1", () => "y");
    p.remove("t1");
    vi.advanceTimersByTime(INTERVAL * 2);
    expect(existsSync(join(dir, "t1.log"))).toBe(false);
    expect(() => p.remove("t1")).not.toThrow();
  });

  it("rejects unsafe terminal ids before touching the filesystem", () => {
    for (const bad of ["", "../x", "a/b", "a.b", "..", "x\0", "ş"]) {
      expect(() => p.schedule(bad, () => "x")).toThrow(EngineError);
      expect(() => p.load(bad)).toThrow(EngineError);
      expect(() => p.remove(bad)).toThrow(EngineError);
    }
    expect(existsSync(dir)).toBe(false);
  });

  it("reports write failures to onError instead of throwing from a timer", () => {
    const errors: unknown[] = [];
    const broken = new BufferPersister({
      buffersDir: join("/dev/null", "nope"),
      intervalMs: INTERVAL,
      onError: (e) => errors.push(e),
    });
    broken.schedule("t1", () => "x");
    expect(() => vi.advanceTimersByTime(INTERVAL)).not.toThrow();
    expect(errors.length).toBe(1);
    broken.dispose();
  });
});
