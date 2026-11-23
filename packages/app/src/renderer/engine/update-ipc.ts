// Kendini güncelleme: contract between the renderer, the preload and Electron main. The updater lives in main (its
// own connection to the engine, the download, the swap); the page only shows its state and passes the user's wishes.
import type { BuildInfo, Compat } from "@kokpit/shared";

export const UPDATE_IPC = {
  status: "update:status",
  changed: "update:changed",
  check: "update:check",
  download: "update:download",
  apply: "update:apply",
  setAuto: "update:setAuto",
  rendererReady: "update:rendererReady",
  moveToApplications: "update:moveToApplications",
  dismiss: "update:dismiss",
  confirmDowngrade: "update:confirmDowngrade",
  resetFloor: "update:resetFloor",
} as const;

export type UpdatePhase =
  /** Not a packaged app (development, tests from source): nothing is checked or installed. */
  | "disabled"
  | "idle"
  | "checking"
  /** A newer build is published; automatic updates are off, so it waits for the user. */
  | "available"
  | "downloading"
  | "verifying"
  /** Downloaded, verified and unpacked next to the app; a restart installs it. */
  | "ready"
  /** The app is about to quit for the swap. */
  | "applying"
  /** An update exists but cannot be installed here; `message` says why. */
  | "blocked"
  | "error";

export type UpdateBlockReason =
  | "translocated"
  | "read-only"
  | "no-write"
  | "disk-space"
  | "other-instance"
  | "bad-build"
  /** The staging folder is a link, someone else's, or open to others: nothing is written into it. */
  | "unsafe-staging"
  /** The engine is reached over a transport that does not protect an update (not loopback, Tailscale or TLS). */
  | "transport"
  /** The update is not signed by the publisher key this app carries (or this app carries none). */
  | "unsigned"
  /** The published build is dated in the future (later than its own createdAt, or far later than this Mac's clock). */
  | "bad-stamp";

export interface UpdateStatus {
  phase: UpdatePhase;
  /** This app's build. */
  app: BuildInfo;
  /** The engine's build as of the last check; null before the first answer. `build` absent = an engine without one. */
  engine: { version?: string; build?: BuildInfo; protocol?: number } | null;
  compat: Compat | "unknown";
  /** Download and install by itself (default) or only tell that an update exists. */
  auto: boolean;
  /**
   * The build being offered / downloaded / ready. `downgrade`: it is older than the newest build ever installed
   * here — only the dedicated "Eski sürüme dön" action (`confirmDowngrade`) lets it through.
   */
  target?: { buildId: string; version: string; downgrade?: boolean; builtAt?: string };
  progress?: { received: number; total: number };
  blocked?: UpdateBlockReason;
  /** Turkish, for the user. */
  message?: string;
  /** What became of the last update on this machine, until dismissed. */
  last?: { outcome: "updated" | "rolledBack" | "failed"; buildId: string; detail?: string };
  /** ISO time of the last completed check. */
  checkedAt?: string;
}

/** Exposed as `window.kokpit.update`. */
export interface UpdateBridge {
  status(): Promise<UpdateStatus>;
  onStatus(listener: (status: UpdateStatus) => void): () => void;
  /** Ask the engine now (the window calls this when its own connection comes up). */
  check(): Promise<void>;
  /** With automatic updates off: fetch the offered build. */
  download(): Promise<void>;
  /** Restart into the ready build — the user's consent. */
  apply(): Promise<void>;
  setAuto(on: boolean): Promise<void>;
  /** The page has rendered: the health signal of a freshly installed build. */
  rendererReady(): Promise<void>;
  /** Offered when the app runs from a place it cannot update itself in. */
  moveToApplications(): Promise<void>;
  /** Hides the "last update" notice. */
  dismiss(): Promise<void>;
  /** "Eski sürüme dön": confirms exactly the older build on offer (separate from checking for updates). */
  confirmDowngrade(buildId: string): Promise<void>;
  /** Ayarlar, after the user confirmed: the rollback floor goes back to the running build. */
  resetFloor(): Promise<void>;
}

const PHASES: readonly UpdatePhase[] = ["disabled", "idle", "checking", "available", "downloading", "verifying", "ready", "applying", "blocked", "error"];
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Shape check of what crosses the bridge; null for anything that is not a status. */
export function parseUpdateStatus(raw: unknown): UpdateStatus | null {
  if (!isRecord(raw) || !PHASES.includes(raw.phase as UpdatePhase) || !isRecord(raw.app) || typeof raw.app.buildId !== "string") return null;
  return raw as unknown as UpdateStatus;
}
