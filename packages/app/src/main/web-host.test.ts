// @vitest-environment node
// A removed site must not leave its login behind: a new site on the same host gets the same id (and thus the
// same partition), so the removed site's storage is cleared when it leaves the list.
import { describe, expect, it, vi } from "vitest";
import { webConfig, type WebSite } from "../renderer/engine/web-ipc.ts";
import type { TailnetVerifier } from "./tailnet.ts";
import type { WebViewHostOptions } from "./web-view-host.ts";

const hostKeys: string[] = [];
/** What web-host.ts asked the (mocked) view host to do, in order. */
const hostCalls: string[] = [];
/** The options web-host.ts handed to the (mocked) view host: its per-site rules. */
let viewHostOptions: WebViewHostOptions | undefined;
vi.mock("./web-view-host.ts", () => ({
  createWebViewHost: (opts: WebViewHostOptions) => ({
    ...((viewHostOptions = opts), {}),
    keys: () => [...hostKeys],
    close: (id: string) => {
      const i = hostKeys.indexOf(id);
      if (i < 0) return false;
      hostKeys.splice(i, 1);
      return true;
    },
    show: (id: string, url: string) => {
      hostCalls.push(`show ${id} ${url}`);
      if (!hostKeys.includes(id)) hostKeys.push(id);
      return true;
    },
    hide: (id: string) => void hostCalls.push(`hide ${id}`),
    reload: (id: string) => void hostCalls.push(`reload ${id}`),
  }),
}));

const { createWebHost } = await import("./web-host.ts");

/** A fake Tailscale: the addresses it vouches for right now (null = Tailscale is off / unreadable). */
function fakeTailnet(initial: string[] | null) {
  const state = { addresses: initial, checks: 0, invalidations: 0, fail: false };
  const verifier: TailnetVerifier = {
    verify: async (ip) => {
      state.checks++;
      if (state.fail) throw new Error("tailscale exploded");
      return state.addresses !== null && state.addresses.includes(ip.join("."));
    },
    invalidate: () => void state.invalidations++,
  };
  return { state, verifier };
}

function setup(initial: WebSite[], tailnet = fakeTailnet(null)) {
  let saved = initial;
  const cleared: string[] = [];
  const statuses: string[] = [];
  hostKeys.length = 0;
  hostCalls.length = 0;
  const host = createWebHost({
    config: webConfig,
    env: {},
    window: () => null,
    openExternal: () => undefined,
    file: { load: async () => saved, save: async (raw) => (saved = raw as WebSite[]) },
    emitStatus: (e) => void statuses.push(`${e.siteId}:${e.status}`),
    sitesChanged: () => undefined,
    tailnet: tailnet.verifier,
    clearSiteData: async (partition: string) => {
      cleared.push(partition);
    },
  });
  return { host, cleared, statuses, tailnet: tailnet.state };
}

const wiki: WebSite = { id: "wiki", title: "Wiki", url: "https://wiki.example.com" };
const home: WebSite = { id: "home", title: "Ana sayfa", url: "https://home.example.com" };

describe("web host: removing a site clears its stored session", () => {
  it("clears the partition of every removed site (open or not), never of kept ones", async () => {
    const { host, cleared } = setup([home, wiki]);
    await host.init();
    hostKeys.splice(0, hostKeys.length, "wiki");
    await host.saveSites([home]);
    expect(cleared).toEqual([`${webConfig.partitionPrefix}wiki`]);
    expect(hostKeys).toEqual([]);
  });

  it("a kept id whose address moves to another origin is cleared (and closed); a path change on the same origin is not", async () => {
    const { host, cleared } = setup([home, wiki]);
    await host.init();
    hostKeys.splice(0, hostKeys.length, "wiki");
    await host.saveSites([home, { ...wiki, url: "https://baska.example.com/" }]);
    expect(cleared).toEqual([`${webConfig.partitionPrefix}wiki`]);
    expect(hostKeys).toEqual([]);
    await host.saveSites([{ ...home, url: "https://home.example.com/yeni/yol" }, { ...wiki, url: "https://baska.example.com/" }]);
    expect(cleared).toEqual([`${webConfig.partitionPrefix}wiki`]);
  });

  it("keeping every site clears nothing", async () => {
    const { host, cleared } = setup([home, wiki]);
    await host.init();
    await host.saveSites([wiki, home]);
    expect(cleared).toEqual([]);
  });
});

describe("web host: every view is ruled by its own site's address", () => {
  const pano: WebSite = { id: "nas-pano", title: "NAS panosu", url: "http://100.64.113.61:9119/" };
  const nas: WebSite = { id: "nas", title: "NAS", url: "http://100.64.113.61:8787/" };

  it("navigation, popups and plain-http requests are decided per site, from main's own list", async () => {
    const { host } = setup([home, pano, nas]);
    await host.init();
    const o = viewHostOptions!;
    const main = { mainFrame: true };
    expect(o.partition("nas-pano")).not.toBe(o.partition("nas")); // two ports on one address: two logins
    // The http site stays on its own origin; the other NAS page is another origin.
    expect(o.navigation!("nas-pano", "http://100.64.113.61:9119/login", main)).toBe("allow");
    expect(o.navigation!("nas-pano", "http://100.64.113.61:8787/", main)).toBe("deny");
    expect(o.navigation!("nas", "http://100.64.113.61:8787/", main)).toBe("allow");
    expect(o.navigation!("nas-pano", "http://example.com/", main)).toBe("deny");
    expect(o.navigation!("nas-pano", "https://example.com/", main)).toBe("external");
    // The https site is never downgraded.
    expect(o.navigation!("home", "http://100.64.113.61:9119/", main)).toBe("deny");
    expect(o.navigation!("home", "http://home.example.com/", main)).toBe("deny");
    expect(o.navigation!("home", "https://home.example.com/x", main)).toBe("allow");
    expect(o.popup("nas-pano", "http://100.64.113.61:9119/p")).toBe("child");
    expect(o.popup("home", "http://100.64.113.61:9119/p")).toBe("deny");
    expect(await o.requestAllowed!("nas-pano", "ws://100.64.113.61:9119/ws")).toBe(false); // Tailscale is off in this setup
    expect(await o.requestAllowed!("nas-pano", "http://example.com/x.js")).toBe(false);
    expect(await o.requestAllowed!("home", "http://100.64.113.61:9119/")).toBe(false);
    expect(o.insecureRequestPatterns).toEqual(["http://*/*", "ws://*/*"]);
    // A site that is not (or no longer) in the list has no address: nothing is allowed.
    expect(o.navigation!("yok", "https://example.com/", main)).toBe("deny");
    expect(await o.requestAllowed!("yok", "http://100.64.113.61:9119/")).toBe(false);
  });

  it("the rules follow an edited address at once", async () => {
    const { host } = setup([pano]);
    await host.init();
    const o = viewHostOptions!;
    await host.saveSites([{ ...pano, url: "http://100.64.113.61:9120/" }]);
    expect(o.navigation!("nas-pano", "http://100.64.113.61:9119/", { mainFrame: true })).toBe("deny");
    expect(o.navigation!("nas-pano", "http://100.64.113.61:9120/x", { mainFrame: true })).toBe("allow");
  });
});

// 100.64.0.0/10 is carrier-grade NAT space: only Tailscale's own status makes such an address the user's machine.
describe("web host: a plain-http Tailscale site loads only while its address is verified in the tailnet", () => {
  const NAS = "100.64.113.61";
  const pano: WebSite = { id: "nas-pano", title: "NAS panosu", url: `http://${NAS}:9119/` };
  const local: WebSite = { id: "yerel", title: "Yerel", url: "http://127.0.0.1:3000/" };
  const bounds = { x: 0, y: 0, width: 800, height: 600 };
  const show = (host: Awaited<ReturnType<typeof setup>>["host"], siteId: string) => host.show({ siteId, bounds });

  it("running tailnet + the address is a peer: the site is shown and its requests pass", async () => {
    const { host, statuses, tailnet } = setup([pano], fakeTailnet([NAS]));
    await host.init();
    await show(host, "nas-pano");
    expect(hostCalls).toEqual([`show nas-pano http://${NAS}:9119/`]);
    expect(statuses).toEqual([]);
    expect(tailnet.checks).toBe(1);
    expect(await viewHostOptions!.requestAllowed!("nas-pano", `http://${NAS}:9119/api`)).toBe(true);
    expect(await viewHostOptions!.requestAllowed!("nas-pano", `ws://${NAS}:9119/ws`)).toBe(true);
    expect(await viewHostOptions!.requestAllowed!("nas-pano", `http://${NAS}:8787/`)).toBe(false);
  });

  it.each([
    ["Tailscale is off (or its CLI is missing / timed out / unreadable)", null],
    ["Tailscale is running but the address is not in the tailnet (a carrier's CGNAT host)", ["100.64.1.2", "100.64.113.62"]],
  ])("%s: nothing is loaded, the panel is told why, no request passes", async (_n, addresses) => {
    const { host, statuses } = setup([pano], fakeTailnet(addresses));
    await host.init();
    await show(host, "nas-pano");
    expect(hostCalls).toEqual([]);
    expect(hostKeys).toEqual([]);
    expect(statuses).toEqual(["nas-pano:tailnet"]);
    expect(await viewHostOptions!.requestAllowed!("nas-pano", `http://${NAS}:9119/`)).toBe(false);
    expect(await viewHostOptions!.requestAllowed!("nas-pano", `ws://${NAS}:9119/ws`)).toBe(false);
  });

  it("a verifier that throws is a no (fail closed)", async () => {
    const tailnet = fakeTailnet([NAS]);
    tailnet.state.fail = true;
    const { host, statuses } = setup([pano], tailnet);
    await host.init();
    await show(host, "nas-pano");
    expect(hostCalls).toEqual([]);
    expect(statuses).toEqual(["nas-pano:tailnet"]);
    expect(await viewHostOptions!.requestAllowed!("nas-pano", `http://${NAS}:9119/`)).toBe(false);
  });

  it("https and loopback-http sites never ask Tailscale", async () => {
    const { host, statuses, tailnet } = setup([home, local], fakeTailnet(null));
    await host.init();
    await show(host, "home");
    await show(host, "yerel");
    await host.reload("home");
    await host.reload("yerel");
    expect(hostCalls).toEqual(["show home https://home.example.com", "show yerel http://127.0.0.1:3000/", "reload home", "reload yerel"]);
    expect(await viewHostOptions!.requestAllowed!("yerel", "http://127.0.0.1:3000/x")).toBe(true);
    expect(tailnet.checks).toBe(0);
    expect(statuses).toEqual([]);
  });

  it("Tailscale goes down while the site is open: its requests stop, and every show / Yenile checks again and unloads it", async () => {
    const { host, statuses, tailnet } = setup([pano], fakeTailnet([NAS]));
    await host.init();
    await show(host, "nas-pano");
    tailnet.addresses = null;
    expect(await viewHostOptions!.requestAllowed!("nas-pano", `http://${NAS}:9119/api`)).toBe(false);
    await host.reload("nas-pano");
    expect(hostCalls).toEqual([`show nas-pano http://${NAS}:9119/`]); // no reload was sent
    expect(hostKeys).toEqual([]); // the view is gone
    expect(statuses).toEqual(["nas-pano:tailnet"]);
    expect(tailnet.invalidations).toBe(1);
  });

  it("Yenile after Tailscale comes back shows the site that was not loaded (at the place it was asked for)", async () => {
    const { host, statuses, tailnet } = setup([pano], fakeTailnet(null));
    await host.init();
    await show(host, "nas-pano");
    expect(statuses).toEqual(["nas-pano:tailnet"]);
    await host.reload("nas-pano"); // still off
    expect(hostCalls).toEqual([]);
    tailnet.addresses = [NAS];
    await host.reload("nas-pano");
    expect(hostCalls).toEqual([`show nas-pano http://${NAS}:9119/`]);
    await host.reload("nas-pano");
    expect(hostCalls.at(-1)).toBe("reload nas-pano");
  });

  it("a load that failed asks Tailscale afresh and reports the tailnet as the reason when it is", async () => {
    const { host, statuses, tailnet } = setup([pano, home], fakeTailnet([NAS]));
    await host.init();
    await show(host, "nas-pano");
    tailnet.addresses = null;
    viewHostOptions!.onStatus("nas-pano", "failed");
    await new Promise((r) => setTimeout(r, 0));
    expect(statuses).toEqual(["nas-pano:tailnet"]);
    expect(tailnet.invalidations).toBe(1);
    expect(hostKeys).toEqual([]);
    // With the tailnet fine, a failure is just a failure; an https site's failure never involves Tailscale.
    tailnet.addresses = [NAS];
    viewHostOptions!.onStatus("nas-pano", "failed");
    viewHostOptions!.onStatus("home", "failed");
    await new Promise((r) => setTimeout(r, 0));
    expect(statuses).toEqual(["nas-pano:tailnet", "home:failed", "nas-pano:failed"]);
  });

  it("a show still waiting for Tailscale gives way to a later hide or close (nothing appears afterwards)", async () => {
    const tailnet = fakeTailnet([NAS]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const verify = tailnet.verifier.verify;
    tailnet.verifier.verify = async (ip) => (await gate, verify(ip));
    const { host, statuses } = setup([pano], tailnet);
    await host.init();
    const pending = show(host, "nas-pano");
    host.hide("nas-pano");
    release();
    await pending;
    expect(hostCalls).toEqual(["hide nas-pano"]);
    expect(statuses).toEqual([]);
  });

  it("the check follows an edited address: moved to another Tailscale address that is not verified", async () => {
    const { host, statuses } = setup([pano], fakeTailnet([NAS]));
    await host.init();
    await show(host, "nas-pano");
    await host.saveSites([{ ...pano, url: "http://100.64.99.99:9119/" }]);
    statuses.length = 0;
    hostCalls.length = 0;
    await show(host, "nas-pano");
    expect(hostCalls).toEqual([]);
    expect(statuses).toEqual(["nas-pano:tailnet"]);
  });
});
