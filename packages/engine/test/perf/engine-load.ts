// Performans measurement (not a test): the engine's CPU and event-loop under a synthetic load — N terminals
// printing steadily, two clients attached to all of them — with a CPU profile written for the hot spots.
//   node test/perf/engine-load.ts <terminals> <seconds> <lines-per-second-per-terminal>
// Uses /bin/sh terminals in the built-in project of a temp engine; no real tool, browser or screen helper.
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, startEngine, stopEngine } from "../harness.ts";

const terminals = Number(process.argv[2] ?? "4");
const seconds = Number(process.argv[3] ?? "15");
const rate = Number(process.argv[4] ?? "200");
const KEY = randomBytes(32).toString("base64url");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cpuOf = (pid: number): number => {
  const t = execFileSync("ps", ["-o", "time=", "-p", String(pid)], { encoding: "utf8" }).trim();
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(t)!;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
};

const root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-perf-engine-")));
const profDir = join(root, "prof");
mkdirSync(join(root, "home"));
mkdirSync(profDir);
const configPath = join(root, "engine.json");
writeFileSync(configPath, JSON.stringify({ dataDir: join(root, "data"), port: 0, shell: "/bin/sh", shellArgs: [], listenTailscale: false }));
const engine = await startEngine({
  KOKPIT_CONFIG: configPath,
  KOKPIT_KEY: KEY,
  HOME: join(root, "home"),
  NODE_OPTIONS: `--cpu-prof --cpu-prof-dir=${profDir}`,
});
try {
  const a = await Client.connect(engine.port, KEY);
  const b = await Client.connect(engine.port, KEY);
  const { projects } = await a.req<{ projects: { id: string; builtin?: boolean }[] }>("projects.list", {});
  const projectId = projects.find((p) => p.builtin)?.id ?? projects[0]!.id;
  const sleepS = (1 / rate).toFixed(4);
  const loop = `i=0; while :; do i=$((i+1)); echo "satır $i $(date +%s) lorem ipsum dolor sit amet consectetur"; sleep ${sleepS}; done`;
  const ids: string[] = [];
  for (let i = 0; i < terminals; i++) {
    const { terminal } = await a.req<{ terminal: { id: string } }>("terminal.open", { projectId, cols: 120, rows: 40, command: loop });
    ids.push(terminal.id);
    await b.req("terminal.attach", { terminalId: terminal.id, cols: 120, rows: 40 });
  }
  await sleep(2000);
  const c0 = cpuOf(engine.child.pid!);
  const bytes0 = a.raw.reduce((n, s) => n + s.length, 0);
  // Event-loop lag as a client sees it: round trips of a cheap request.
  const lags: number[] = [];
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const t = performance.now();
    await a.req("projects.list", {});
    lags.push(performance.now() - t);
    await sleep(200);
  }
  const c1 = cpuOf(engine.child.pid!);
  const bytes1 = a.raw.reduce((n, s) => n + s.length, 0);
  lags.sort((x, y) => x - y);
  console.log(
    JSON.stringify({
      terminals,
      linesPerSecondEach: rate,
      engineCpuPercent: Math.round(((c1 - c0) / seconds) * 1000) / 10,
      kbPerSecondPerClient: Math.round((bytes1 - bytes0) / 1024 / seconds),
      rttMsP50: Math.round(lags[Math.floor(lags.length / 2)]! * 10) / 10,
      rttMsP95: Math.round(lags[Math.floor(lags.length * 0.95)]! * 10) / 10,
      rttMsMax: Math.round(lags.at(-1)! * 10) / 10,
    }),
  );
  for (const id of ids) await a.req("terminal.close", { terminalId: id }).catch(() => {});
  await a.close();
  await b.close();
} finally {
  await stopEngine(engine);
  // Hot spots: self time per function from the engine's CPU profile.
  const file = readdirSync(profDir).find((f) => f.endsWith(".cpuprofile"));
  if (file) {
    const prof = JSON.parse(readFileSync(join(profDir, file), "utf8")) as {
      nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[];
      samples: number[];
    };
    const byId = new Map(prof.nodes.map((n) => [n.id, n]));
    const self = new Map<string, number>();
    for (const s of prof.samples) {
      const n = byId.get(s)!;
      const key = `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.replace(/^.*\/(packages|node_modules)\//, "$1/")}:${n.callFrame.lineNumber + 1}`;
      self.set(key, (self.get(key) ?? 0) + 1);
    }
    const total = prof.samples.length;
    for (const [k, v] of [...self].sort((x, y) => y[1] - x[1]).slice(0, 15)) console.log(`${((v / total) * 100).toFixed(1).padStart(5)}%  ${k}`);
  }
  rmSync(root, { recursive: true, force: true });
}
