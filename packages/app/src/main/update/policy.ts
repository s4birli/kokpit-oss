// Kendini güncelleme: the rules that need no I/O — which phase may follow which, and when a ready update may
// restart the app without asking.
import type { UpdatePhase } from "../../renderer/engine/update-ipc.ts";

/**
 * idle → checking → idle | available | downloading | blocked | error
 * available → checking (the user asked for it)        downloading → verifying → ready | error
 * ready → applying → (the app quits; the next launch reports updated / rolled back) | ready (swap not started)
 */
const NEXT: Record<UpdatePhase, readonly UpdatePhase[]> = {
  disabled: [],
  idle: ["checking", "ready"],
  checking: ["idle", "available", "downloading", "ready", "blocked", "error"],
  available: ["checking"],
  downloading: ["verifying", "error", "blocked"],
  verifying: ["ready", "error", "blocked"],
  ready: ["applying", "checking", "idle"],
  applying: ["ready", "error"],
  blocked: ["checking"],
  error: ["checking"],
};

export function canTransition(from: UpdatePhase, to: UpdatePhase): boolean {
  return NEXT[from].includes(to);
}

/** Phases in which a check, a download or a swap is under way: nothing else starts. */
export function isBusy(phase: UpdatePhase): boolean {
  return phase === "checking" || phase === "downloading" || phase === "verifying" || phase === "applying";
}

export interface AutoApplyInput {
  phase: UpdatePhase;
  /** Automatic updates are on. */
  auto: boolean;
  /** A window of the app has the keyboard focus right now. */
  focused: boolean;
  /** When a window of the app last had focus (ms); the app's start when none ever had. */
  lastFocusedAt: number;
  now: number;
  idleApplyMs: number;
}

/**
 * A ready update restarts the app by itself only when nobody is using it: automatic updates on, no window focused,
 * and none has been for `idleApplyMs`. A focused window is never interrupted, however long it sits untouched.
 */
export function shouldAutoApply(i: AutoApplyInput): boolean {
  return i.phase === "ready" && i.auto && !i.focused && i.now - i.lastFocusedAt >= i.idleApplyMs;
}
