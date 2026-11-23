// Girişler: logins.list / logins.save / logins.delete / logins.fill — strict shapes, limits, and what never crosses
// the wire back (the password).
import { describe, expect, it } from "vitest";
import {
  LOGIN_FILL_FIELDS,
  LOGIN_LIMITS,
  LoginOriginSchema,
  MAX_MESSAGE_BYTES,
  SavedLoginSchema,
  loginOriginOf,
  parseClientMessage,
} from "./protocol.ts";

const parse = (m: unknown) => parseClientMessage(JSON.stringify(m));
const ok = (m: unknown) => parse(m).ok;
const req = (method: string, params: unknown) => ({ type: "req", id: 1, method, params });
const SAVE = { projectId: "p", origin: "https://ornek.example", username: "ayşe@ornek.example", password: "gizli" };

describe("Girişler: istekler", () => {
  it("accepts the four requests", () => {
    expect(ok(req("logins.list", { projectId: "p" }))).toBe(true);
    expect(ok(req("logins.save", SAVE))).toBe(true);
    expect(ok(req("logins.save", { ...SAVE, label: "İş hesabı" }))).toBe(true);
    expect(ok(req("logins.delete", { id: "abc" }))).toBe(true);
    expect(ok(req("logins.fill", { projectId: "p", id: "abc" }))).toBe(true);
    expect(ok(req("logins.fill", { projectId: "p", id: "abc", confirmAgentRisk: true }))).toBe(true);
    expect(ok(req("logins.risk.set", { projectId: "p", accepted: true }))).toBe(true);
    expect(ok(req("logins.risk.set", { projectId: "p", accepted: false }))).toBe(true);
  });

  it("the agent-risk flags are real booleans", () => {
    for (const [method, params] of [
      ["logins.fill", { projectId: "p", id: "a", confirmAgentRisk: "yes" }],
      ["logins.fill", { projectId: "p", id: "a", confirmAgentRisk: 1 }],
      ["logins.risk.set", { projectId: "p" }],
      ["logins.risk.set", { projectId: "p", accepted: "true" }],
      ["logins.risk.set", { accepted: true }],
      ["logins.risk.set", { projectId: "p", accepted: true, forAll: true }],
    ] as const) {
      expect(ok(req(method, params)), `${method} ${JSON.stringify(params)}`).toBe(false);
    }
  });

  it("refuses missing, empty, mistyped and extra fields", () => {
    const bad: [string, unknown][] = [
      ["logins.list", {}],
      ["logins.list", { projectId: "" }],
      ["logins.list", { projectId: "p", withPasswords: true }],
      ["logins.save", { ...SAVE, password: undefined }],
      ["logins.save", { ...SAVE, password: "" }],
      ["logins.save", { ...SAVE, password: 5 }],
      ["logins.save", { ...SAVE, password: ["a"] }],
      ["logins.save", { ...SAVE, username: "" }],
      ["logins.save", { ...SAVE, username: "   " }],
      ["logins.save", { ...SAVE, username: "a\nb" }],
      ["logins.save", { ...SAVE, username: "a\u0000b" }],
      ["logins.save", { ...SAVE, label: "" }],
      ["logins.save", { ...SAVE, label: "a\tb" }],
      ["logins.save", { ...SAVE, projectId: undefined }],
      ["logins.save", { ...SAVE, id: "x" }],
      ["logins.save", { ...SAVE, submit: true }],
      ["logins.delete", {}],
      ["logins.delete", { id: "" }],
      ["logins.delete", { id: "a", projectId: "p" }],
      ["logins.fill", { id: "a" }],
      ["logins.fill", { projectId: "p" }],
      ["logins.fill", { projectId: "p", id: "a", password: "x" }],
      ["logins.fill", { projectId: "p", id: "a", origin: "https://kotu.example" }],
      ["logins.fill", { projectId: "p", id: "a", submit: true }],
      // There is no way to read a password back.
      ["logins.get", { id: "a" }],
      ["logins.reveal", { id: "a" }],
      ["logins.password", { id: "a" }],
    ];
    for (const [method, params] of bad) expect(ok(req(method, params)), `${method} ${JSON.stringify(params)?.slice(0, 80)}`).toBe(false);
  });

  it("takes values exactly at the limits and refuses one more", () => {
    const at = (n: number) => "x".repeat(n);
    expect(ok(req("logins.save", { ...SAVE, password: at(LOGIN_LIMITS.maxPasswordChars) }))).toBe(true);
    expect(ok(req("logins.save", { ...SAVE, password: at(LOGIN_LIMITS.maxPasswordChars + 1) }))).toBe(false);
    expect(ok(req("logins.save", { ...SAVE, username: at(LOGIN_LIMITS.maxUsernameChars) }))).toBe(true);
    expect(ok(req("logins.save", { ...SAVE, username: at(LOGIN_LIMITS.maxUsernameChars + 1) }))).toBe(false);
    expect(ok(req("logins.save", { ...SAVE, label: at(LOGIN_LIMITS.maxLabelChars) }))).toBe(true);
    expect(ok(req("logins.save", { ...SAVE, label: at(LOGIN_LIMITS.maxLabelChars + 1) }))).toBe(false);
    const worst = JSON.stringify(req("logins.save", { ...SAVE, password: "\u0001".repeat(LOGIN_LIMITS.maxPasswordChars) }));
    expect(Buffer.byteLength(worst)).toBeLessThan(MAX_MESSAGE_BYTES);
  });

  it("an invalid password is described without quoting it", () => {
    const secret = "çok-gizli-parola-Zx9!";
    for (const params of [
      { ...SAVE, password: secret.repeat(100) },
      { ...SAVE, password: `${secret}\ud800` },
      { ...SAVE, password: secret, extra: 1 },
      { ...SAVE, password: secret, origin: "ftp://x" },
      { ...SAVE, password: [secret] },
    ]) {
      const r = parse(req("logins.save", params));
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain(secret);
    }
  });

  it("monkey: odd Unicode passwords pass through unchanged; lone surrogates are refused", () => {
    const samples = ["İstanbul ığüşöç ĞÜŞÖÇ", "😀👨‍👩‍👧‍👦🇹🇷", "\u0001\u001f\u007f", "a\r\nb\tc", "‮RTL‬", "é", "﻿BOM", "'\"`$(rm -rf /)\\", " başta ve sonda boşluk ", "-w", "--", "  "];
    for (let i = 0; i < 300; i++) {
      let s = "";
      const n = 1 + Math.floor(Math.random() * 40);
      for (let j = 0; j < n; j++) s += String.fromCodePoint(Math.floor(Math.random() * 0x10ffff));
      samples.push(s);
    }
    for (const password of samples) {
      const r = parse(req("logins.save", { ...SAVE, password }));
      let wellFormed = true;
      try {
        encodeURIComponent(password); // throws on a lone surrogate
      } catch {
        wellFormed = false;
      }
      expect(r.ok, JSON.stringify(password)).toBe(wellFormed);
      if (r.ok && r.value.type === "req" && r.value.method === "logins.save") expect(r.value.params.password).toBe(password);
    }
    expect(ok(req("logins.save", { ...SAVE, password: "a\ud800" }))).toBe(false);
    expect(ok(req("logins.save", { ...SAVE, password: "\udc00a" }))).toBe(false);
  });

  it("monkey: random junk never parses as a save", () => {
    const junk: unknown[] = [null, 0, "", [], {}, { a: 1 }, true, "https://x", { toString: 1 }];
    for (const projectId of junk) for (const password of junk) {
      if (typeof projectId === "string" && projectId !== "" && typeof password === "string" && password !== "") continue;
      expect(ok(req("logins.save", { ...SAVE, projectId, password }))).toBe(false);
    }
  });

});

describe("Girişler: köken (scheme + host + port)", () => {
  it("accepts only a canonical http(s) origin", () => {
    for (const good of ["https://ornek.example", "http://127.0.0.1:8080", "https://a.b.example:8443", "http://localhost", "https://xn--rnek-4qa.example", "http://[::1]:3000"]) {
      expect(LoginOriginSchema.safeParse(good).success, good).toBe(true);
    }
    for (const bad of [
      "",
      "ornek.example",
      "https://ornek.example/",
      "https://ornek.example/giris",
      "https://ornek.example?x=1",
      "https://ornek.example#a",
      "https://ORNEK.example",
      "https://ornek.example:443",
      "http://ornek.example:80",
      "https://kullanici:parola@ornek.example",
      "https://örnek.example",
      "ftp://ornek.example",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "chrome://settings",
      "about:blank",
      "null",
      "https://",
      "https://a b.example",
      " https://ornek.example",
      `https://${"a".repeat(LOGIN_LIMITS.maxOriginChars)}.example`,
      5,
      null,
    ]) {
      expect(LoginOriginSchema.safeParse(bad).success, String(bad)).toBe(false);
    }
  });

  it("loginOriginOf: the origin of a page address, or undefined when the page has none worth saving", () => {
    expect(loginOriginOf("https://Ornek.Example/giris?x=1#y")).toBe("https://ornek.example");
    expect(loginOriginOf("https://ornek.example:443/")).toBe("https://ornek.example");
    expect(loginOriginOf("http://127.0.0.1:8080/a")).toBe("http://127.0.0.1:8080");
    expect(loginOriginOf("https://örnek.example/")).toBe("https://xn--rnek-4qa.example");
    for (const none of ["", "about:blank", "chrome://newtab/", "file:///x", "javascript:1", "data:text/html,a", "değil", "https://"]) {
      expect(loginOriginOf(none), none).toBeUndefined();
    }
  });

  it("subdomains, schemes and ports are different origins", () => {
    const o = loginOriginOf("https://ornek.example/")!;
    for (const other of ["https://www.ornek.example/", "http://ornek.example/", "https://ornek.example:8443/", "https://ornek.example.kotu.example/", "https://kotu.example/ornek.example"]) {
      expect(loginOriginOf(other)).not.toBe(o);
    }
  });
});

describe("Girişler: kayıt (yalnız üst veri)", () => {
  const login = { id: "a", projectId: "p", origin: "https://ornek.example", username: "ayşe", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  it("has no password field and refuses one", () => {
    expect(SavedLoginSchema.safeParse(login).success).toBe(true);
    expect(SavedLoginSchema.safeParse({ ...login, label: "İş" }).success).toBe(true);
    expect(SavedLoginSchema.safeParse({ ...login, password: "x" }).success).toBe(false);
    expect(SavedLoginSchema.safeParse({ ...login, secret: "x" }).success).toBe(false);
    expect(Object.keys(SavedLoginSchema.shape)).not.toContain("password");
  });
  it("names the fields a fill may report", () => {
    expect([...LOGIN_FILL_FIELDS]).toEqual(["username", "password"]);
  });
});
