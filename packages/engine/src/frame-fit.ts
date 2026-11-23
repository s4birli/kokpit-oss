// Keeps a list result inside one protocol frame. A `res` frame larger than MAX_MESSAGE_BYTES is never sent (the
// receiver would drop it); a result whose list can grow that large is cut to the longest prefix that fits, and
// its handler reports the cut the way that result already reports missing items (`truncated`).
import { MAX_MESSAGE_BYTES } from "@kokpit/shared";

/** `res` frame characters around a result, with the widest request id. */
function frameChars(result: unknown): number {
  return JSON.stringify({ type: "res", id: Number.MAX_SAFE_INTEGER, ok: true, result }).length;
}

/**
 * `result` with its list `key` cut to the longest prefix for which the whole `res` frame is at most `limit`
 * characters. `cut`: items were dropped. A result that fits is returned as it is (same object).
 */
export function fitResultList<K extends string, R extends Record<K, readonly unknown[]>>(
  result: R,
  key: K,
  limit: number = MAX_MESSAGE_BYTES,
): { result: R; cut: boolean } {
  const list: readonly unknown[] = result[key];
  let size = frameChars({ ...result, [key]: [] });
  let kept = 0;
  for (const item of list) {
    // Every item but the first costs a comma too.
    const cost = JSON.stringify(item).length + (kept > 0 ? 1 : 0);
    if (size + cost > limit) break;
    size += cost;
    kept++;
  }
  if (kept === list.length) return { result, cut: false };
  return { result: { ...result, [key]: list.slice(0, kept) } as R, cut: true };
}
