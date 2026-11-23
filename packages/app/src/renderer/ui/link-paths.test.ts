// Yollar: a gesture on a file path a terminal printed → what happens, per file kind and per project kind. The
// decisions (link-actions.ts) as tables, and the opener (link-opener.ts) against fakes: nothing is opened for real.
import type { BrowserState, FileLocation, Project } from "@kokpit/shared";
import { t as msg } from "../../i18n/index.ts";
import { describe, expect, it } from "vitest";
import { linksConfig, type LinkMenuChoice, type LinkMenuRequest, type LinksConfig, type PathMenuRequest } from "../engine/links-ipc.ts";
import { EngineRequestError } from "../engine/types.ts";
import { pathAction, pathMenuOffers, pathTooltip, type PathState } from "./link-actions.ts";
import { createLinkOpener } from "./link-opener.ts";

const cfg: LinksConfig = { ...linksConfig, rate: { max: 3, windowMs: 10_000, minIntervalMs: 100 }, pathCacheMs: 1000 };
const loc = (extra: Partial<FileLocation> & Pick<FileLocation, "kind">): FileLocation => ({ path: "/x/dosya", browser: false, ...extra });

const PAGE_OUTSIDE = loc({ kind: "page", path: "/Users/ada/Documents/Acme-ux-2026-11-05/index.html", browser: true });
const PAGE_INSIDE = loc({ kind: "page", path: "/p/dist/index.html", rootPath: "dist/index.html", browser: true });
const PAGE_REFUSED = loc({ kind: "page", path: "/Users/ada/.ssh/a.html", browserRefusal: "Gizli (noktayla başlayan) klasör ve dosyalar önizlenmez" });
const VIDEO_INSIDE = loc({ kind: "media", media: "video", path: "/p/klip.mp4", rootPath: "klip.mp4", browser: true });
const VIDEO_OUTSIDE = loc({ kind: "media", media: "video", path: "/Users/ada/Movies/klip.mp4", browser: true });
const MOV_OUTSIDE = loc({ kind: "media", media: "video", path: "/Users/ada/Movies/klip.mov" });
const TEXT_INSIDE = loc({ kind: "file", path: "/p/src/a.ts", rootPath: "src/a.ts" });
const TEXT_OUTSIDE = loc({ kind: "file", path: "/Users/ada/Documents/notlar.md", browser: true });
const ZIP_OUTSIDE = loc({ kind: "file", path: "/Users/ada/arsiv.zip" });
const DIR_INSIDE = loc({ kind: "dir", path: "/p/src", rootPath: "src" });
const DIR_OUTSIDE = loc({ kind: "dir", path: "/Users/ada/Documents" });
const CARD_FILE = loc({ kind: "file", path: "/w/kart/src/a.ts", rootPath: "src/a.ts", cardId: "c1" });

describe("pathAction: what a click on a path does", () => {
  it.each([
    ["a page outside the project", PAGE_OUTSIDE, "browser"],
    ["a page inside the project", PAGE_INSIDE, "browser"],
    ["a page in a refused folder", PAGE_REFUSED, "none"],
    ["a video inside the project", VIDEO_INSIDE, "files"],
    ["a video outside the project", VIDEO_OUTSIDE, "browser"],
    ["a video outside that the preview does not serve", MOV_OUTSIDE, "none"],
    ["a text file inside the project", TEXT_INSIDE, "files"],
    ["a text file outside the project", TEXT_OUTSIDE, "none"],
    ["any other file outside", ZIP_OUTSIDE, "none"],
    ["a folder inside the project", DIR_INSIDE, "none"],
    ["a folder outside", DIR_OUTSIDE, "none"],
  ] as const)("%s → %s", (_name, location, action) => expect(pathAction(location)).toBe(action));
});

describe("pathMenuOffers: what the right-click menu offers besides copying", () => {
  it.each([
    [PAGE_OUTSIDE, { browser: true, files: false }],
    [PAGE_INSIDE, { browser: true, files: true }],
    [PAGE_REFUSED, { browser: false, files: false }],
    [VIDEO_INSIDE, { browser: true, files: true }],
    [TEXT_INSIDE, { browser: false, files: true }],
    // Not opened by a click, but the menu can show a text file in the browser.
    [TEXT_OUTSIDE, { browser: true, files: false }],
    [ZIP_OUTSIDE, { browser: false, files: false }],
    [DIR_INSIDE, { browser: false, files: true }],
    [DIR_OUTSIDE, { browser: false, files: false }],
  ] as const)("%j → %j", (location, offers) => {
    expect(pathMenuOffers(location, "engine")).toEqual(offers);
    expect(pathMenuOffers(location, "client")).toEqual(offers);
    // SSH / app-only: only copying.
    expect(pathMenuOffers(location, "external")).toEqual({ browser: false, files: false });
  });

  it("nothing is offered for a path the engine did not find", () => expect(pathMenuOffers(undefined, "engine")).toEqual({ browser: false, files: false }));
});

describe("pathTooltip", () => {
  const ctx = { tracking: true, plainClickOpens: true, machineName: "Mac mini" };
  const found = (location: FileLocation): PathState => ({ status: "found", location });
  const tip = (written: string, state: PathState, destination: "engine" | "client" | "external" = "engine", over: Partial<typeof ctx> = {}) =>
    pathTooltip(written, state, destination, { ...ctx, ...over }, cfg);

  it("before the engine was asked: by the name alone — a page goes to the browser", () => {
    expect(tip("~/Documents/rapor/index.html", { status: "pending" })).toEqual({
      url: "~/Documents/rapor/index.html",
      lines: ["⌘ tıkla: Mac mini'deki tarayıcıda açılır", msg("links.text.gestureMenu")],
      openable: true,
    });
    expect(tip("src/a.ts", { status: "pending" }).lines[0]).toBe(`⌘ tıkla: ${msg("links.text.pathByType")}`);
    expect(tip("src/a.ts", { status: "pending" }, "engine", { tracking: false }).lines[0]).toBe(`Tıkla ya da ⌘ tıkla: ${msg("links.text.pathByType")}`);
  });

  it("once found: the file's real place, and where a click takes it", () => {
    expect(tip("~/Documents/Acme-ux-2026-11-05/index.html", found(PAGE_OUTSIDE))).toEqual({
      url: "/Users/ada/Documents/Acme-ux-2026-11-05/index.html",
      lines: ["⌘ tıkla: Mac mini'deki tarayıcıda açılır", msg("links.text.gestureMenu")],
      openable: true,
    });
    expect(tip("x", found(PAGE_OUTSIDE), "client").lines[0]).toBe(`⌘ tıkla: ${msg("links.text.client")}`);
    expect(tip("klip.mp4", found(VIDEO_INSIDE)).lines[0]).toBe("⌘ tıkla: Dosyalar'da açılır");
    expect(tip("src/a.ts", found(TEXT_INSIDE)).lines[0]).toBe("⌘ tıkla: Dosyalar'da açılır");
    expect(tip("~/Movies/klip.mp4", found(VIDEO_OUTSIDE)).lines[0]).toBe("⌘ tıkla: Mac mini'deki tarayıcıda açılır");
  });

  it("what a click does not open says so, and names what is left", () => {
    expect(tip("~/Documents/notlar.md", found(TEXT_OUTSIDE))).toEqual({ url: "/Users/ada/Documents/notlar.md", lines: [`${msg("links.text.pathMenuOnly")} · ${msg("links.text.gestureMenu")}`], openable: false });
    expect(tip("src", found(DIR_INSIDE)).lines).toEqual([`${msg("links.text.pathMenuOnly")} · ${msg("links.text.gestureMenu")}`]);
    expect(tip("~/arsiv.zip", found(ZIP_OUTSIDE)).lines).toEqual([`${msg("links.text.pathMenuOnly")} · ${msg("links.text.pathCopy")}`]);
    expect(tip("~/.ssh/a.html", found(PAGE_REFUSED))).toEqual({
      url: "/Users/ada/.ssh/a.html",
      lines: [`Gizli (noktayla başlayan) klasör ve dosyalar önizlenmez · ${msg("links.text.pathCopy")}`],
      openable: false,
    });
  });

  it("not found, and projects whose files are elsewhere", () => {
    expect(tip("~/yok.html", { status: "failed", message: "Dosya bulunamadı" })).toEqual({ url: "~/yok.html", lines: [`Dosya bulunamadı · ${msg("links.text.pathCopy")}`], openable: false });
    expect(tip("~/rapor/index.html", { status: "pending" }, "external")).toEqual({ url: "~/rapor/index.html", lines: [`${msg("links.text.pathRemote")} · ${msg("links.text.pathCopy")}`], openable: false });
    expect(tip("~/rapor/index.html", found(PAGE_OUTSIDE), "external").openable).toBe(false);
  });

  it("a long path is shortened, keeping both ends", () => {
    const long = `/Users/ada/${"a".repeat(600)}/index.html`;
    const t = tip(long, { status: "pending" });
    expect(t.url.length).toBeLessThanOrEqual(cfg.tooltipMaxChars);
    expect(t.url.startsWith("/Users/ada/")).toBe(true);
    expect(t.url.endsWith("/index.html")).toBe(true);
  });
});

// ---- the opener ----

const PROJECTS: Record<string, Project> = {
  local: { id: "local", name: "Yerel", location: { kind: "local", path: "/p" } },
  client: { id: "client", name: "İstemci", location: { kind: "local", path: "/p" }, browser: { runOn: "client" } },
  ssh: { id: "ssh", name: "Uzak", location: { kind: "ssh", hostId: "h" } },
};
const STATE: BrowserState = { running: true, tabs: [{ id: "T9", title: "", url: "http://127.0.0.1:7420/files/preview/x/index.html" }], activeTabId: "T9" };
const PREVIEW_PATH = `/files/preview/${"p".repeat(43)}/index.html`;

function setup(over: { locations?: Record<string, FileLocation | EngineRequestError>; engineUrl?: string | undefined; noLocal?: boolean; shown?: boolean; openFails?: EngineRequestError } = {}) {
  let now = 5_000;
  const log: unknown[][] = [];
  const locations = over.locations ?? {};
  let menuChoice: LinkMenuChoice | null = null;
  const request = async (method: string, params: { path: string }): Promise<unknown> => {
    log.push(["engine", method, params]);
    if (method === "files.locate") {
      const found = locations[params.path];
      if (found === undefined) throw new EngineRequestError("NOT_FOUND", "Dosya bulunamadı");
      if (found instanceof EngineRequestError) throw found;
      return found;
    }
    if (over.openFails) throw over.openFails;
    if (method === "browser.openFile" || method === "browser.openUrl") return { browser: STATE };
    if (method === "files.previewUrl") return { path: PREVIEW_PATH, single: false, expiresAt: "x" };
    throw new Error(`unexpected ${method}`);
  };
  const opener = createLinkOpener({
    client: { request: request as never },
    project: (id) => PROJECTS[id],
    engineOpen: {
      before: (projectId, url) => void log.push(["before", projectId, url]),
      after: (projectId, browser) => void log.push(["after", projectId, browser.activeTabId]),
    },
    links: {
      openExternal: async (url) => void log.push(["external", url]),
      menu: async (req: LinkMenuRequest | PathMenuRequest) => {
        log.push(["menu", req]);
        return menuChoice;
      },
    },
    openLocal: over.noLocal ? undefined : async (projectId, url) => void log.push(["local", projectId, url]),
    config: cfg,
    machineName: "Mac mini",
    now: () => now,
    showFile: (projectId, location) => {
      log.push(["files", projectId, location.rootPath, location.cardId]);
      return over.shown !== false;
    },
    engineUrl: () => ("engineUrl" in over ? over.engineUrl : "ws://100.64.0.7:7420"),
  });
  const paths = (projectId = "local", terminalId = "t1") => opener.forProject(projectId, { id: terminalId }).path!;
  return { opener, paths, log, advance: (ms: number) => (now += ms), choose: (c: LinkMenuChoice | null) => (menuChoice = c) };
}
const ref = (path: string, tail = "") => ({ path, tail });
const message = async (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "ok",
    (e: unknown) => (e as Error).message,
  );

describe("createLinkOpener: dosya yolları", () => {
  it("a host without a terminal has no path support", () => {
    const t = setup();
    expect(t.opener.forProject("local").path).toBeUndefined();
    expect(t.opener.forProject("local", { id: "t1" }).path).toBeDefined();
  });

  it("the user's case: the engine is asked what the path is, then to open it in the project's browser — the app never sees the address", async () => {
    const t = setup({ locations: { "~/Documents/Acme-ux-2026-11-05/index.html": PAGE_OUTSIDE } });
    await t.paths().open(ref("~/Documents/Acme-ux-2026-11-05/index.html"), "auto");
    expect(t.log).toEqual([
      ["engine", "files.locate", { terminalId: "t1", path: "~/Documents/Acme-ux-2026-11-05/index.html" }],
      ["before", "local", ""],
      ["engine", "browser.openFile", { terminalId: "t1", path: "~/Documents/Acme-ux-2026-11-05/index.html" }],
      ["after", "local", "T9"],
    ]);
  });

  it("what follows an unquoted path is sent along, to locate and to open", async () => {
    const t = setup({ locations: { "/Volumes/Main": PAGE_OUTSIDE } });
    await t.paths().open(ref("/Volumes/Main", " Disk/rapor/index.html yazıldı"), "auto");
    expect(t.log.filter((l) => l[0] === "engine").map((l) => l[2])).toEqual([
      { terminalId: "t1", path: "/Volumes/Main", tail: " Disk/rapor/index.html yazıldı" },
      { terminalId: "t1", path: "/Volumes/Main", tail: " Disk/rapor/index.html yazıldı" },
    ]);
  });

  it("a file of the project's folder is shown in Dosyalar; nothing is asked of the browser", async () => {
    const t = setup({ locations: { "src/a.ts": TEXT_INSIDE, "klip.mp4": VIDEO_INSIDE, "kart/a.ts": CARD_FILE } });
    await t.paths().open(ref("src/a.ts"), "auto");
    t.advance(200);
    await t.paths().open(ref("klip.mp4"), "auto");
    t.advance(200);
    await t.paths().open(ref("kart/a.ts"), "auto");
    expect(t.log.filter((l) => l[0] !== "engine" || l[1] !== "files.locate")).toEqual([
      ["files", "local", "src/a.ts", undefined],
      ["files", "local", "klip.mp4", undefined],
      ["files", "local", "src/a.ts", "c1"],
    ]);
  });

  it("media outside the project goes to the browser", async () => {
    const t = setup({ locations: { "~/Movies/klip.mp4": VIDEO_OUTSIDE } });
    await t.paths().open(ref("~/Movies/klip.mp4"), "auto");
    expect(t.log.map((l) => l[1])).toEqual(["files.locate", "local", "browser.openFile", "local"]);
  });

  it.each([
    ["a text file outside the project", TEXT_OUTSIDE, msg("links.text.pathMenuOnly")],
    ["a folder", DIR_INSIDE, msg("links.text.pathMenuOnly")],
    ["an unknown type outside", ZIP_OUTSIDE, msg("links.text.pathMenuOnly")],
    ["a refused folder", PAGE_REFUSED, "Gizli (noktayla başlayan) klasör ve dosyalar önizlenmez"],
  ])("a click on %s opens nothing and says why", async (_n, location, why) => {
    const t = setup({ locations: { x: location } });
    expect(await message(t.paths().open(ref("x"), "auto"))).toBe(why);
    expect(t.log.map((l) => l[1])).toEqual(["files.locate"]);
  });

  it("the menu's choices: a text file outside in the browser, a folder in Dosyalar — and never what the engine did not offer", async () => {
    const t = setup({ locations: { not: TEXT_OUTSIDE, klasor: DIR_INSIDE, gizli: PAGE_REFUSED, kaynak: TEXT_INSIDE } });
    await t.paths().open(ref("not"), "browser");
    t.advance(200);
    await t.paths().open(ref("klasor"), "files");
    expect(t.log.filter((l) => l[1] !== "files.locate").map((l) => l.slice(0, 3))).toEqual([
      ["before", "local", ""],
      ["engine", "browser.openFile", { terminalId: "t1", path: "not" }],
      ["after", "local", "T9"],
      ["files", "local", "src"],
    ]);
    // A forged or stale choice does not get past what the engine said.
    expect(await message(t.paths().open(ref("gizli"), "browser"))).toContain("Gizli");
    expect(await message(t.paths().open(ref("kaynak"), "browser"))).toBe(msg("links.text.pathMenuOnly"));
    expect(await message(t.paths().open(ref("not"), "files"))).toBe(msg("links.text.pathMenuOnly"));
    expect(t.log.filter((l) => l[1] === "browser.openFile")).toHaveLength(1);
  });

  it("a path that is not there: the engine's message, nothing opened", async () => {
    const t = setup();
    const p = t.paths();
    expect(await message(p.open(ref("~/yok/index.html"), "auto"))).toBe("Dosya bulunamadı");
    expect(await p.resolve(ref("~/yok/index.html"))).toEqual({ status: "failed", message: "Dosya bulunamadı" });
    expect(t.log.map((l) => l[1])).toEqual(["files.locate"]);
  });

  it("asks the engine once per path within the cache time — however often the pointer rests on it", async () => {
    const t = setup({ locations: { "a/b.html": PAGE_OUTSIDE } });
    const p = t.paths();
    expect(p.peek(ref("a/b.html"))).toBeUndefined();
    await Promise.all([p.resolve(ref("a/b.html")), p.resolve(ref("a/b.html")), p.resolve(ref("a/b.html"))]);
    expect(p.peek(ref("a/b.html"))).toEqual({ status: "found", location: PAGE_OUTSIDE });
    await p.resolve(ref("a/b.html"));
    expect(t.log).toHaveLength(1);
    // A different continuation is a different question.
    await p.resolve(ref("a/b.html", " c"));
    expect(t.log).toHaveLength(2);
    t.advance(cfg.pathCacheMs + 1);
    expect(p.peek(ref("a/b.html"))).toBeUndefined();
    await p.resolve(ref("a/b.html"));
    expect(t.log).toHaveLength(3);
    // Another terminal asks for itself: the same words may mean another file there.
    await t.paths("local", "t2").resolve(ref("a/b.html"));
    expect(t.log.at(-1)).toEqual(["engine", "files.locate", { terminalId: "t2", path: "a/b.html" }]);
  });

  it("browser on this machine: the engine gives a preview address, joined to the engine the app is connected to", async () => {
    const t = setup({ locations: { "~/rapor/index.html": PAGE_OUTSIDE } });
    await t.paths("client").open(ref("~/rapor/index.html"), "auto");
    expect(t.log).toEqual([
      ["engine", "files.locate", { terminalId: "t1", path: "~/rapor/index.html" }],
      ["engine", "files.previewUrl", { terminalId: "t1", path: "~/rapor/index.html" }],
      ["local", "client", `http://100.64.0.7:7420${PREVIEW_PATH}`],
    ]);
  });

  it("browser on this machine without a known engine address or a local browser: a message, nothing opened", async () => {
    const noAddress = setup({ locations: { x: PAGE_OUTSIDE }, engineUrl: undefined });
    expect(await message(noAddress.paths("client").open(ref("x"), "auto"))).toBe(msg("links.text.pathNoEngineAddress"));
    const noLocal = setup({ locations: { x: PAGE_OUTSIDE }, noLocal: true });
    expect(await message(noLocal.paths("client").open(ref("x"), "auto"))).toBe(msg("links.text.noLocal"));
    expect(noLocal.log.map((l) => l[1])).toEqual(["files.locate"]);
  });

  it.each(["ssh", "silinmis"])("%s project: the file is not on a machine Kokpit reads — the engine is not asked at all", async (projectId) => {
    const t = setup({ locations: { "~/rapor/index.html": PAGE_OUTSIDE } });
    const p = t.paths(projectId);
    expect(await p.resolve(ref("~/rapor/index.html"))).toEqual({ status: "failed", message: msg("links.text.pathRemote") });
    expect(await message(p.open(ref("~/rapor/index.html"), "auto"))).toBe(msg("links.text.pathRemote"));
    expect(await message(p.open(ref("~/rapor/index.html"), "browser"))).toBe(msg("links.text.pathRemote"));
    t.choose("copy");
    await p.menu(ref("~/rapor/index.html"));
    expect(t.log).toEqual([["menu", { path: "~/rapor/index.html", browser: false, files: false }]]);
  });

  it("the menu shows the file's real place and only what the engine offers", async () => {
    const t = setup({ locations: { "dist/index.html": PAGE_INSIDE, "~/arsiv.zip": ZIP_OUTSIDE } });
    t.choose("files");
    expect(await t.paths().menu(ref("dist/index.html"))).toBe("files");
    await t.paths().menu(ref("~/arsiv.zip"));
    await t.paths().menu(ref("~/yok"));
    expect(t.log.filter((l) => l[0] === "menu").map((l) => l[1])).toEqual([
      { path: "/p/dist/index.html", browser: true, files: true },
      { path: "/Users/ada/arsiv.zip", browser: false, files: false },
      { path: "~/yok", browser: false, files: false },
    ]);
  });

  it("a file of a project that is not on screen is not shown in another project's Dosyalar", async () => {
    const t = setup({ locations: { "src/a.ts": TEXT_INSIDE }, shown: false });
    expect(await message(t.paths().open(ref("src/a.ts"), "auto"))).toBe(msg("links.text.pathOtherProject"));
  });

  it("the engine's refusal at open time is shown; opens share the links' rate limit", async () => {
    const refused = setup({ locations: { x: PAGE_OUTSIDE }, openFails: new EngineRequestError("INVALID", "Çok sık önizleme açıldı; biraz sonra yeniden deneyin") });
    expect(await message(refused.paths().open(ref("x"), "auto"))).toBe("Dosya açılamadı: Çok sık önizleme açıldı; biraz sonra yeniden deneyin");
    expect(refused.log.some((l) => l[0] === "after")).toBe(false);

    const t = setup({ locations: { x: PAGE_OUTSIDE } });
    await t.paths().open(ref("x"), "auto");
    // A double click is one open.
    expect(await message(t.paths().open(ref("x"), "auto"))).toBe(msg("links.text.rateLimited"));
    t.advance(200);
    await t.paths().open(ref("x"), "auto");
    t.advance(200);
    await t.opener.forProject("local").open("http://localhost:3000/", "project");
    t.advance(200);
    expect(await message(t.paths().open(ref("x"), "auto"))).toBe(msg("links.text.rateLimited"));
  });
});
