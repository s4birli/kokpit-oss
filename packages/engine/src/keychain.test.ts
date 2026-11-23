import { randomBytes } from "node:crypto";
// Girişler: the Keychain through a FAKE `security` (test/fakes/fake-security-setup.ts). The real Keychain is never
// touched here. What is proven: a secret round-trips whatever it holds; it is never in any process's argv or
// environment; every failure of the tool becomes a kind, never text; nothing hangs.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeSecurity, type FakeSecurity } from "../test/fakes/fake-security-setup.ts";
import { createKeychain, decodeSecret, encodeSecret, keychainRef, KeychainError, type Keychain, type KeychainFailure } from "./keychain.ts";
import { LoginsConfigSchema, SECURITY_LINE_MAX_CHARS, type LoginsConfig } from "./logins-config.ts";

const defaults = (JSON.parse(readFileSync(new URL("../config.defaults.json", import.meta.url), "utf8")) as { logins: LoginsConfig }).logins;
// A per-run random marker inside the secret: scans of logs / the system-wide process list look for IT, so another
// process that merely contains a common word (e.g. a branch name with "gizli") can't trip them.
const MARKER = `kokpit-${randomBytes(8).toString("hex")}`;
const SECRET = `çok gizli-parola ${MARKER} Zx9!"'\\$(x)`;
const ENGINE_KEY = "motorun-erişim-anahtarı-0123456789";

let root: string;
let fake: FakeSecurity;
let config: LoginsConfig;
let keychain: Keychain;
const REF = { service: "dev.kokpit.login.proje-1", account: "3f0c2a1e-0000-4000-8000-000000000001" };

function make(over: Partial<LoginsConfig> = {}): Keychain {
  config = LoginsConfigSchema.parse({ ...defaults, securityPath: fake.path, env: fake.env, envPassthrough: ["HOME"], timeoutMs: 5000, ...over });
  return createKeychain({ config, env: { HOME: "/ev/dizini", KOKPIT_KEY: ENGINE_KEY, PATH: "/usr/bin" } });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-keychain-")));
  fake = installFakeSecurity(root);
  keychain = make();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function kindOf(p: Promise<unknown>): Promise<KeychainFailure | "(no error)"> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(KeychainError);
    // Nothing the tool printed — and nothing that was sent to it — may ride on the error.
    expect(JSON.stringify({ m: (e as Error).message, s: (e as Error).stack, ...(e as object) })).not.toContain(MARKER);
    return (e as KeychainError).kind;
  }
  return "(no error)";
}

describe("Keychain: saklama ve okuma", () => {
  it("stores a secret and reads it back unchanged", async () => {
    await keychain.set(REF, SECRET);
    expect(await keychain.get(REF)).toBe(SECRET);
  });

  it("the stored value is the configured envelope: plain ASCII without spaces or quotes", async () => {
    await keychain.set(REF, SECRET);
    const stored = fake.items()[`${REF.service}\n${REF.account}`]!;
    expect(stored).toMatch(/^kokpit1\.[A-Za-z0-9_-]+$/);
    expect(stored).toBe(encodeSecret(SECRET, config));
    expect(decodeSecret(stored, config)).toBe(SECRET);
  });

  it("saving again replaces the secret (one item per reference)", async () => {
    await keychain.set(REF, "eski");
    await keychain.set(REF, "yeni");
    expect(await keychain.get(REF)).toBe("yeni");
    expect(Object.keys(fake.items())).toHaveLength(1);
  });

  it("keeps references apart", async () => {
    const other = { ...REF, account: "baska" };
    await keychain.set(REF, "bir");
    await keychain.set(other, "iki");
    await keychain.set({ ...REF, service: "dev.kokpit.login.proje-2" }, "üç");
    expect(await keychain.get(REF)).toBe("bir");
    expect(await keychain.get(other)).toBe("iki");
    expect(Object.keys(fake.items())).toHaveLength(3);
  });

  it("delete says whether there was an item; a deleted one is not found", async () => {
    await keychain.set(REF, SECRET);
    expect(await keychain.delete(REF)).toBe(true);
    expect(await keychain.delete(REF)).toBe(false);
    expect(await kindOf(keychain.get(REF))).toBe("notFound");
  });

  it("monkey: whatever a password holds comes back exactly", async () => {
    const samples = [" başta ve sonda boşluk ", "-w", "--", "a\nb\r\nc\td", "\"çift\" 'tek' \\ters\\", "😀👨‍👩‍👧‍👦🇹🇷", "\u0001\u001f\u007f", "‮RTL‬", "é", "kokpit1.zaten-zarf-gibi", "x".repeat(900), "ş".repeat(512)];
    for (let i = 0; i < 12; i++) {
      let s = "";
      const n = 1 + Math.floor(Math.random() * 30);
      for (let j = 0; j < n; j++) {
        const cp = Math.floor(Math.random() * 0x10ffff);
        if (cp >= 0xd800 && cp <= 0xdfff) continue;
        s += String.fromCodePoint(cp);
      }
      if (s !== "") samples.push(s);
    }
    for (const [i, secret] of samples.entries()) {
      const ref = { ...REF, account: `a${i}` };
      await keychain.set(ref, secret);
      expect(await keychain.get(ref), JSON.stringify(secret)).toBe(secret);
    }
  });
});

describe("Keychain: parola hiçbir sürecin argv'sinde ya da ortamında değildir", () => {
  it("add goes through `security -i` on stdin: argv is exactly ['-i']", async () => {
    await keychain.set(REF, SECRET);
    expect(fake.runs().map((r) => r.argv)).toEqual([["-i"]]);
  });

  it("neither the secret nor its stored form is in any run's argv or environment", async () => {
    await keychain.set(REF, SECRET);
    await keychain.get(REF);
    await keychain.delete(REF);
    const log = fake.runLog();
    expect(fake.runs()).toHaveLength(3);
    expect(log).not.toContain(MARKER);
    expect(log).not.toContain(encodeSecret(SECRET, config));
    expect(log).not.toContain(Buffer.from(SECRET, "utf8").toString("base64"));
  });

  it("the live process list never shows the secret while the tool runs", async () => {
    fake.mode("slow");
    keychain = make({ timeoutMs: 1500 });
    const pending = kindOf(keychain.set(REF, SECRET));
    await new Promise((r) => setTimeout(r, 500));
    const ps = execFileSync("ps", ["-axww", "-o", "command="], { encoding: "utf8" });
    expect(ps).toContain(fake.path); // the tool is running right now…
    expect(ps).not.toContain(MARKER); // …and nobody can read the secret off it
    expect(ps).not.toContain(encodeSecret(SECRET, config));
    expect(await pending).toBe("timeout");
  });

  it("the tool sees only the configured environment — never the engine's key", async () => {
    await keychain.set(REF, SECRET);
    const env = fake.runs()[0]!.env;
    expect(env.HOME).toBe("/ev/dizini");
    expect(env.PATH).toBe(fake.env.PATH);
    expect(env.KOKPIT_KEY).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain(ENGINE_KEY);
  });

  it("find and delete name the item only", async () => {
    await keychain.set(REF, SECRET);
    fake.clearRuns();
    await keychain.get(REF);
    await keychain.delete(REF);
    expect(fake.runs().map((r) => r.argv)).toEqual([
      ["find-generic-password", "-a", REF.account, "-s", REF.service, "-w"],
      ["delete-generic-password", "-a", REF.account, "-s", REF.service],
    ]);
  });
});

describe("Keychain: hatalar tür olur, metin olmaz; hiçbir şey asılı kalmaz", () => {
  beforeEach(async () => {
    await keychain.set(REF, SECRET);
  });

  it.each([
    ["locked", "interaction"],
    ["denied", "denied"],
    ["canceled", "denied"],
    ["nokeychain", "unavailable"],
    ["echo-error", "failed"],
  ] as const)("%s → %s for get, set and delete", async (mode, kind) => {
    fake.mode(mode);
    expect(await kindOf(keychain.get(REF))).toBe(kind);
    expect(await kindOf(keychain.set(REF, SECRET))).toBe(kind);
    expect(await kindOf(keychain.delete(REF))).toBe(kind);
  });

  it("a tool that never answers is killed after the configured time", async () => {
    fake.mode("slow");
    keychain = make({ timeoutMs: 400, confirmTimeoutMs: 400 });
    const t0 = Date.now();
    expect(await kindOf(keychain.get(REF))).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(3000);
    const ps = execFileSync("ps", ["-axww", "-o", "command="], { encoding: "utf8" });
    expect(ps).not.toContain(fake.path);
  });

  it("output that is not the envelope is garbage, not a password", async () => {
    fake.mode("garbage");
    expect(await kindOf(keychain.get(REF))).toBe("garbage");
  });

  it("a missing tool is unavailable", async () => {
    keychain = make({ securityPath: fake.missingPath });
    expect(await kindOf(keychain.get(REF))).toBe("unavailable");
    expect(await kindOf(keychain.set(REF, SECRET))).toBe("unavailable");
  });

  it("too much output is refused, not read", async () => {
    keychain = make({ maxOutputBytes: 256, maxSecretBytes: 100 });
    // An item written by something else, larger than this engine reads.
    const big = make({ maxOutputBytes: 16384 });
    await big.set(REF, "y".repeat(900));
    expect(await kindOf(keychain.get(REF))).toBe("garbage");
  });
});

describe("Keychain: sınırlar ve komut satırı", () => {
  it("a secret over the byte cap is refused before anything runs", async () => {
    keychain = make({ maxSecretBytes: 16 });
    expect(await kindOf(keychain.set(REF, "ş".repeat(9)))).toBe("tooLarge"); // 18 bytes
    expect(fake.runs()).toHaveLength(0);
    await keychain.set(REF, "ş".repeat(8));
    expect(await keychain.get(REF)).toBe("ş".repeat(8));
  });

  it("the largest allowed secret fits one command line of the real tool", async () => {
    const secret = "\u{10ffff}".repeat(Math.floor(defaults.maxSecretBytes / 4));
    await keychain.set({ service: `dev.kokpit.login.${"p".repeat(200)}`, account: "a".repeat(200) }, secret);
    expect(await keychain.get({ service: `dev.kokpit.login.${"p".repeat(200)}`, account: "a".repeat(200) })).toBe(secret);
    expect(defaults.maxCommandChars).toBeLessThanOrEqual(SECURITY_LINE_MAX_CHARS);
  });

  it("a command line over the cap is refused before anything runs", async () => {
    keychain = make({ maxCommandChars: 700, maxSecretBytes: 64 });
    expect(await kindOf(keychain.set({ service: `s${"x".repeat(400)}`, account: "a".repeat(300) }, "p"))).toBe("tooLarge");
    expect(fake.runs()).toHaveLength(0);
  });

  it.each(["", "-U", "a b", 'a"b', "a'b", "a\\b", "a\nb", "a\u0000b", "ç", "a;b", "$(x)", "`x`"])("refuses the unsafe reference word %j before anything runs", async (word) => {
    expect(await kindOf(keychain.set({ service: word, account: "a" }, "p"))).toBe("invalid");
    expect(await kindOf(keychain.get({ service: "s", account: word }))).toBe("invalid");
    expect(await kindOf(keychain.delete({ service: word, account: word }))).toBe("invalid");
    expect(fake.runs()).toHaveLength(0);
  });

  it("an empty secret is refused", async () => {
    expect(await kindOf(keychain.set(REF, ""))).toBe("invalid");
  });

  it("keychainRef builds service and account from the config and refuses ids that are not plain words", () => {
    expect(keychainRef(config, "proje-1", "abc")).toEqual({ service: "dev.kokpit.login.proje-1", account: "abc" });
    const custom = LoginsConfigSchema.parse({ ...config, servicePrefix: "x.", accountFormat: "kokpit/{loginId}" });
    expect(keychainRef(custom, "p", "id")).toEqual({ service: "x.p", account: "kokpit/id" });
    for (const bad of ["a b", "-x", "ç", ""]) {
      expect(() => keychainRef(config, bad, "abc")).toThrow(KeychainError);
      expect(() => keychainRef(config, "p", bad)).toThrow(KeychainError);
    }
  });

  it("decodeSecret refuses anything that is not the envelope", () => {
    for (const bad of ["", "kokpit1.", "kokpit2.YQ", "YQ", "kokpit1.a b", "kokpit1.çç", "kokpit1.YQ==", `kokpit1.${Buffer.from([0xff, 0xfe]).toString("base64url")}`]) {
      expect(() => decodeSecret(bad, config), bad).toThrow(KeychainError);
    }
  });
});

describe("Keychain: erişim politikası (keychainAccess)", () => {
  const KEY = `${REF.service}\n${REF.account}`;
  const ADD_CONFIRM = ["add-generic-password", "-a", REF.account, "-s", REF.service, "-w", "<secret>", "-T", ""];

  it("the shipped default is 'confirm'", () => {
    expect(defaults.keychainAccess).toBe("confirm");
    expect(defaults.confirmTimeoutMs).toBeGreaterThan(defaults.timeoutMs);
  });

  it("confirm: the item is created with an EMPTY trusted-application list (-T \"\"), on stdin, argv still just -i", async () => {
    keychain = make({ keychainAccess: "confirm" });
    await keychain.set(REF, SECRET);
    expect(fake.runs().map((r) => r.argv)).toEqual([["-i"]]);
    // Created fresh every time (delete, then add without -U): an update would keep whatever access list the old item had.
    expect(fake.commands()).toEqual([["delete-generic-password", "-a", REF.account, "-s", REF.service], ADD_CONFIRM]);
    expect(fake.trusted()).toEqual({ [KEY]: "nobody" });
    expect(fake.runLog()).not.toContain(MARKER);
  });

  it("confirm: saving again recreates the item, so an item made in silent mode loses its trusted tool", async () => {
    await make({ keychainAccess: "silent" }).set(REF, "eski");
    expect(fake.trusted()).toEqual({ [KEY]: "security" });
    keychain = make({ keychainAccess: "confirm" });
    await keychain.set(REF, "yeni");
    expect(fake.trusted()).toEqual({ [KEY]: "nobody" });
    expect(await keychain.get(REF)).toBe("yeni");
    expect(Object.keys(fake.items())).toHaveLength(1);
  });

  it("silent: one add with -U and no -T — the creating tool stays trusted (any program of this user can read)", async () => {
    keychain = make({ keychainAccess: "silent" });
    await keychain.set(REF, SECRET);
    expect(fake.commands()).toEqual([["add-generic-password", "-U", "-a", REF.account, "-s", REF.service, "-w", "<secret>"]]);
    expect(fake.trusted()).toEqual({ [KEY]: "security" });
  });

  it("confirm: a read waits for the user's approval up to confirmTimeoutMs, not the short timeout", async () => {
    keychain = make({ keychainAccess: "confirm", timeoutMs: 1000, confirmTimeoutMs: 8000 });
    await keychain.set(REF, SECRET);
    fake.mode("allow-after:2500");
    expect(await keychain.get(REF)).toBe(SECRET);
  });

  it("silent: a read that takes that long is a timeout", async () => {
    keychain = make({ keychainAccess: "silent", timeoutMs: 1000, confirmTimeoutMs: 8000 });
    await keychain.set(REF, SECRET);
    fake.mode("allow-after:2500");
    expect(await kindOf(keychain.get(REF))).toBe("timeout");
  });

  it("confirm: nobody answers → timeout after confirmTimeoutMs; the user says no → denied", async () => {
    keychain = make({ keychainAccess: "confirm", timeoutMs: 1000, confirmTimeoutMs: 2000 });
    await keychain.set(REF, SECRET);
    fake.mode("slow");
    const t0 = Date.now();
    expect(await kindOf(keychain.get(REF))).toBe("timeout");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1900);
    fake.mode("canceled");
    expect(await kindOf(keychain.get(REF))).toBe("denied");
  });

  it("confirm: a failed add after the delete is reported (never silently an old password)", async () => {
    keychain = make({ keychainAccess: "confirm" });
    await keychain.set(REF, "eski");
    fake.mode("locked", "add-generic-password");
    expect(await kindOf(keychain.set(REF, "yeni"))).toBe("interaction");
    fake.mode("ok");
    expect(await kindOf(keychain.get(REF))).toBe("notFound");
  });
});

describe("logins config", () => {
  it("ships complete defaults", () => {
    expect(LoginsConfigSchema.safeParse(defaults).success).toBe(true);
    expect(defaults.securityPath).toBe("/usr/bin/security");
    expect(defaults.envPassthrough).not.toContain("KOKPIT_KEY");
  });
  it.each([
    [{ securityPath: "security" }],
    [{ servicePrefix: "a b" }],
    [{ servicePrefix: "-x" }],
    [{ accountFormat: "sabit" }],
    [{ accountFormat: "{loginId} x" }],
    [{ secretPrefix: 'a"' }],
    [{ maxCommandChars: SECURITY_LINE_MAX_CHARS + 1 }],
    [{ maxSecretBytes: 3000, maxCommandChars: 4000 }],
    [{ timeoutMs: 0 }],
    [{ bilinmeyen: 1 }],
  ])("refuses %j", (over) => {
    expect(LoginsConfigSchema.safeParse({ ...defaults, ...over }).success).toBe(false);
  });
});
