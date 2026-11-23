// A trace of what the app asked the engine about the Tarayıcı (browser.* requests: viewport, screencast, tabs…)
// and what came back, each with its wall-clock time — plus what the window looked like to the page when it
// changed (visibilityState, focus) and how many Tarayıcı canvases were mounted. A failed step's report
// (diagnostics.ts, `extra`) carries it, so "which size did the panel report, was its stream running, did the
// engine apply it" is answered from the report alone. Cheap: Playwright's own WebSocket events (no app code) and
// one small listener set in the page; screencast frames and acks are not recorded.
import type { Page } from "playwright";

const TRACE = {
  /** The window property the page-side recorder lives under. */
  global: "__kokpitBrowserTrace",
  canvas: ".kp-browser__canvas",
  /** Requests whose method starts with this are recorded (with their answers). */
  methodPrefix: "browser.",
  /** Events with this name are recorded. */
  events: ["browser.changed"],
  /** Requests not worth a line each. */
  skip: ["browser.ack"],
  /** Oldest entries are dropped beyond this. */
  maxEntries: 3_000,
  /** A recorded payload is cut to this many characters. */
  maxPayloadChars: 400,
} as const;

export interface BrowserTraceEntry {
  at: string;
  dir: "sent" | "answer" | "event" | "page" | "note";
  text: string;
}

/** Records the browser.* traffic of every socket the page opens from now on, and the page's visibility. */
export function startBrowserTrace(page: Page): { entries: BrowserTraceEntry[]; note: (text: string) => void; read: () => Promise<BrowserTraceEntry[]> } {
  const entries: BrowserTraceEntry[] = [];
  const push = (dir: BrowserTraceEntry["dir"], text: string): void => {
    entries.push({ at: new Date().toISOString(), dir, text: text.slice(0, TRACE.maxPayloadChars) });
    if (entries.length > TRACE.maxEntries) entries.shift();
  };
  /** Request ids of recorded requests, so their answers are recorded too. */
  const ids = new Map<number, string>();
  page.on("websocket", (ws) => {
    push("note", `socket opened ${ws.url().replace(/\?.*$/, "")}`);
    ws.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") return;
      try {
        const msg = JSON.parse(payload) as { id?: number; method?: string; params?: unknown };
        if (!msg.method?.startsWith(TRACE.methodPrefix) || (TRACE.skip as readonly string[]).includes(msg.method)) return;
        if (typeof msg.id === "number") ids.set(msg.id, msg.method);
        push("sent", `#${msg.id} ${msg.method} ${JSON.stringify(msg.params)}`);
      } catch {
        /* not JSON */
      }
    });
    ws.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      try {
        const msg = JSON.parse(payload) as { id?: number; event?: string; name?: string; result?: unknown; error?: unknown };
        if (typeof msg.id === "number" && ids.has(msg.id)) {
          const method = ids.get(msg.id);
          ids.delete(msg.id);
          push("answer", `#${msg.id} ${method} ${JSON.stringify(msg.error ?? msg.result)}`);
          return;
        }
        const name = msg.name ?? msg.event;
        if (name && (TRACE.events as readonly string[]).includes(name)) push("event", payload);
      } catch {
        /* not JSON */
      }
    });
    ws.on("close", () => push("note", "socket closed"));
  });
  const read = async (): Promise<BrowserTraceEntry[]> => {
    const fromPage = await page
      .evaluate((g) => (window as unknown as Record<string, { entries: BrowserTraceEntry[] } | undefined>)[g]?.entries ?? [], TRACE.global)
      .catch(() => [] as BrowserTraceEntry[]);
    return [...entries, ...fromPage].sort((a, b) => a.at.localeCompare(b.at));
  };
  return { entries, note: (text) => push("note", text), read };
}

/** A second DevTools client's probe answers within this, or the probe says it did not. */
const PROBE_TIMEOUT_MS = 1_000;
/** The whole probe of one Chrome. */
const PROBE_BUDGET_MS = 10_000;
/** How long a fresh tab gets to load the probe page. */
const FRESH_TAB_WAIT_MS = 2_000;

/**
 * For a failure report: does the project's Chrome answer a second DevTools client (not the engine's connection),
 * and what does its page say — address, title, visibility, size, and whether it still paints (one animation
 * frame) — plus each Chrome process's CPU time over a second and, with `freshUrl`, whether a new tab of its own still
 * loads a page. Tells "Chrome / the page is stuck" from "the engine's queue is stuck". Never throws.
 */
export async function chromeProbe(devtoolsPort: number, freshUrl?: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  let ws: WebSocket | undefined;
  // What was learnt by the deadline (a report has a budget of its own; see diagnostics.ts).
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      out.cutShort = `probe stopped after ${PROBE_BUDGET_MS} ms`;
      resolve();
    }, PROBE_BUDGET_MS);
  });
  await Promise.race([probe(), deadline]);
  clearTimeout(timer);
  ws?.close();
  return { ...out };

  async function probe(): Promise<void> {
    try {
      const base = `http://127.0.0.1:${devtoolsPort}`;
      const version = (await (await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })).json()) as { webSocketDebuggerUrl: string };
      const list = (await (await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })).json()) as { id: string; type: string; url: string; title: string }[];
      out.pages = list.filter((t) => t.type === "page").map((t) => `${t.id} ${t.url} ${t.title}`);
      const socket = new WebSocket(version.webSocketDebuggerUrl);
      ws = socket;
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve());
        socket.addEventListener("error", () => reject(new Error("devtools socket failed")));
      });
      let seq = 0;
      const call = (method: string, params: Record<string, unknown>, sessionId?: string): Promise<unknown> =>
        new Promise((resolve, reject) => {
          const id = ++seq;
          const timer = setTimeout(() => reject(new Error(`no answer in ${PROBE_TIMEOUT_MS} ms`)), PROBE_TIMEOUT_MS);
          const onMessage = (ev: MessageEvent) => {
            const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string } };
            if (msg.id !== id) return;
            clearTimeout(timer);
            socket.removeEventListener("message", onMessage);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
          };
          socket.addEventListener("message", onMessage);
          socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
      const timed = async (name: string, f: () => Promise<unknown>): Promise<void> => {
        const t0 = Date.now();
        try {
          const value = await f();
          out[name] = { ms: Date.now() - t0, value };
        } catch (err) {
          out[name] = { ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err) };
        }
      };
      await timed("browserVersion", () => call("Browser.getVersion", {}));
      // CPU time per Chrome process, twice: which of them still work (a hung renderer's does not move).
      await timed("processes", async () => {
        type Info = { processInfo: { type: string; id: number; cpuTime: number }[] };
        const a = (await call("SystemInfo.getProcessInfo", {})) as Info;
        await new Promise((r) => setTimeout(r, PROBE_TIMEOUT_MS));
        const b = (await call("SystemInfo.getProcessInfo", {})) as Info;
        return b.processInfo.map((p) => `${p.type} ${p.id} cpu ${p.cpuTime.toFixed(2)}s (+${(p.cpuTime - (a.processInfo.find((q) => q.id === p.id)?.cpuTime ?? 0)).toFixed(3)})`);
      });
      if (freshUrl) {
        // Can this Chrome still load a page at all, in a new tab of its own? (Closed again afterwards.)
        await timed("freshTab", async () => {
          const { targetId } = (await call("Target.createTarget", { url: freshUrl, background: true })) as { targetId: string };
          await new Promise((r) => setTimeout(r, FRESH_TAB_WAIT_MS));
          const { targetInfos } = (await call("Target.getTargets", {})) as { targetInfos: { targetId: string; url: string; title: string }[] };
          const info = targetInfos.find((t) => t.targetId === targetId);
          await call("Target.closeTarget", { targetId }).catch(() => {});
          return info ? `${info.url} — ${info.title}` : "(gone)";
        });
      }
      const pageId = list.find((t) => t.type === "page")?.id;
      if (pageId) {
        const { sessionId } = (await call("Target.attachToTarget", { targetId: pageId, flatten: true })) as { sessionId: string };
        const expression = "[location.href, document.title, document.visibilityState, innerWidth, innerHeight, document.readyState]";
        await timed("evaluate", () => call("Runtime.evaluate", { expression, returnByValue: true }, sessionId));
        await timed("animationFrame", () =>
          call("Runtime.evaluate", { expression: "new Promise((r) => requestAnimationFrame(() => r('painted')))", awaitPromise: true, returnByValue: true }, sessionId),
        );
      }
    } catch (err) {
      out.error = err instanceof Error ? err.message : String(err);
    } finally {
      ws?.close();
    }
  }
}

/** Starts the page-side half: visibility / focus changes and the number of mounted Tarayıcı canvases. Idempotent. */
export async function watchBrowserPage(page: Page): Promise<void> {
  await page.evaluate((sel) => {
    const w = window as unknown as Record<string, { entries: unknown[] } | undefined>;
    if (w[sel.global]) return;
    const entries: unknown[] = [];
    w[sel.global] = { entries };
    let canvases = -1;
    const push = (why: string): void => {
      canvases = document.querySelectorAll(sel.canvas).length;
      entries.push({ at: new Date().toISOString(), dir: "page", text: `${why}: visibility ${document.visibilityState}, focus ${document.hasFocus()}, canvases ${canvases}` });
      if (entries.length > sel.maxEntries) entries.shift();
    };
    for (const name of ["focus", "blur"]) window.addEventListener(name, () => push(name));
    document.addEventListener("visibilitychange", () => push("visibilitychange"));
    new MutationObserver(() => {
      if (document.querySelectorAll(sel.canvas).length !== canvases) push("canvases changed");
    }).observe(document.body, { childList: true, subtree: true });
    push("trace started");
  }, TRACE);
}
