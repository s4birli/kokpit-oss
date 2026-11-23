// İş B: the `browser` block of the engine config. Values live in config.defaults.json (and the user's
// engine.json, merged key by key); config.ts validates them with this schema.
import { BROWSER_LIMITS, CLIPBOARD_LIMITS } from "@kokpit/shared";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_RETENTION_DAYS = 3650;
const MIN_SWEEP_INTERVAL_MS = 1000;
const MAX_SWEEP_ENTRIES = 1_000_000;
const MAX_WINDOW_PX = 10_000;
/** Chrome's compositor at ~60 Hz: beyond this a moving page would show about one frame a second. */
const MAX_EVERY_NTH_FRAME = 60;
const MAX_FRAME_WINDOW = 64;
const MIN_MAX_TABS = 20;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** One plain directory name: no separators, never "." or "..". */
const DirName = z
  .string()
  .regex(/^[A-Za-z0-9_][A-Za-z0-9._-]*$/, "expected a plain directory name")
  .refine((s) => s !== "." && s !== "..", "expected a plain directory name");
/** One path segment that may start with a dot (".claude"), never "." or "..". */
const PathSegment = z
  .string()
  .regex(/^[A-Za-z0-9._-]+$/, "expected a plain file or directory name")
  .max(255)
  .refine((s) => s !== "." && s !== "..", "expected a plain file or directory name");
const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "expected an environment variable name").max(200);
const int = (min: number, max: number) => z.number().int().min(min).max(max);

const BrowserFields = z
  .object({
    /** Chrome executable on the engine machine. */
    chromePath: z.string().min(1).refine((p) => p.startsWith("/"), "must be an absolute path"),
    /**
     * Test-only: every project's Chrome `--headless=new` with the mock keychain. In production a project's window
     * mode decides (`browser.window`: "hidden" = headless with the real keychain, "visible" = a real window).
     */
    headless: z.boolean(),
    /**
     * A hidden (headless) Chrome presents itself as the same Chrome with a window: its User-Agent without the
     * "Headless" token and its real client hints (brands, full versions, platform version, architecture, bitness),
     * all asked of the installed Chrome at runtime (browser-identity.ts). Headless Chrome's own User-Agent says
     * "HeadlessChrome", which sites (Google's sign-in among them) may treat as automation. false = keep it.
     */
    hiddenIdentity: z.boolean(),
    /**
     * Chrome's own page the identity probe reads `navigator.userAgentData` in (a secure context; no network). Only
     * chrome:// pages: the probe Chrome never loads a site.
     */
    identityProbeUrl: z
      .string()
      .max(200)
      .regex(/^chrome:\/\/[a-z0-9-]+\/?$/, "expected a chrome:// page"),
    /**
     * Before hiddenIdentity: a User-Agent template. Still accepted so older config files load; null still turns the
     * identity off, a template is no longer used (the User-Agent is Chrome's own).
     */
    hiddenUserAgent: z.string().min(1).max(512).nullable().optional(),
    /** `ps`, to tell a Chrome left by an earlier engine apart (its pid, whether it runs hidden). */
    psPath: z.string().min(1).refine((p) => p.startsWith("/"), "must be an absolute path"),
    /** `lsof`, to bind such a Chrome to the system: its executable and the DevTools port it really listens on. */
    lsofPath: z.string().min(1).refine((p) => p.startsWith("/"), "must be an absolute path"),
    /**
     * Test-only: `--use-mock-keychain --password-store=basic`, so a test Chrome never asks the macOS keychain
     * (which shows a system dialog). Production is false: Chrome runs with the engine user's real HOME and
     * keychain, so saved passwords and password-manager extensions in the profiles keep working.
     */
    testMode: z.boolean(),
    /** `<dataDir>/<profilesDirName>/<projectId>` = the project's Chrome profile. */
    profilesDirName: DirName,
    /** `<dataDir>/<workspaceDirName>` = folder of the built-in browser project. */
    workspaceDirName: DirName,
    /** Built-in project for browser work that belongs to no project. */
    projectId: z.string().max(200).regex(SLUG_RE, "expected a lowercase ascii slug"),
    projectName: z.string().trim().min(1),
    /** Chrome window size (= viewport the screencast shows). */
    windowWidth: int(1, MAX_WINDOW_PX),
    windowHeight: int(1, MAX_WINDOW_PX),
    /**
     * DevTools ports: each project prefers `cdpPortBase + hash(projectId) % cdpPortSpan` (stable, so terminals
     * opened before the browser already know KOKPIT_CDP_URL) and falls back to the next free one in the range.
     */
    cdpPortBase: int(1024, 65535),
    cdpPortSpan: int(1, 10_000),
    /** Max wait for a started Chrome to answer on its DevTools port. */
    startTimeoutMs: int(1, MAX_DURATION_MS),
    /** How often startup polls the DevTools endpoint. */
    pollIntervalMs: int(1, MAX_DURATION_MS),
    /** After Browser.close / SIGTERM, wait this long before SIGKILL. */
    stopGraceMs: int(0, MAX_DURATION_MS),
    /** Max time one CDP command may take. */
    cdpTimeoutMs: int(1, MAX_DURATION_MS),
    /** Frames a client may have unacknowledged before it is skipped. */
    frameWindow: int(1, MAX_FRAME_WINDOW),
    /**
     * Performans: the screencast sends every Nth of Chrome's compositor frames (~60 Hz): 2 = ~30 frames/s for an
     * animated page. Each frame is a JPEG encode in the project's Chrome, the relay and a decode in the app.
     */
    screencastEveryNthFrame: int(1, MAX_EVERY_NTH_FRAME),
    /** Larger frames are dropped (base64 characters). */
    maxFrameChars: int(1, BROWSER_LIMITS.maxFrameChars),
    /** Adım 7: most tabs `browser.newTab` lets a project's Chrome have (the tab strip handles at least 20). */
    maxTabs: int(MIN_MAX_TABS, BROWSER_LIMITS.maxTabs),
    /**
     * Local terminals of engine-browser projects: env names that also get KOKPIT_CDP_URL's value, and names that get
     * `<per-user temp dir>/<playwrightMcpOutputDirName>` — read by a Playwright MCP started without args (e.g. the
     * user's global plugin), so it drives the project's Chrome and keeps its files out of the repo.
     */
    playwrightMcpCdpEndpointEnv: z.array(EnvName).max(20),
    playwrightMcpOutputDirEnv: z.array(EnvName).max(20),
    playwrightMcpOutputDirName: DirName,
    /**
     * Adım 9 İş A: the Claude Code settings file inside a local project folder (path segments) whose `env` block gets
     * the same variables — the only route to Claude sessions that do not inherit the terminal's environment
     * (background agents run under the shared `claude daemon`). Per project: `claudeBrowserEnv`.
     */
    claudeSettingsPath: z.array(PathSegment).min(1).max(5),
    /**
     * Adım 9 İş T: a project's Playwright MCP output goes to `<parent>/<playwrightMcpOutputDirName>/<projectId>/`.
     * The parent is this absolute, normalized path, or — when the key is absent — the engine user's per-user temp
     * dir. Env KOKPIT_PLAYWRIGHT_MCP_OUTPUT_PARENT_DIR overrides it (tests keep every engine out of the real folder).
     */
    playwrightMcpOutputParentDir: z
      .string()
      .refine((p) => isAbsolute(p) && resolve(p) === p, "must be an absolute, normalized path")
      .optional(),
    /**
     * Files in that folder older than this many days (by mtime) are deleted at engine start and on every sweep.
     * Must be greater than 0; fractions are allowed. There is no "never delete" value on purpose.
     */
    playwrightMcpOutputRetentionDays: z
      .number()
      .gt(0, "0'dan büyük olmalı (bu kadar günden eski Playwright çıktıları silinir; \"hiç silme\" değeri yoktur)")
      .max(MAX_RETENTION_DAYS),
    /** How often the engine sweeps that folder after the sweep at startup. */
    playwrightMcpOutputSweepIntervalMs: int(MIN_SWEEP_INTERVAL_MS, MAX_DURATION_MS),
    /** Most directory entries one sweep looks at; a larger tree is finished over the following sweeps. */
    playwrightMcpOutputSweepMaxEntries: int(1, MAX_SWEEP_ENTRIES),
    /** A terminal whose command runs one of these programs (first word) starts the project's browser. [] = off. */
    startForCommands: z.array(z.string().regex(/^[A-Za-z0-9._+-]+$/, "expected a program name")).max(50),
    /**
     * Page zoom of a project's browser until the user chooses one (1 = 100 %). The page is laid out at the panel's
     * picture area ÷ zoom: at 0.67 a ~700–1100 px wide panel still gets a desktop-width page (≈1050–1650 px).
     */
    defaultZoom: z.number().min(BROWSER_LIMITS.minZoom).max(BROWSER_LIMITS.maxZoom),
    /** İş Z: after a zoom change, max wait for the page to repaint at the new size before the next frame. */
    zoomPaintWaitMs: int(0, MAX_DURATION_MS),
    /**
     * Longest the engine waits on one best-effort step of a tab switch or close that the PAGE answers (bring to front,
     * focus emulation, size, title watcher): a page that cannot answer — a JavaScript dialog open, scripts off — must
     * not hold the switch for the whole cdpTimeoutMs, and the clicks queued behind it. The step is then given up
     * (the switch goes on); Chrome may still apply it later.
     */
    tabStepTimeoutMs: int(1, MAX_DURATION_MS),
    /**
     * A screencast frame whose size is not the panel's (Chrome resized the page's view to its window, something
     * cleared the override) makes the engine apply the panel's size again — at most once per this interval…
     */
    viewportHealIntervalMs: int(0, MAX_DURATION_MS),
    /** …and at most this many times in a row without a right-sized frame in between (0 = never): an agent that
     *  deliberately sets another viewport is not fought forever. */
    viewportHealMaxTries: int(0, 100),
    /** Kopyalama: longest page selection `browser.copy` hands out and longest text `browser.paste` inserts (UTF-16 units). */
    clipboardMaxChars: int(1, CLIPBOARD_LIMITS.maxChars),
    /** Tab/URL changes within this window become one `browser.changed` event. */
    changeCoalesceMs: int(0, MAX_DURATION_MS),
  })
  .strict();
export const BrowserConfigSchema = BrowserFields
  .refine((c) => c.cdpPortBase + c.cdpPortSpan - 1 <= 65535, { message: "port range exceeds 65535", path: ["cdpPortSpan"] });
export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;

/** What a config file may say about the browser: any subset of the keys. */
export const BrowserFileSchema = BrowserFields.partial().strict();
