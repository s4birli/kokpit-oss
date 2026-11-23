// Yollar — `open` in a Kokpit terminal. When a program in a project's terminal runs `open <http(s) address>` or
// `open <page.html>`, the page belongs in the project's Kokpit browser, not in the desktop browser of the engine
// Mac (which nobody may be looking at). A small `open` shim (wrappers/bin/open) sits first on PATH in Kokpit
// terminals; it handles exactly those two cases and hands everything else to the real `open`.
//
// The shim never gets the engine's access key. Every terminal gets its own random HMAC key, bound to the terminal's
// project (and card); it dies with the terminal, with the project, after `grantMaxAgeMs`, and with the engine (kept
// in memory only). The terminal's environment holds that key (pre-padded: the two halves ARE the key — any process
// that can read the environment can sign requests); its scope is what limits it — this one route, for this one
// project. It is good for one thing: `POST /terminal/open` on the engine's own listener, from this machine
// only, which shows an http(s) address or an existing .html/.htm file in that project's browser. It cannot name
// another project, another scheme or an application.
//
// The key never travels (nor appears on any command line): the shim sends the grant's public id, a timestamp,
// a fresh nonce and HMAC-SHA256(key, "kokpit-open-v1" ‖ id ‖ time ‖ nonce ‖ kind ‖ target). The engine accepts it
// only within `clockSkewS` of its own clock and only once per nonce (replay cache), and answers with
// HMAC(key, "kokpit-open-reply-v1" ‖ nonce ‖ status): the shim counts a request as done only when that reply proves
// it came from the engine that holds the key — a program squatting on the engine's port gets nothing usable and
// cannot make the shim believe it. The shim computes HMAC with the pre-padded key halves it is given (ipad/opad)
// and `shasum` on stdin, so no secret is ever an argument of a process.
//
// PATH: a login zsh reorders PATH (macOS `path_helper` puts /usr/bin first), so setting PATH in the environment is
// not enough. For zsh the terminal starts with ZDOTDIR pointing at wrappers/zsh, whose `.zshenv` puts ZDOTDIR back
// to the user's, reads the user's own `.zshenv`, and puts the shim directory first on PATH once, at the first
// prompt — after every rc file ran. For `sh` the same is done through `ENV`. Other shells only get the PATH entry.
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type http from "node:http";
import { basename, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { createRateLimiter, isWebPagePath, PATH_LIMITS, webLinkUrl, type Card, type Project } from "@kokpit/shared";
import { st } from "@kokpit/shared/i18n";
import { EngineError, type ErrorText, type Logger } from "./contracts.ts";
import { isLoopbackAddress, urlHost } from "./net.ts";

const posInt = z.number().int().positive();
const absPath = z.string().min(1).refine(isAbsolute, "mutlak bir yol olmalı");

export const OpenConfigSchema = z
  .object({
    /** The global switch: false = no terminal gets the shim. */
    enabled: z.boolean(),
    /** The operating system's `open`: what the shim runs for everything it does not handle. */
    realOpenPath: absPath,
    /**
     * When the engine cannot show an address/page the shim handles (unreachable, refused): false (default) = say so
     * and stop — the engine Mac's desktop browser is not opened on its screen; true = run the real `open` with it.
     */
    fallbackToSystemOpen: z.boolean(),
    curlPath: absPath,
    /** Tools the shim computes its HMAC and nonce with (stdin only: no secret on a command line). */
    xxdPath: absPath,
    shasumPath: absPath,
    odPath: absPath,
    datePath: absPath,
    /** A request's timestamp may be this far from the engine's clock. */
    clockSkewS: z.number().int().min(1).max(600),
    /** Bytes of a terminal's HMAC key (at most a SHA-256 block: the shim is given it pre-padded). */
    grantBytes: z.number().int().min(24).max(64),
    grantMaxAgeMs: posInt,
    /** How long the shim waits for the engine before it falls back to the real `open`. */
    requestTimeoutS: z.number().int().min(1).max(120),
    maxBodyBytes: z.number().int().min(256).max(1048576),
    /** Opens one terminal may ask for: `max` per `windowMs`. */
    rate: z.object({ max: posInt, windowMs: posInt }).strict(),
    /** In the engine's own folder (or absolute): the directory that holds the `open` shim and nothing else… */
    shimDir: z.string().min(1),
    /** …the directory whose `.zshenv` a Kokpit terminal's zsh reads first… */
    zshDir: z.string().min(1),
    /** …and the file an interactive `sh` reads at start. */
    shEnvFile: z.string().min(1),
  })
  .strict();
export type OpenConfig = z.infer<typeof OpenConfigSchema>;

/**
 * The engine does not take this `open` on purpose (the project's open is not for Kokpit): the shim runs the real
 * `open` — the user's choice — whatever `fallbackToSystemOpen` says. Answered as 303 with the engine's proof.
 */
export class OpenDeclinedError extends EngineError {
  constructor(message: string, text?: ErrorText) {
    super("INVALID", message, text);
  }
}
const DECLINED_STATUS = 303;

/** The one route of the shim on the engine's listener. */
export const TERMINAL_OPEN_HTTP_PATH = "/terminal/open";
/**
 * How many nonces one terminal must remember: every request that can be accepted while a timestamp is still inside
 * its window (2 × `clockSkewS`), at the rate limit — plus one window of slack for the limiter's boundary.
 */
export function replayCapacity(cfg: Pick<OpenConfig, "clockSkewS" | "rate">): number {
  return Math.ceil((2 * cfg.clockSkewS * 1000) / cfg.rate.windowMs) * cfg.rate.max + cfg.rate.max;
}

/** Environment of a terminal with the shim (read by wrappers/bin/open, wrappers/zsh/.zshenv, wrappers/sh-env.sh). */
export const OPEN_ENV = {
  endpoint: "KOKPIT_OPEN_ENDPOINT",
  /** The grant's public id. */
  id: "KOKPIT_OPEN_ID",
  /** The HMAC key, pre-padded: (key ‖ 0…) XOR 0x36 and XOR 0x5c, hex — the key itself is never handed out. */
  ipad: "KOKPIT_OPEN_KEY_IPAD",
  opad: "KOKPIT_OPEN_KEY_OPAD",
  xxd: "KOKPIT_OPEN_XXD",
  shasum: "KOKPIT_OPEN_SHASUM",
  od: "KOKPIT_OPEN_OD",
  date: "KOKPIT_OPEN_DATE",
  real: "KOKPIT_OPEN_REAL",
  /** "1" = a failed address/page goes to the real `open` (fallbackToSystemOpen); else the shim stops there. */
  fallback: "KOKPIT_OPEN_FALLBACK",
  curl: "KOKPIT_OPEN_CURL",
  timeout: "KOKPIT_OPEN_TIMEOUT_S",
  shimDir: "KOKPIT_SHIM_DIR",
  userZdotdir: "KOKPIT_USER_ZDOTDIR",
} as const;
const KINDS = ["url", "file"] as const;
type Kind = (typeof KINDS)[number];

export interface OpenGrant {
  /** Names the grant in logs; not a secret. */
  id: string;
  projectId: string;
  cardId?: string | undefined;
}

/** What the engine does for a shim request; each throws an EngineError whose message is for the terminal's user. */
export interface OpenActions {
  /** Shows an (already checked) http(s) address in the project's browser. */
  url(grant: OpenGrant, url: string): Promise<void>;
  /** Shows a local page (absolute path) in the project's browser. */
  file(grant: OpenGrant, path: string): Promise<void>;
}

export interface TerminalOpenService {
  /**
   * The environment (and its cleanup) of a new local terminal of `project`; undefined when the shim is off — in the
   * config, for this project, for where its browser or its terminal runs — or the engine listens nowhere yet.
   */
  prepare(project: Project, card?: Card): { env: Record<string, string>; release(): void } | undefined;
  revokeProject(projectId: string): void;
  /** Handles `POST /terminal/open`; false for any other path. */
  handleHttp(req: http.IncomingMessage, res: http.ServerResponse, actions: OpenActions): boolean;
  stats(): { grants: number };
  shutdown(): void;
}

export interface TerminalOpenDeps {
  config: OpenConfig;
  /** The engine's own folder: `shimDir`, `zshDir` and `shEnvFile` of the config are resolved in it. */
  engineDir: string;
  /** The terminals' shell (config `shell`). */
  shell: string;
  /** ZDOTDIR the user's terminals get without the shim (config `terminalZdotdir`); undefined = the home directory. */
  userZdotdir?: string | undefined;
  /** The engine's own environment (PATH, ENV). */
  env: NodeJS.ProcessEnv;
  /** Where a program on this machine reaches the engine. */
  endpoint(): { host: string; port: number } | undefined;
  logger: Logger;
  now?: () => number;
}

interface Entry extends OpenGrant {
  key: Buffer;
  expiresAt: number;
  limiter: { allow(): boolean };
  /** Nonces already used (insertion order = age) → when they may be forgotten. */
  seen: Map<string, number>;
}

/** HMAC block size of SHA-256. */
const BLOCK_BYTES = 64;
const REQUEST_TAG = "kokpit-open-v1";
const REPLY_TAG = "kokpit-open-reply-v1";
const NONCE_RE = /^[0-9a-f]{32}$/;
const MAC_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^[0-9a-f-]{36}$/;
const TS_RE = /^[0-9]{1,12}$/;

/** The text a request's MAC covers. */
export function openRequestText(id: string, ts: string, nonce: string, kind: string, target: string): string {
  return `${REQUEST_TAG}\n${id}\n${ts}\n${nonce}\n${kind}\n${target}`;
}
/** The text a reply's MAC covers. */
export function openReplyText(nonce: string, status: number): string {
  return `${REPLY_TAG}\n${nonce}\n${status}`;
}
export const openMac = (key: Buffer, text: string): string => createHmac("sha256", key).update(text, "utf8").digest("hex");

/** The key's two padded halves the shim computes HMAC with. */
function paddedHalves(key: Buffer): { ipad: string; opad: string } {
  const block = Buffer.alloc(BLOCK_BYTES);
  key.copy(block);
  return { ipad: Buffer.from(block.map((b) => b ^ 0x36)).toString("hex"), opad: Buffer.from(block.map((b) => b ^ 0x5c)).toString("hex") };
}

const macEqual = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** i18n: the shim's answers, in the engine's language when they are sent (each property is read at use). */
const MESSAGES = {
  get forbidden() {
    return st("engine.terminalOpen.forbidden");
  },
  get unauthorized() {
    return st("engine.terminalOpen.unauthorized");
  },
  get stale() {
    return st("engine.terminalOpen.stale");
  },
  get malformed() {
    return st("engine.terminalOpen.malformed");
  },
  get rate() {
    return st("engine.terminalOpen.rate");
  },
  get notWeb() {
    return st("engine.terminalOpen.notWeb");
  },
  get failed() {
    return st("engine.terminalOpen.failed");
  },
};

/** Whether the shim may be given to terminals of `project` at all (its browser and its terminals run here). */
export function projectUsesOpenShim(project: Project): boolean {
  if (project.openInBrowser === false) return false;
  if (project.location.kind === "ssh") return false;
  return project.browser?.runOn !== "client";
}

export function createTerminalOpen(deps: TerminalOpenDeps): TerminalOpenService {
  const { config: cfg, logger } = deps;
  const now = deps.now ?? Date.now;
  const byId = new Map<string, Entry>();
  const shimDir = resolve(deps.engineDir, cfg.shimDir);
  const zshDir = resolve(deps.engineDir, cfg.zshDir);
  const shEnvFile = resolve(deps.engineDir, cfg.shEnvFile);

  function live(entry: Entry | undefined): Entry | undefined {
    if (!entry) return undefined;
    if (now() < entry.expiresAt) return entry;
    byId.delete(entry.id);
    return undefined;
  }

  /** First line: the reply's MAC (or "-" when the request named no live grant), then the message. */
  function answer(res: http.ServerResponse, status: number, message: string, mac = "-"): void {
    const body = Buffer.from(`${mac}\n${message.replace(/[\r\n]+/g, " ")}\n`, "utf8");
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "content-length": body.length, "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(body);
  }

  /** From this machine: loopback, or one of the engine's own addresses talking to itself. */
  function isLocal(req: http.IncomingMessage): boolean {
    const remote = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    const local = (req.socket.localAddress ?? "").replace(/^::ffff:/, "");
    return remote !== "" && (isLoopbackAddress(remote) || remote === local);
  }

  /** `<id>\n<ts>\n<nonce>\n<mac>\n<kind>\n<target>` → its parts; undefined when it is not that. */
  function parseBody(body: string): { id: string; ts: string; nonce: string; mac: string; kind: Kind; target: string } | undefined {
    const parts: string[] = [];
    let at = 0;
    for (let i = 0; i < 5; i++) {
      const nl = body.indexOf("\n", at);
      if (nl < 0) return undefined;
      parts.push(body.slice(at, nl));
      at = nl + 1;
    }
    const [id, ts, nonce, mac, kindText] = parts as [string, string, string, string, string];
    const kind = KINDS.find((k) => k === kindText);
    const target = body.slice(at);
    if (!ID_RE.test(id) || !TS_RE.test(ts) || !NONCE_RE.test(nonce) || !MAC_RE.test(mac)) return undefined;
    if (!kind || target === "" || target.length > PATH_LIMITS.maxPathChars * 2 || target.includes("\0")) return undefined;
    return { id, ts, nonce, mac, kind, target };
  }

  const capacity = replayCapacity(cfg);
  /**
   * Remembers the nonce of an ACCEPTED request until its timestamp could no longer pass (2 × skew), forgetting the
   * expired ones first. The rate limit bounds how many can be accepted in that span (`replayCapacity`), so a nonce
   * still inside its window is never pushed out; the cap is only a backstop.
   */
  function remember(entry: Entry, nonce: string): void {
    const t = now();
    for (const [n, until] of entry.seen) {
      if (until > t) break;
      entry.seen.delete(n);
    }
    entry.seen.set(nonce, t + 2 * cfg.clockSkewS * 1000);
    while (entry.seen.size > capacity) entry.seen.delete(entry.seen.keys().next().value!);
  }

  async function handle(body: string, actions: OpenActions): Promise<{ status: number; message: string; mac?: string }> {
    const parsed = parseBody(body);
    if (!parsed) return { status: 400, message: MESSAGES.malformed };
    const grant = live(byId.get(parsed.id));
    if (!grant) return { status: 401, message: MESSAGES.unauthorized };
    // The key is known from here on; anything signed with it is answered with a reply only it can produce — except
    // a forged request, which gets no proof (it never had the key).
    const expected = openMac(grant.key, openRequestText(parsed.id, parsed.ts, parsed.nonce, parsed.kind, parsed.target));
    if (!macEqual(expected, parsed.mac)) return { status: 401, message: MESSAGES.unauthorized };
    const reply = (status: number, message: string) => ({ status, message, mac: openMac(grant.key, openReplyText(parsed.nonce, status)) });
    if (Math.abs(Number(parsed.ts) * 1000 - now()) > cfg.clockSkewS * 1000 || grant.seen.has(parsed.nonce)) return reply(401, MESSAGES.stale);
    if (!grant.limiter.allow()) return reply(429, MESSAGES.rate);
    remember(grant, parsed.nonce);
    // The terminal may have closed (or its project gone) since the lookup: checked again right before acting.
    if (!live(byId.get(grant.id))) return reply(401, MESSAGES.unauthorized);
    try {
      if (parsed.kind === "url") {
        const url = webLinkUrl(parsed.target);
        if (url === null) return reply(422, MESSAGES.notWeb);
        await actions.url(grant, url);
      } else {
        // The shim sends an absolute path of an existing page; nothing else is a page here either.
        if (!isAbsolute(parsed.target) || !isWebPagePath(parsed.target)) return reply(422, MESSAGES.notWeb);
        await actions.file(grant, parsed.target);
      }
    } catch (err) {
      if (err instanceof OpenDeclinedError) return reply(DECLINED_STATUS, err.message);
      if (err instanceof EngineError) return reply(err.code === "NOT_FOUND" ? 404 : 409, err.message);
      logger.error("terminal open failed", { projectId: grant.projectId, kind: parsed.kind, err: err instanceof Error ? err.message : String(err) });
      return reply(500, MESSAGES.failed);
    }
    logger.info("terminal open handled", { projectId: grant.projectId, grantId: grant.id, kind: parsed.kind });
    return reply(200, "ok");
  }

  return {
    prepare(project, card) {
      if (!cfg.enabled || !projectUsesOpenShim(project)) return undefined;
      const address = deps.endpoint();
      if (!address) return undefined;
      const key = randomBytes(cfg.grantBytes);
      const entry: Entry = {
        id: randomUUID(),
        projectId: project.id,
        ...(card ? { cardId: card.id } : {}),
        key,
        expiresAt: now() + cfg.grantMaxAgeMs,
        limiter: createRateLimiter({ ...cfg.rate, now }),
        seen: new Map(),
      };
      byId.set(entry.id, entry);
      const halves = paddedHalves(key);
      const path = deps.env.PATH ?? "";
      const env: Record<string, string> = {
        [OPEN_ENV.endpoint]: `http://${urlHost(address.host)}:${address.port}${TERMINAL_OPEN_HTTP_PATH}`,
        [OPEN_ENV.id]: entry.id,
        [OPEN_ENV.ipad]: halves.ipad,
        [OPEN_ENV.opad]: halves.opad,
        [OPEN_ENV.real]: cfg.realOpenPath,
        [OPEN_ENV.fallback]: cfg.fallbackToSystemOpen ? "1" : "0",
        [OPEN_ENV.curl]: cfg.curlPath,
        [OPEN_ENV.xxd]: cfg.xxdPath,
        [OPEN_ENV.shasum]: cfg.shasumPath,
        [OPEN_ENV.od]: cfg.odPath,
        [OPEN_ENV.date]: cfg.datePath,
        [OPEN_ENV.timeout]: String(cfg.requestTimeoutS),
        [OPEN_ENV.shimDir]: shimDir,
        PATH: path === "" ? shimDir : `${shimDir}:${path}`,
      };
      const shell = basename(deps.shell);
      if (shell === "zsh") {
        env.ZDOTDIR = zshDir;
        env[OPEN_ENV.userZdotdir] = deps.userZdotdir ?? "";
      } else if (shell === "sh" && deps.env.ENV === undefined) {
        env.ENV = shEnvFile;
      }
      logger.info("terminal open grant issued", { grantId: entry.id, projectId: project.id });
      return {
        env,
        release: () => {
          if (byId.delete(entry.id)) logger.info("terminal open grant ended", { grantId: entry.id, projectId: entry.projectId });
        },
      };
    },

    revokeProject(projectId) {
      for (const [id, entry] of byId) if (entry.projectId === projectId) byId.delete(id);
    },

    handleHttp(req, res, actions) {
      const raw = req.url ?? "";
      if (raw !== TERMINAL_OPEN_HTTP_PATH && !raw.startsWith(`${TERMINAL_OPEN_HTTP_PATH}?`) && !raw.startsWith(`${TERMINAL_OPEN_HTTP_PATH}/`)) return false;
      if (req.method !== "POST" || raw !== TERMINAL_OPEN_HTTP_PATH) {
        res.setHeader("allow", "POST");
        answer(res, req.method === "POST" ? 404 : 405, MESSAGES.malformed);
        return true;
      }
      // A web page (any browser sends Origin with a POST) or another machine is never the shim.
      if (!isLocal(req) || req.headers.origin !== undefined || req.headers["sec-fetch-site"] !== undefined) {
        logger.warn("terminal open refused", { reason: isLocal(req) ? "browser request" : "not local" });
        answer(res, 403, MESSAGES.forbidden);
        return true;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      req.on("data", (chunk: Buffer) => {
        if (done) return;
        size += chunk.length;
        if (size > cfg.maxBodyBytes) {
          done = true;
          answer(res, 413, MESSAGES.malformed);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("error", () => {
        done = true;
      });
      req.on("end", () => {
        if (done) return;
        done = true;
        let body: string;
        try {
          body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
        } catch {
          answer(res, 400, MESSAGES.malformed);
          return;
        }
        void handle(body, actions).then(({ status, message, mac }) => answer(res, status, message, mac));
      });
      return true;
    },

    stats: () => ({ grants: byId.size }),

    shutdown() {
      byId.clear();
    },
  };
}
