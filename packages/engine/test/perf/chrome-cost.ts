// Performans measurement (not a test): CPU time of a project's Chrome (temp profile, mock keychain) with and without
// a screencast viewer, on a static and an animated page, headless or hidden-headful.
//   node test/perf/chrome-cost.ts <headless:true|false> <seconds>
// Prints one JSON line per scenario. Never touches the user's Chrome, profiles or live engine.
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserFrameMessage } from "@kokpit/shared";
import { Client, startEngine, stopEngine } from "../harness.ts";

const headless = process.argv[2] !== "false";
const seconds = Number(process.argv[3] ?? "10");
const KEY = randomBytes(32).toString("base64url");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PAGES: Record<string, string> = {
  "/static": "<!doctype html><title>static</title><h1>Static page</h1><p>Nothing moves here.</p>",
  "/animated":
    "<!doctype html><title>animated</title><style>@keyframes s{to{transform:rotate(360deg)}}div{width:200px;height:200px;background:#c33;animation:s 1s linear infinite}</style><div></div><p id=t></p><script>setInterval(()=>t.textContent=Date.now(),100)</script>",
};

/** CPU seconds (user+sys) of every process whose command line mentions `marker`. */
function cpuSeconds(marker: string): { cpu: number; procs: number; renderers: number; rssMb: number } {
  const out = execFileSync("ps", ["-ax", "-ww", "-o", "time=,rss=,pid=,command="], { encoding: "utf8" });
  let cpu = 0;
  let procs = 0;
  let renderers = 0;
  let rss = 0;
  for (const line of out.split("\n")) {
    if (!line.includes(marker)) continue;
    const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s+(\d+)\s+(\d+ .*)$/.exec(line);
    if (!m) continue;
    const [, d, h, mi, s, r, cmd] = m;
    cpu += Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(mi) * 60 + Number(s);
    rss += Number(r);
    procs++;
    if (cmd!.includes("--type=renderer")) renderers++;
  }
  return { cpu, procs, renderers, rssMb: Math.round(rss / 1024) };
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-perf-chrome-")));
const site = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(PAGES[req.url ?? ""] ?? "404");
});
await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
mkdirSync(join(root, "home"));
const configPath = join(root, "engine.json");
writeFileSync(
  configPath,
  JSON.stringify({
    dataDir: join(root, "data"),
    port: 0,
    shell: "/bin/sh",
    shellArgs: [],
    listenTailscale: false,
    browser: { testMode: true, headless, ...(process.argv[4] ? { screencastEveryNthFrame: Number(process.argv[4]) } : {}) },
  }),
);
const engine = await startEngine({ KOKPIT_CONFIG: configPath, KOKPIT_KEY: KEY, HOME: join(root, "home") });
try {
  const c = await Client.connect(engine.port, KEY);
  const projectId = "web-tasks";
  await c.req("browser.open", { projectId });
  let acking = false;
  const ackTimer = setInterval(() => {
    if (!acking) return;
    const last = c.frames.filter((f): f is BrowserFrameMessage => f.type === "browser.frame").at(-1);
    if (last) c.ws.send(JSON.stringify({ type: "browser.ack", projectId, frameId: last.frameId }));
  }, 10);
  const frameCount = () => c.frames.filter((f) => f.type === "browser.frame").length;
  for (const page of ["static", "animated"]) {
    await c.req("browser.navigate", { projectId, url: `${base}/${page}` });
    for (const viewer of [false, true]) {
      if (viewer) {
        acking = true;
        await c.req("browser.screencast.start", { projectId, maxWidth: 1280, maxHeight: 800, quality: 70 });
      }
      await sleep(2000);
      const a = cpuSeconds(root);
      const ea = cpuSeconds(`${engine.child.pid} `);
      const f0 = frameCount();
      await sleep(seconds * 1000);
      const b = cpuSeconds(root);
      const eb = cpuSeconds(`${engine.child.pid} `);
      const frames = frameCount() - f0;
      if (viewer) {
        await c.req("browser.screencast.stop", { projectId });
        acking = false;
      }
      console.log(
        JSON.stringify({
          headless,
          page,
          viewer,
          cpuPercent: Math.round(((b.cpu - a.cpu) / seconds) * 1000) / 10,
          engineCpuPercent: Math.round(((eb.cpu - ea.cpu) / seconds) * 1000) / 10,
          framesPerSecond: Math.round((frames / seconds) * 10) / 10,
          procs: b.procs,
          renderers: b.renderers,
          rssMb: b.rssMb,
        }),
      );
    }
  }
  clearInterval(ackTimer);
  await c.req("browser.close", { projectId }).catch(() => {});
  await c.close();
} finally {
  await stopEngine(engine);
  site.close();
  rmSync(root, { recursive: true, force: true });
}
