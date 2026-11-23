import { describe, expect, it } from "vitest";
import { t as msg } from "../../i18n/index.ts";
import { clipboardConfig, parseOsc52, utf8Bytes, type ClipboardConfig } from "./clipboard-ipc.ts";

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const cfg: ClipboardConfig = { ...clipboardConfig, osc52MaxBytes: 16, osc52Targets: "c" };

describe("parseOsc52", () => {
  it("decodes a clipboard write (UTF-8)", () => {
    expect(parseOsc52(`c;${b64("merhaba çğış")}`, clipboardConfig)).toEqual({ kind: "write", text: "merhaba çğış" });
  });

  it("an empty target means the clipboard; a target list that names it is accepted", () => {
    expect(parseOsc52(`;${b64("a")}`, cfg)).toEqual({ kind: "write", text: "a" });
    expect(parseOsc52(`pc;${b64("a")}`, cfg)).toEqual({ kind: "write", text: "a" });
  });

  it("refuses other selections", () => {
    expect(parseOsc52(`p;${b64("a")}`, cfg)).toEqual({ kind: "refused", reason: "target" });
    expect(parseOsc52(`c0;${b64("a")}`, { ...cfg, osc52Targets: "" })).toEqual({ kind: "refused", reason: "target" });
  });

  it("never answers a read request", () => {
    expect(parseOsc52("c;?", clipboardConfig)).toEqual({ kind: "refused", reason: "read" });
    expect(parseOsc52(";?", clipboardConfig)).toEqual({ kind: "refused", reason: "read" });
  });

  it("refuses payloads over the cap, before and after decoding", () => {
    expect(parseOsc52(`c;${b64("x".repeat(16))}`, cfg)).toEqual({ kind: "write", text: "x".repeat(16) });
    expect(parseOsc52(`c;${b64("x".repeat(17))}`, cfg)).toEqual({ kind: "refused", reason: "too-large" });
    expect(parseOsc52(`c;${b64("x".repeat(5000))}`, cfg)).toEqual({ kind: "refused", reason: "too-large" });
  });

  it("refuses malformed input without throwing", () => {
    for (const bad of ["", "c", ";", "c;", "c;!!!@@@", "c;=====", "c;YQ=YQ", "c;YQ", "c;a b", "c;\u0000", "ç;YQ==", "c;YQ==;extra"]) {
      expect(parseOsc52(bad, clipboardConfig), bad).toMatchObject({ kind: "refused" });
    }
  });

  it("refuses bytes that are not UTF-8 text", () => {
    expect(parseOsc52(`c;${Buffer.from([0xff, 0xfe, 0xfd]).toString("base64")}`, clipboardConfig)).toEqual({ kind: "refused", reason: "malformed" });
  });

  it("survives random garbage", () => {
    let seed = 7;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 500; i++) {
      const s = Array.from({ length: Math.floor(rnd() * 40) }, () => String.fromCharCode(Math.floor(rnd() * 300))).join("");
      const r = parseOsc52(s, cfg);
      if (r.kind === "write") expect(utf8Bytes(r.text)).toBeLessThanOrEqual(cfg.osc52MaxBytes);
    }
  });
});

describe("clipboardConfig", () => {
  it("has a positive cap and a hint", () => {
    expect(clipboardConfig.osc52MaxBytes).toBeGreaterThan(0);
    expect(msg("terminal.clipboard.selectionHint")).toContain("Option");
  });
});
