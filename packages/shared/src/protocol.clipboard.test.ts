// Kopyalama (akıtılan yüzeyler): browser.copy / browser.paste / browser.context requests.
import { describe, expect, it } from "vitest";
import { CLIPBOARD_LIMITS, MAX_MESSAGE_BYTES, parseClientMessage } from "./protocol.ts";

const ok = (m: unknown) => parseClientMessage(JSON.stringify(m)).ok;
const req = (method: string, params: unknown) => ({ type: "req", id: 1, method, params });
const P = { projectId: "p" };

describe("Kopyalama: tarayıcı sayfası panosu", () => {
  it("accepts the browser clipboard requests", () => {
    expect(ok(req("browser.copy", P))).toBe(true);
    expect(ok(req("browser.copy", { ...P, cut: true }))).toBe(true);
    expect(ok(req("browser.paste", { ...P, text: "merhaba çğıöşü İ" }))).toBe(true);
    expect(ok(req("browser.context", { ...P, x: 10.5, y: 20 }))).toBe(true);
  });


  it("refuses malformed, empty, oversized and extra fields", () => {
    const big = "x".repeat(CLIPBOARD_LIMITS.maxChars + 1);
    const bad: [string, unknown][] = [
      ["browser.copy", {}],
      ["browser.copy", { ...P, cut: "yes" }],
      ["browser.copy", { ...P, selector: "body" }],
      ["browser.copy", { ...P, expression: "document.body.innerText" }],
      ["browser.paste", P],
      ["browser.paste", { ...P, text: "" }],
      ["browser.paste", { ...P, text: big }],
      ["browser.paste", { ...P, text: 5 }],
      ["browser.paste", { ...P, text: "a", html: "<b>a</b>" }],
      ["browser.context", P],
      ["browser.context", { ...P, x: -1, y: 0 }],
      ["browser.context", { ...P, x: 1, y: "2" }],
      ["browser.context", { ...P, x: 1, y: 2, selector: "a" }],
    ];
    for (const [method, params] of bad) expect(ok(req(method, params)), `${method} ${JSON.stringify(params).slice(0, 60)}`).toBe(false);
  });

  it("takes text exactly at the cap, and the cap fits one frame even when every character is escaped", () => {
    expect(ok(req("browser.paste", { ...P, text: "x".repeat(CLIPBOARD_LIMITS.maxChars) }))).toBe(true);
    // Worst case in JSON: a control character is written as \u00XX (6 bytes).
    const worst = JSON.stringify(req("browser.paste", { ...P, text: "\u0001".repeat(CLIPBOARD_LIMITS.maxChars) }));
    expect(Buffer.byteLength(worst)).toBeLessThan(MAX_MESSAGE_BYTES);
    const astral = JSON.stringify(req("browser.paste", { ...P, text: "😀".repeat(CLIPBOARD_LIMITS.maxChars / 2) }));
    expect(Buffer.byteLength(astral)).toBeLessThan(MAX_MESSAGE_BYTES);
  });


});
