// İş M: in-memory stand-in for window.kokpit.web (main's site list + WebContentsViews).
import { act } from "@testing-library/react";
import { vi } from "vitest";
import { checkSites, type WebBounds, type WebBridge, type WebSite, type WebStatusEvent } from "../../engine/web-ipc.ts";

export const TEST_SITES: WebSite[] = [
  { id: "home", title: "Ana sayfa", url: "https://home.example.com/" },
  { id: "wiki", title: "Wiki", url: "https://wiki.example.com/" },
  { id: "notlar", title: "Notlar", url: "https://notes.example.com/" },
];

export class FakeWebBridge implements WebBridge {
  calls: Array<[string, ...unknown[]]> = [];
  list: WebSite[];
  private statusListeners = new Set<(e: WebStatusEvent) => void>();
  private sitesListeners = new Set<(s: WebSite[]) => void>();

  constructor(sites: WebSite[] = TEST_SITES) {
    this.list = sites.map((s) => ({ ...s }));
  }

  show = vi.fn(async (req: { siteId: string; bounds: WebBounds }) => {
    this.calls.push(["show", req.siteId, req.bounds]);
  });
  hide = vi.fn(async (siteId: string) => {
    this.calls.push(["hide", siteId]);
  });
  close = vi.fn(async (siteId: string) => {
    this.calls.push(["close", siteId]);
  });
  reload = vi.fn(async (siteId: string) => {
    this.calls.push(["reload", siteId]);
  });
  onStatus(listener: (e: WebStatusEvent) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }
  sites = {
    load: vi.fn(async (): Promise<WebSite[]> => this.list.map((s) => ({ ...s }))),
    save: vi.fn(async (sites: WebSite[]): Promise<void> => {
      // Same authority as main.
      const r = checkSites(sites);
      if (!r.ok) throw new Error(r.errors.join(" "));
      this.list = r.sites;
      for (const l of this.sitesListeners) l(r.sites);
    }),
    onChange: (listener: (s: WebSite[]) => void): (() => void) => {
      this.sitesListeners.add(listener);
      return () => this.sitesListeners.delete(listener);
    },
  };

  emitStatus(e: WebStatusEvent): void {
    act(() => {
      for (const l of this.statusListeners) l(e);
    });
  }
  /** main broadcasting a new list (e.g. saved in another window). */
  emitSites(sites: WebSite[]): void {
    this.list = sites;
    act(() => {
      for (const l of this.sitesListeners) l(sites);
    });
  }
  names(): string[] {
    return this.calls.map((c) => c[0]);
  }
  shown(): string[] {
    return this.calls.filter((c) => c[0] === "show").map((c) => c[1] as string);
  }
}
