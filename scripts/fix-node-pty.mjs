// npm/pnpm can drop the exec bit on node-pty's prebuilt spawn-helper, which makes
// every pty.spawn fail with "posix_spawnp failed". Restore it after install.
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(join(process.cwd(), "packages/engine/package.json"));
let root;
try {
  root = dirname(require.resolve("node-pty/package.json"));
} catch {
  process.exit(0);
}
for (const dir of ["prebuilds", "build/Release"]) {
  const base = join(root, dir);
  if (!existsSync(base)) continue;
  const stack = [base];
  while (stack.length) {
    const d = stack.pop();
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === "spawn-helper") chmodSync(p, 0o755);
    }
  }
}
