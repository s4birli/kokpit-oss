// The tab list the engine answers with, built from Chrome's Target.getTargets: order is kept, new tabs go to the
// end, and a tab that is being closed — or that Chrome already reported destroyed — is never listed, even if
// Chrome still names it (seen with a real Chrome under load: the closed tab came back at the end of the list in
// the answer to its own close).
import { describe, expect, it } from "vitest";
import { mergeTabs, within, type TargetInfo } from "./browser.ts";

const page = (id: string, title = id): TargetInfo => ({ targetId: id, type: "page", title, url: `https://ornek.test/${id}` });
const ids = (m: Map<string, unknown>): string[] => [...m.keys()];
const none = (): boolean => false;

describe("mergeTabs", () => {
  it("keeps the known order, takes titles and URLs from Chrome, appends tabs it did not know", () => {
    const merged = mergeTabs(["B", "A"], [page("A", "a2"), page("B"), page("C")], none);
    expect(ids(merged)).toEqual(["B", "A", "C"]);
    expect(merged.get("A")).toEqual({ id: "A", title: "a2", url: "https://ornek.test/A" });
  });

  it("drops tabs Chrome no longer has, and targets that are not pages", () => {
    const worker: TargetInfo = { targetId: "W", type: "service_worker", title: "", url: "" };
    expect(ids(mergeTabs(["A", "B", "C"], [page("C"), worker, page("A")], none))).toEqual(["A", "C"]);
  });

  it("a hidden tab (closing, or reported destroyed) is not listed although Chrome still names it", () => {
    // After the close: the engine no longer knows B, Chrome's answer still carries it.
    const hidden = new Set(["B"]);
    expect(ids(mergeTabs(["A", "C"], [page("A"), page("B"), page("C")], (id) => hidden.has(id)))).toEqual(["A", "C"]);
    // And it is not kept if the engine still had it either.
    expect(ids(mergeTabs(["A", "B", "C"], [page("A"), page("B"), page("C")], (id) => hidden.has(id)))).toEqual(["A", "C"]);
  });

  it("monkey: any mix of known, listed and hidden ids — never a hidden or unlisted tab, never a duplicate", () => {
    const pool = ["A", "B", "C", "D", "E", "F"];
    let seed = 7;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = (): string[] => pool.filter(() => rnd() < 0.5).sort(() => rnd() - 0.5);
    for (let round = 0; round < 200; round++) {
      const known = pick();
      const listed = pick();
      const hidden = new Set(pick());
      const out = ids(mergeTabs(known, listed.map((id) => page(id)), (id) => hidden.has(id)));
      expect(new Set(out).size).toBe(out.length);
      expect([...out].sort()).toEqual(listed.filter((id) => !hidden.has(id)).sort());
      // Known tabs come first, in their order.
      const kept = known.filter((id) => out.includes(id));
      expect(out.slice(0, kept.length)).toEqual(kept);
    }
  });
});

describe("within: a page that never answers cannot hold a tab switch", () => {
  it("answers what the step answered in time", async () => {
    await expect(within(Promise.resolve(7), 1000, "step")).resolves.toBe(7);
    await expect(within(Promise.reject(new Error("gone")), 1000, "step")).rejects.toThrow("gone");
  });

  it("gives up after the bound with a named timeout; the step's later failure is not an unhandled rejection", async () => {
    let fail!: (e: Error) => void;
    const never = new Promise<never>((_, rej) => (fail = rej));
    const start = Date.now();
    await expect(within(never, 30, "Runtime.evaluate")).rejects.toThrow("Runtime.evaluate timed out after 30 ms");
    expect(Date.now() - start).toBeLessThan(1000);
    fail(new Error("CDP Runtime.evaluate timed out"));
    await new Promise((r) => setTimeout(r, 10));
  });
});
