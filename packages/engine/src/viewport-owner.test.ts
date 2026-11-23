// Who drives a page's viewport when several viewers show it (§7B): one rule for a project's Tarayıcı panel and
// for every Masaüstü window. Monkey: random reports and releases always leave the model's owner and size.
import { describe, expect, it } from "vitest";
import { ViewportOwners } from "./viewport-owner.ts";

const A = {};
const B = {};
const big = { width: 900, height: 600 };
const small = { width: 700, height: 420 };

describe("ViewportOwners", () => {
  it("the first report becomes the owner; a claimless report of another viewer is ignored, a claim takes over", () => {
    const o = new ViewportOwners<string>();
    expect(o.report("p", big, { key: A, interaction: false })).toEqual({ applied: true, changed: true, ownerChanged: true });
    expect(o.isOwner("p", A)).toBe(true);
    expect(o.report("p", small, { key: B, interaction: false })).toEqual({ applied: false });
    expect(o.view("p")).toEqual(big);
    expect(o.report("p", small, { key: B, interaction: true })).toEqual({ applied: true, changed: true, ownerChanged: true });
    expect(o.isOwner("p", B)).toBe(true);
    expect(o.isOwner("p", A)).toBe(false);
  });

  it("the owner re-sending the same size applies (heals) but is not a change", () => {
    const o = new ViewportOwners<string>();
    o.report("p", big, { key: A, interaction: false });
    expect(o.report("p", { ...big }, { key: A, interaction: false })).toEqual({ applied: true, changed: false, ownerChanged: false });
  });

  it("releasing drops only the owner; the size stays; the next reporter owns it", () => {
    const o = new ViewportOwners<string>();
    o.report("p", big, { key: A, interaction: false });
    expect(o.release("p", B)).toBe(false);
    expect(o.release("p", A)).toBe(true);
    expect(o.owner("p")).toBeUndefined();
    expect(o.view("p")).toEqual(big);
    expect(o.report("p", small, { key: B, interaction: false })).toMatchObject({ applied: true, ownerChanged: true });
  });

  it("keys are independent; forget removes one; ownedBy lists what a viewer owns", () => {
    const o = new ViewportOwners<string>();
    o.report("w1", big, { key: A, interaction: false });
    o.report("w2", small, { key: A, interaction: false });
    o.report("w3", small, { key: B, interaction: false });
    expect(o.ownedBy(A).sort()).toEqual(["w1", "w2"]);
    o.forget("w1");
    expect(o.view("w1")).toBeUndefined();
    expect(o.ownedBy(A)).toEqual(["w2"]);
  });

  it("monkey: 2000 random steps match a reference model", () => {
    let seed = 11;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const keys = ["p", "q"];
    const viewers = [A, B, {}];
    const o = new ViewportOwners<string>();
    const owner = new Map<string, object>();
    const view = new Map<string, { width: number; height: number }>();
    for (let i = 0; i < 2000; i++) {
      const k = keys[Math.floor(rnd() * keys.length)]!;
      const v = viewers[Math.floor(rnd() * viewers.length)]!;
      if (rnd() < 0.2) {
        const was = owner.get(k) === v;
        expect(o.release(k, v)).toBe(was);
        if (was) owner.delete(k);
        continue;
      }
      const size = { width: 100 + Math.floor(rnd() * 3) * 100, height: 100 + Math.floor(rnd() * 3) * 100 };
      const interaction = rnd() < 0.3;
      const r = o.report(k, size, { key: v, interaction });
      const may = interaction || owner.get(k) === undefined || owner.get(k) === v;
      expect(r.applied).toBe(may);
      if (may) {
        const old = view.get(k);
        if (r.applied) expect(r.changed).toBe(!old || old.width !== size.width || old.height !== size.height);
        owner.set(k, v);
        view.set(k, size);
      }
      expect(o.owner(k)).toBe(owner.get(k));
      expect(o.view(k)).toEqual(view.get(k));
    }
  });
});
