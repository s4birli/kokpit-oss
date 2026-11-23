// Terminal history: a byte-capped ring buffer and its debounced disk persister.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EngineError } from "./contracts.ts";

/**
 * When the cut point is not right after a newline, look this fraction of the retained
 * bytes ahead for one, so a replay starts on a clean line without dropping much more.
 */
const NEWLINE_SCAN_RETAINED_FRACTION = 0.5;

/** UTF-8 byte size and UTF-16 width of the code point starting at `i`. */
function codePointAt(s: string, i: number): { bytes: number; width: number } {
  const c = s.charCodeAt(i);
  if (c < 0x80) return { bytes: 1, width: 1 };
  if (c < 0x800) return { bytes: 2, width: 1 };
  if (c >= 0xd800 && c <= 0xdbff) {
    const next = s.charCodeAt(i + 1);
    if (next >= 0xdc00 && next <= 0xdfff) return { bytes: 4, width: 2 };
  }
  // BMP char, or a lone surrogate (encoded as U+FFFD, 3 bytes — same as Buffer.byteLength).
  return { bytes: 3, width: 1 };
}

function utf8Length(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/**
 * Keeps the last `maxBytes` UTF-8 bytes of appended text. Appends are amortized
 * O(appended size): text is kept as a chunk list and only trimmed at the front.
 */
export class RingBuffer {
  readonly maxBytes: number;
  #chunks: string[] = [];
  #sizes: number[] = [];
  #head = 0;
  #total = 0;

  constructor(maxBytes: number) {
    if (!Number.isInteger(maxBytes) || maxBytes < 0) throw new RangeError(`invalid buffer size: ${maxBytes}`);
    this.maxBytes = maxBytes;
  }

  get byteLength(): number {
    return this.#total;
  }

  append(s: string): void {
    if (s.length === 0) return;
    const size = utf8Length(s);
    this.#chunks.push(s);
    this.#sizes.push(size);
    this.#total += size;
    if (this.#total > this.maxBytes) this.#trim();
  }

  toString(): string {
    const live = this.#chunks.length - this.#head;
    if (live === 0) return "";
    if (live > 1 || this.#head > 0) {
      const joined = this.#chunks.slice(this.#head).join("");
      this.#chunks = [joined];
      this.#sizes = [this.#total];
      this.#head = 0;
    }
    return this.#chunks[0] as string;
  }

  #trim(): void {
    let excess = this.#total - this.maxBytes;
    // Whole chunks first.
    while (this.#head < this.#chunks.length && (this.#sizes[this.#head] as number) <= excess) {
      const size = this.#sizes[this.#head] as number;
      excess -= size;
      this.#total -= size;
      this.#head++;
    }
    this.#compact();
    if (excess <= 0 || this.#head >= this.#chunks.length) return;

    // Partial cut inside the first chunk, on a code point boundary.
    const chunk = this.#chunks[this.#head] as string;
    let cut = 0;
    let dropped = 0;
    while (dropped < excess && cut < chunk.length) {
      const cp = codePointAt(chunk, cut);
      cut += cp.width;
      dropped += cp.bytes;
    }

    if (cut > 0 && chunk.charCodeAt(cut - 1) !== 0x0a) {
      const window = Math.min(excess, Math.floor((this.#total - dropped) * NEWLINE_SCAN_RETAINED_FRACTION));
      let j = cut;
      let scanned = 0;
      while (j < chunk.length && scanned < window) {
        const cp = codePointAt(chunk, j);
        if (cp.bytes === 1 && chunk.charCodeAt(j) === 0x0a) {
          cut = j + 1;
          dropped += scanned + 1;
          break;
        }
        j += cp.width;
        scanned += cp.bytes;
      }
    }

    this.#total -= dropped;
    if (cut >= chunk.length) {
      this.#head++;
      this.#compact();
    } else {
      this.#chunks[this.#head] = chunk.slice(cut);
      this.#sizes[this.#head] = (this.#sizes[this.#head] as number) - dropped;
    }
  }

  /** Reclaims dropped slots once they outnumber live ones (keeps trimming amortized O(1) per chunk). */
  #compact(): void {
    if (this.#head > 0 && this.#head * 2 >= this.#chunks.length) {
      this.#chunks = this.#chunks.slice(this.#head);
      this.#sizes = this.#sizes.slice(this.#head);
      this.#head = 0;
    }
  }
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const BUFFER_EXT = ".log";

export interface BufferPersisterOptions {
  buffersDir: string;
  /** Max delay between a change and its write; continuous output still gets written this often. */
  intervalMs: number;
  /** Called when a background (timer) write fails. Synchronous calls throw instead. */
  onError?: (err: unknown, terminalId: string) => void;
}

/**
 * Persists terminal buffers to `<buffersDir>/<terminalId>.log`. Writes are throttled per
 * terminal, synchronous and atomic (temp file + rename), so a remove() can never race a
 * write in flight and a crash never leaves a half-written buffer.
 */
export class BufferPersister {
  readonly #dir: string;
  readonly #intervalMs: number;
  readonly #onError: (err: unknown, terminalId: string) => void;
  readonly #pending = new Map<string, { read: () => string; timer: NodeJS.Timeout }>();
  #disposed = false;

  constructor(opts: BufferPersisterOptions) {
    this.#dir = opts.buffersDir;
    this.#intervalMs = opts.intervalMs;
    this.#onError = opts.onError ?? (() => {});
  }

  /** Schedules a write of `read()` (evaluated at write time) within intervalMs. No-op after dispose(). */
  schedule(terminalId: string, read: () => string): void {
    this.#check(terminalId);
    if (this.#disposed) return;
    const existing = this.#pending.get(terminalId);
    if (existing) {
      existing.read = read;
      return;
    }
    const timer = setTimeout(() => {
      try {
        this.flush(terminalId);
      } catch (err) {
        this.#onError(err, terminalId);
      }
    }, this.#intervalMs);
    timer.unref();
    this.#pending.set(terminalId, { read, timer });
  }

  /** Writes this terminal's pending content now, if any. */
  flush(terminalId: string): void {
    this.#check(terminalId);
    const entry = this.#pending.get(terminalId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.#pending.delete(terminalId);
    this.write(terminalId, entry.read());
  }

  /** Writes every pending buffer now. Attempts all; rethrows the first failure. */
  flushNow(): void {
    let first: unknown;
    for (const id of [...this.#pending.keys()]) {
      try {
        this.flush(id);
      } catch (err) {
        first ??= err;
      }
    }
    if (first !== undefined) throw first;
  }

  /** Atomic write of `content`, bypassing the throttle. */
  write(terminalId: string, content: string): void {
    const file = this.#file(terminalId);
    mkdirSync(this.#dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, content, "utf8");
      renameSync(tmp, file);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  }

  load(terminalId: string): string | undefined {
    const file = this.#file(terminalId);
    try {
      return readFileSync(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  /** Cancels any pending write and deletes the buffer file (missing file is fine). */
  remove(terminalId: string): void {
    const file = this.#file(terminalId);
    const entry = this.#pending.get(terminalId);
    if (entry) clearTimeout(entry.timer);
    this.#pending.delete(terminalId);
    rmSync(file, { force: true });
  }

  /** Cancels pending writes without writing them; later schedule() calls are ignored (direct writes still work). */
  dispose(): void {
    this.#disposed = true;
    for (const entry of this.#pending.values()) clearTimeout(entry.timer);
    this.#pending.clear();
  }

  #check(terminalId: string): void {
    if (typeof terminalId !== "string" || !SAFE_ID.test(terminalId)) {
      throw new EngineError("INVALID", "invalid terminal id");
    }
  }

  #file(terminalId: string): string {
    this.#check(terminalId);
    return join(this.#dir, terminalId + BUFFER_EXT);
  }
}
