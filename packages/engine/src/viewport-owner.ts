// §7B "Görünümün sahibi": when several viewers (connections) show one page in pictures of different sizes, only
// ONE of them drives the page's viewport — the one whose user last used it. The rule is the same for a project's
// Tarayıcı panel (key = project id) and for each Masaüstü window (key = app id); this is it, without Chrome.
import type { PanelView } from "./browser-live.ts";

/** Who reports a picture size: the viewer (a connection) and whether its user just used that picture. */
export interface ViewportReport {
  key: object;
  interaction: boolean;
}

export type ViewportDecision = { applied: false } | { applied: true; changed: boolean; ownerChanged: boolean };

export class ViewportOwners<K> {
  /** The owner's picture per key; absent = nobody reported one (the page keeps Chrome's window size). */
  private readonly views = new Map<K, PanelView>();
  /** The viewer the page follows per key; absent = nobody: the next reporter becomes it. */
  private readonly owners = new Map<K, object>();

  view(k: K): PanelView | undefined {
    return this.views.get(k);
  }

  owner(k: K): object | undefined {
    return this.owners.get(k);
  }

  isOwner(k: K, viewer: object): boolean {
    return this.owners.get(k) === viewer;
  }

  /**
   * Decided synchronously, in the order the reports arrive, so no two viewers can both win. `interaction` makes the
   * reporter the owner; without it the size counts only from the owner or when nobody owns. `changed`: the size is
   * not the one in use (an identical one is applied again — it heals a stale override — but needs no new frame).
   */
  report(k: K, view: PanelView, by: ViewportReport): ViewportDecision {
    const owner = this.owners.get(k);
    if (!by.interaction && owner !== undefined && owner !== by.key) return { applied: false };
    const ownerChanged = owner !== by.key;
    if (ownerChanged) this.owners.set(k, by.key);
    const old = this.views.get(k);
    const changed = !old || old.width !== view.width || old.height !== view.height;
    this.views.set(k, { width: view.width, height: view.height });
    return { applied: true, changed, ownerChanged };
  }

  /** `viewer` stopped watching (or left): it no longer drives the page, which keeps its size. True = it did. */
  release(k: K, viewer: object): boolean {
    if (this.owners.get(k) !== viewer) return false;
    this.owners.delete(k);
    return true;
  }

  /** The keys `viewer` drives. */
  ownedBy(viewer: object): K[] {
    return [...this.owners].filter(([, v]) => v === viewer).map(([k]) => k);
  }

  /** Every key with an owner or a size. */
  keys(): K[] {
    return [...new Set([...this.views.keys(), ...this.owners.keys()])];
  }

  /** The key is gone (its project deleted, its window closed). */
  forget(k: K): void {
    this.views.delete(k);
    this.owners.delete(k);
  }
}
