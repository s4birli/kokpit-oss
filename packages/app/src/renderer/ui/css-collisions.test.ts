// @vitest-environment node
// Two stylesheets defining the same class silently fight (e.g. Ayarlar tabs rendered as the terminal tab
// column). Every component stylesheet must own its class names; a class may be defined in one file only.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const UI_DIR = fileURLToPath(new URL(".", import.meta.url));

function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...cssFiles(p));
    else if (name.endsWith(".css")) out.push(p);
  }
  return out;
}

/**
 * Classes a stylesheet DEFINES: selectors that are exactly one bare class (`.kp-tabs`). Variants and scoped
 * overrides (`.kp-input[aria-invalid]`, `.kp-view:has(…)`, `.kp-flow .kp-btn`) only adjust an owner's class and
 * are allowed elsewhere. @-rule preludes are skipped.
 */
function definedClasses(css: string): Set<string> {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const preludes = noComments.match(/[^{}]+(?=\{)/g) ?? [];
  const names = new Set<string>();
  for (const prelude of preludes) {
    if (prelude.trim().startsWith("@")) continue;
    for (const sel of prelude.split(",")) {
      const m = /^\s*\.(kp-[A-Za-z0-9_-]+)\s*$/.exec(sel);
      if (m) names.add(m[1]!);
    }
  }
  return names;
}

describe("component stylesheets own their class names", () => {
  it("no kp-* class is defined in more than one stylesheet", () => {
    const owners = new Map<string, string[]>();
    for (const file of cssFiles(UI_DIR)) {
      for (const cls of definedClasses(readFileSync(file, "utf8"))) {
        owners.set(cls, [...(owners.get(cls) ?? []), relative(UI_DIR, file)]);
      }
    }
    const shared = [...owners].filter(([, files]) => files.length > 1).map(([cls, files]) => `${cls}: ${files.join(", ")}`);
    expect(shared).toEqual([]);
  });
});
