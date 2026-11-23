export interface BackoffPolicy {
  initialMs: number;
  maxMs: number;
  multiplier: number;
  /** 0..1: fraction of the delay that may be randomly shaved off. */
  jitter: number;
}

/** Delay before reconnect attempt `attempt` (0-based): capped exponential, minus random jitter. */
export function backoffDelay(attempt: number, policy: BackoffPolicy, random: () => number = Math.random): number {
  const n = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const base = Math.min(policy.maxMs, policy.initialMs * policy.multiplier ** n);
  const jitter = Math.min(1, Math.max(0, policy.jitter));
  const r = Math.min(1, Math.max(0, random()));
  return base * (1 - jitter * (1 - r));
}
