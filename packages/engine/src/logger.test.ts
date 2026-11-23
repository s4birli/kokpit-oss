import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.ts";

function capture() {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));
  const lines = () =>
    chunks
      .join("")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { stream, lines };
}

describe("createLogger", () => {
  it("writes one JSON line per entry with ts, level, msg and extra fields", () => {
    const { stream, lines } = capture();
    const log = createLogger({ stream });
    log.info("başladı", { port: 7420 });
    log.warn("dikkat");
    log.error("hata", { code: "X" });
    const out = lines();
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ level: "info", msg: "başladı", port: 7420 });
    expect(out[1]).toMatchObject({ level: "warn", msg: "dikkat" });
    expect(out[2]).toMatchObject({ level: "error", msg: "hata", code: "X" });
    for (const e of out) expect(Number.isNaN(Date.parse(String(e.ts)))).toBe(false);
  });

  it("redacts fields named key, also when nested", () => {
    const { stream, lines } = capture();
    const log = createLogger({ stream });
    log.info("cfg", { key: "s3cret", nested: { key: "s3cret2", other: 1 } });
    const raw = JSON.stringify(lines());
    expect(raw).not.toContain("s3cret");
    expect(lines()[0]).toMatchObject({ key: "[redacted]", nested: { key: "[redacted]", other: 1 } });
  });

  it("does not let extra fields overwrite ts, level or msg", () => {
    const { stream, lines } = capture();
    createLogger({ stream }).info("real", { msg: "fake", level: "error", ts: "x" });
    expect(lines()[0]).toMatchObject({ msg: "real", level: "info" });
    expect(lines()[0]?.ts).not.toBe("x");
  });

  it("survives errors, circular references and bigints in extra", () => {
    const { stream, lines } = capture();
    const circ: Record<string, unknown> = { a: 1 };
    circ.self = circ;
    const log = createLogger({ stream });
    log.error("boom", { err: new Error("kaput"), circ, big: 10n });
    const e = lines()[0] as Record<string, any>;
    expect(e.err.message).toBe("kaput");
    expect(e.circ.self).toBe("[circular]");
    expect(e.big).toBe("10");
  });
});
