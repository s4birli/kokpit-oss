// Guards the design rule: colours only in theme.css, everything else uses variables.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const UI_DIR = import.meta.dirname;
const COLOUR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(css|tsx?)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("theme", () => {
  it("declares the design tokens", () => {
    const css = readFileSync(join(UI_DIR, "theme.css"), "utf8");
    for (const token of ["--bg", "--rail", "--panel", "--border", "--border-strong", "--text", "--muted", "--accent", "--accent-text", "--warn", "--ok", "--danger", "--term-bg", "--font-ui", "--font-mono", "--touch"]) {
      expect(css).toMatch(new RegExp(`${token}:`));
    }
    expect(css).not.toMatch(/@import|url\(/);
  });

  it("has no colour literals outside theme.css", () => {
    const offenders = sources(UI_DIR)
      .filter((p) => !p.endsWith("theme.css"))
      .filter((p) => COLOUR.test(readFileSync(p, "utf8")));
    expect(offenders).toEqual([]);
  });
});
