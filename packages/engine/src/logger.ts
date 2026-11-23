// Structured logger: one JSON object per line. Fields named `key` are redacted
// at any depth so the access key can never leak into logs.
import type { Logger } from "./contracts.ts";

type Level = "debug" | "info" | "warn" | "error";

const REDACTED_FIELDS = new Set(["key"]);
const REDACTED = "[redacted]";

function sanitize(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  try {
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack };
    }
    if (Array.isArray(value)) return value.map((v) => sanitize(v, seen));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACTED_FIELDS.has(k) ? REDACTED : sanitize(v, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/** `debug`: also write debug lines (off by default: they are detail, e.g. every keep-alive tick). */
export function createLogger(opts: { stream?: NodeJS.WritableStream; debug?: boolean } = {}): Logger {
  const stream = opts.stream ?? process.stdout;
  const write = (level: Level, msg: string, extra?: Record<string, unknown>) => {
    const fields = extra ? (sanitize(extra, new WeakSet()) as Record<string, unknown>) : {};
    const head = { ts: new Date().toISOString(), level, msg };
    // head first for readable key order, then again so extras can't override it
    const entry = { ...head, ...fields, ...head };
    stream.write(JSON.stringify(entry) + "\n");
  };
  return {
    info: (msg, extra) => write("info", msg, extra),
    warn: (msg, extra) => write("warn", msg, extra),
    error: (msg, extra) => write("error", msg, extra),
    ...(opts.debug === true ? { debug: (msg: string, extra?: Record<string, unknown>) => write("debug", msg, extra) } : {}),
  };
}
