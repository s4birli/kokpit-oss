// @vitest-environment node
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebSite } from "../renderer/engine/web-ipc.ts";
import { createWebSitesFile, mergeNewDefaults } from "./web-sites-file.ts";

const DEFAULTS: WebSite[] = [{ id: "home", title: "Ana sayfa", url: "https://home.example.com/" }];
let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kokpit-web-sites-"));
  file = join(dir, "sub", "web-sites.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** `seededBeforeMarker`: what a file from before the record existed has already seen (here: "home"). */
const make = (defaults: WebSite[] = DEFAULTS, seededBeforeMarker: string[] = ["home"]) => createWebSitesFile({ filePath: file, defaults, seededBeforeMarker });
const onDisk = (): { sites: WebSite[]; seededDefaults?: string[] } => JSON.parse(readFileSync(file, "utf8"));
const writeLegacy = (sites: WebSite[]): void => {
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, sites }));
};

describe("web sites file (İş M)", () => {
  it("no file: the defaults", async () => {
    expect(await make().load()).toEqual(DEFAULTS);
  });

  it("saves, reloads and keeps the file private", async () => {
    const f = make();
    const list = [...DEFAULTS, { id: "grafana", title: "Grafana", url: "https://grafana.example.com/" }];
    await f.save(list);
    expect(await make().load()).toEqual(list);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // An empty list is a valid choice and is kept.
    await f.save([]);
    expect(await f.load()).toEqual([]);
  });

  it("refuses an invalid list and leaves the file alone", async () => {
    const f = make();
    await f.save(DEFAULTS);
    await expect(f.save([{ id: "x", title: "X", url: "http://x.example.com/" }])).rejects.toThrow(/https/);
    await expect(f.save("nope")).rejects.toThrow();
    expect(await f.load()).toEqual(DEFAULTS);
  });

  it.each([["{"], ['{"version":1,"sites":"x"}'], ['{"version":99,"sites":[]}'], ["null"]])("a corrupt file (%s) gives the defaults", async (content) => {
    const f = make();
    await f.save([]);
    writeFileSync(file, content);
    expect(await f.load()).toEqual(DEFAULTS);
  });

  it("invalid entries in an edited file are dropped, valid ones kept", async () => {
    const f = make();
    await f.save([]);
    writeFileSync(file, JSON.stringify({ version: 1, sites: [{ id: "a", title: "A", url: "https://a.example.com/" }, { id: "b", title: "B", url: "javascript:1" }] }));
    expect(await f.load()).toEqual([{ id: "a", title: "A", url: "https://a.example.com/" }]);
    expect(JSON.parse(readFileSync(file, "utf8")).sites).toHaveLength(2);
  });

  it("an http site on a Tailscale address is saved (normalized); http to a public address or a name is refused", async () => {
    const f = make();
    await f.save([{ id: "pano", title: "Pano", url: "http://0144.0100.0161.075:9119" }]);
    expect(await f.load()).toEqual([{ id: "pano", title: "Pano", url: "http://100.64.113.61:9119/" }]);
    await expect(f.save([{ id: "x", title: "X", url: "http://8.8.8.8/" }])).rejects.toThrow(/Tailscale/);
    await expect(f.save([{ id: "x", title: "X", url: "http://nas.ts.net:9119/" }])).rejects.toThrow(/IP adresi/);
    await expect(f.save([{ id: "x", title: "X", url: "http://u:p@100.64.113.61/" }])).rejects.toThrow(/parola/);
  });
});

describe("new defaults reach an existing install once", () => {
  const home = DEFAULTS[0]!;
  const wiki: WebSite = { id: "wiki", title: "Wiki", url: "https://wiki.example.com/" };
  const pano: WebSite = { id: "nas-pano", title: "NAS panosu", url: "http://100.64.113.61:9119/" };
  const nas: WebSite = { id: "nas", title: "NAS", url: "http://100.64.113.61:8787/" };
  const NOW = [home, wiki, pano, nas];
  const BEFORE = ["home", "wiki"];

  it("a list saved before the defaults were added gets them at the end, and the file records it", async () => {
    writeLegacy([wiki, home]);
    expect(await make(NOW, BEFORE).load()).toEqual([wiki, home, pano, nas]);
    expect(onDisk()).toMatchObject({ sites: [wiki, home, pano, nas], seededDefaults: ["home", "wiki", "nas-pano", "nas"] });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("a default the user deleted before never comes back", async () => {
    writeLegacy([home]); // wiki was deleted by the user long ago
    expect(await make(NOW, BEFORE).load()).toEqual([home, pano, nas]);
  });

  it("a new default the user deleted stays deleted on the next start", async () => {
    writeLegacy([home, wiki]);
    const f = make(NOW, BEFORE);
    expect(await f.load()).toEqual([home, wiki, pano, nas]);
    await f.save([home, wiki, nas]); // the user removes "NAS panosu"
    expect(await make(NOW, BEFORE).load()).toEqual([home, wiki, nas]);
    await make(NOW, BEFORE).save([]); // …and then everything
    expect(await make(NOW, BEFORE).load()).toEqual([]);
  });

  it("a default the user edited is never overwritten", async () => {
    writeLegacy([home, wiki]);
    const f = make(NOW, BEFORE);
    await f.load();
    const edited = { ...pano, title: "Pano (NAS)", url: "http://100.64.113.61:9120/" };
    await f.save([home, wiki, edited, nas]);
    expect(await make(NOW, BEFORE).load()).toEqual([home, wiki, edited, nas]);
  });

  it("the user's own site with a default's id or address wins; the default is only recorded", async () => {
    const own = { id: "nas-pano", title: "Benim panom", url: "https://pano.example.com/" };
    const sameUrl = { id: "nas", title: "NAS", url: nas.url };
    writeLegacy([own, sameUrl]);
    expect(await make(NOW, BEFORE).load()).toEqual([own, sameUrl]);
    expect(onDisk().seededDefaults).toEqual(["home", "wiki", "nas-pano", "nas"]);
  });

  it("a second load changes nothing and does not rewrite the file", async () => {
    writeLegacy([home]);
    await make(NOW, BEFORE).load();
    const first = readFileSync(file, "utf8");
    chmodSync(dir + "/sub", 0o500); // a rewrite would fail to create its temp file — and must not be attempted
    try {
      expect(await make(NOW, BEFORE).load()).toEqual([home, pano, nas]);
    } finally {
      chmodSync(dir + "/sub", 0o700);
    }
    expect(readFileSync(file, "utf8")).toBe(first);
  });

  it("when the file cannot be rewritten the merged list is still shown (and merged again next time)", async () => {
    writeLegacy([home]);
    chmodSync(dir + "/sub", 0o500);
    try {
      expect(await make(NOW, BEFORE).load()).toEqual([home, pano, nas]);
    } finally {
      chmodSync(dir + "/sub", 0o700);
    }
    expect(onDisk().seededDefaults).toBeUndefined();
  });

  it("nothing saved yet: the defaults, no file written; the first save records every default", async () => {
    const f = make(NOW, BEFORE);
    expect(await f.load()).toEqual(NOW);
    expect(() => statSync(file)).toThrow();
    await f.save([home]);
    expect(onDisk().seededDefaults).toEqual(["home", "wiki", "nas-pano", "nas"]);
    expect(await make(NOW, BEFORE).load()).toEqual([home]);
  });

  it("a later default is added to a file that already has the record", async () => {
    const f = make([home, wiki], BEFORE);
    await f.save([wiki]);
    expect(await make(NOW, BEFORE).load()).toEqual([wiki, pano, nas]);
    const grafana = { id: "grafana", title: "Grafana", url: "https://grafana.example.com/" };
    expect(await make([...NOW, grafana], BEFORE).load()).toEqual([wiki, pano, nas, grafana]);
  });

  it("a hand-edited record with junk in it is read safely", async () => {
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, sites: [home], seededDefaults: ["home", 7, null, "../x", { id: "wiki" }, "nas"] }));
    expect(await make(NOW, BEFORE).load()).toEqual([home, wiki, pano]);
    writeFileSync(file, JSON.stringify({ version: 1, sites: [home], seededDefaults: "hepsi" }));
    expect(await make(NOW, BEFORE).load()).toEqual([home, pano, nas]); // not a list → as a file without the record
  });

  it("mergeNewDefaults: order kept, the site limit respected, input untouched", () => {
    const limits = { limits: { maxSites: 3, maxTitle: 60, maxIdLength: 40 } };
    const sites = [home, wiki];
    const r = mergeNewDefaults(sites, NOW, BEFORE, limits);
    expect(r).toEqual({ sites: [home, wiki, pano], seeded: ["home", "wiki", "nas-pano", "nas"], changed: true });
    expect(sites).toEqual([home, wiki]);
    expect(mergeNewDefaults(r.sites, NOW, r.seeded, limits)).toEqual({ sites: r.sites, seeded: r.seeded, changed: false });
    expect(mergeNewDefaults([], [], [], limits)).toEqual({ sites: [], seeded: [], changed: false });
  });
});
