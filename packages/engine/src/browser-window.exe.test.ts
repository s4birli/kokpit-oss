// A running Chrome on macOS does not map its executable from /Applications: Chrome clones its bundle into the
// user's temp dir (…/X/com.google.Chrome.code_sign_clone/…/Google Chrome.app.bundle/…) and runs that clone (seen
// with lsof on Chrome 157 — it made the adoption check reject our own leftover Chrome). The check therefore asks
// whether the mapped file IS the configured Chrome's executable: the same path, or a file with the same bytes.
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isChromeExecutable } from "./browser-window.ts";

let root: string;
let chrome: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "kokpit-exe-"));
  mkdirSync(join(root, "Google Chrome.app", "Contents", "MacOS"), { recursive: true });
  chrome = join(root, "Google Chrome.app", "Contents", "MacOS", "Google Chrome");
  writeFileSync(chrome, Buffer.from("#!chrome-binary\u0000".repeat(1000)));
  chmodSync(chrome, 0o755);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("isChromeExecutable", () => {
  it("the configured executable itself", () => {
    expect(isChromeExecutable(chrome, chrome)).toBe(true);
  });

  it("Chrome's code-sign clone of itself (another path, the same bytes)", () => {
    const clone = join(root, "com.google.Chrome.code_sign_clone", "code_sign_clone.AbC123", "Google Chrome.app.bundle", "Contents", "MacOS");
    mkdirSync(clone, { recursive: true });
    copyFileSync(chrome, join(clone, "Google Chrome"));
    expect(isChromeExecutable(join(clone, "Google Chrome"), chrome)).toBe(true);
  });

  it("any other program is not: different bytes, same size, a link, a folder, nothing", () => {
    const other = join(root, "evil");
    writeFileSync(other, Buffer.from("#!evil-binary!!\u0000".repeat(1000)));
    expect(isChromeExecutable(other, chrome)).toBe(false);
    writeFileSync(join(root, "short"), "x");
    expect(isChromeExecutable(join(root, "short"), chrome)).toBe(false);
    symlinkSync(chrome, join(root, "link"));
    expect(isChromeExecutable(join(root, "link"), chrome)).toBe(false);
    expect(isChromeExecutable(root, chrome)).toBe(false);
    expect(isChromeExecutable(join(root, "yok"), chrome)).toBe(false);
    expect(isChromeExecutable(null, chrome)).toBe(false);
  });
});
