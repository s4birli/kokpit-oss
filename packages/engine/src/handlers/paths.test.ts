// Yollar: whose path it is (a terminal, a card, a project) decides where it is looked for and what it opens into;
// files.locate / files.previewUrl / browser.openFile on top of it. Real files in a temp HOME, fake projects.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FILES_PREVIEW_HTTP_PREFIX, type BrowserState, type Card, type Project, type TerminalInfo } from "@kokpit/shared";
import type { BrowserManager } from "../browser.ts";
import { EngineError } from "../contracts.ts";
import { createFileService, loadFilesConfig } from "../files.ts";
import { createMediaService } from "../files-media.ts";
import { createPreviewService, type PreviewService } from "../files-preview.ts";
import { createPathLocator } from "../local-paths.ts";
import { FakeLogger } from "../../test/fakes/server-fakes.ts";
import { createBrowserHandlers } from "./browser.ts";
import { createFilesHandlers } from "./files.ts";
import { createPathActions, type PathActions } from "./paths.ts";

const cfg = loadFilesConfig({});
let base: string;
let home: string;
let root: string;
let cardRoot: string;
let preview: PreviewService;
let actions: PathActions;
let logger: FakeLogger;
let listening = true;
/** terminalId → the directory its shell is in. */
const cwds = new Map<string, string>();
const cwdCalls: number[] = [];

const projects: Record<string, Project> = {};
const cards: Record<string, Card> = {};
const terminals: Record<string, TerminalInfo> = {};

const write = (path: string, content = "<!doctype html>"): string => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
};
async function failure(work: Promise<unknown> | (() => unknown)): Promise<{ code: string; message: string } | "ok"> {
  try {
    await (typeof work === "function" ? work() : work);
  } catch (e) {
    if (e instanceof EngineError) return { code: e.code, message: e.message };
    throw e;
  }
  return "ok";
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-path-actions-")));
  home = join(base, "home");
  root = join(base, "proje");
  cardRoot = join(base, "kart");
  write(join(home, "Documents", "rapor", "index.html"));
  write(join(home, ".ssh", "a.html"));
  write(join(root, "dist", "index.html"));
  write(join(root, "src", "a.ts"), "x");
  write(join(cardRoot, "dist", "index.html"));
  write(join(cardRoot, "yalniz-kartta.html"));
  Object.assign(projects, {
    p1: { id: "p1", name: "Yerel", location: { kind: "local", path: root } },
    istemci: { id: "istemci", name: "İstemci", location: { kind: "local", path: root }, browser: { runOn: "client" } },
    uzak: { id: "uzak", name: "SSH", location: { kind: "ssh", hostId: "h", path: "/srv" } },
  } satisfies Record<string, Project>);
  cards.c1 = { id: "c1", projectId: "p1", name: "Kart", branch: "kokpit/kart", worktreePath: cardRoot, createdAt: "2026-11-18T00:00:00.000Z" };
  const term = (id: string, projectId: string, cardId?: string): TerminalInfo => ({ id, projectId, ...(cardId ? { cardId } : {}), title: "sh", status: "running", createdAt: "2026-11-18T00:00:00.000Z" });
  Object.assign(terminals, { t1: term("t1", "p1"), tk: term("tk", "p1", "c1"), tu: term("tu", "uzak"), ti: term("ti", "istemci"), bitmis: term("bitmis", "p1") });
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

beforeEach(() => {
  logger = new FakeLogger();
  listening = true;
  cwds.clear();
  cwdCalls.length = 0;
  const files = createFileService({ config: cfg });
  const media = createMediaService({ config: cfg.media, resolve: files.resolve, logger });
  preview = createPreviewService({ config: cfg.preview, homeDir: home, logger });
  actions = createPathActions({
    locator: createPathLocator({ config: cfg.paths, homeDir: home, resolveInRoot: files.resolve, mediaKindOf: media.kindOf, preview }),
    preview,
    cwd: {
      cwdOf: async (pid) => {
        cwdCalls.push(pid);
        return cwds.get(`pid:${pid}`);
      },
    },
    requireProject: (id) => {
      const p = projects[id];
      if (!p) throw new EngineError("NOT_FOUND", `project ${id} not found`);
      return p;
    },
    requireCard: (id) => {
      const c = cards[id];
      if (!c) throw new EngineError("NOT_FOUND", `card ${id} not found`);
      return c;
    },
    terminal: (id) => terminals[id],
    // The shell of terminal "tN" has pid N-ish; an exited one has none.
    terminalPid: (id) => ({ t1: 101, tk: 102, tu: 103, ti: 104 })[id],
    localAddress: () => (listening ? { host: "127.0.0.1", port: 7777 } : undefined),
  });
});

describe("yolun sahibi", () => {
  it("a terminal: its project, and its shell's current directory for relative paths", async () => {
    cwds.set("pid:101", join(home, "Documents"));
    const { project, location } = await actions.locate({ terminalId: "t1", path: "rapor/index.html" });
    expect(project.id).toBe("p1");
    expect(location).toEqual({ path: join(home, "Documents", "rapor", "index.html"), kind: "page", browser: true });
    expect(cwdCalls).toEqual([101]);
    // Not there: the project's folder is tried next.
    expect((await actions.locate({ terminalId: "t1", path: "dist/index.html" })).location.rootPath).toBe("dist/index.html");
  });

  it("a card's terminal resolves in the card's folder and says so; the project's folder is still the user's", async () => {
    const { location } = await actions.locate({ terminalId: "tk", path: "yalniz-kartta.html" });
    expect(location).toEqual({ path: join(cardRoot, "yalniz-kartta.html"), kind: "page", rootPath: "yalniz-kartta.html", cardId: "c1", browser: true });
    expect((await actions.locate({ cardId: "c1", path: "dist/index.html" })).location.path).toBe(join(cardRoot, "dist", "index.html"));
    // A file of the project (not of the card) is a page for the card's terminal too, just not in its Dosyalar.
    const other = (await actions.locate({ terminalId: "tk", path: join(root, "dist", "index.html") })).location;
    expect(other).toEqual({ path: join(root, "dist", "index.html"), kind: "page", browser: true });
  });

  it("an exited terminal has no current directory: its folder is used, nothing is asked", async () => {
    expect((await actions.locate({ terminalId: "bitmis", path: "src/a.ts" })).location.rootPath).toBe("src/a.ts");
    expect(cwdCalls).toEqual([]);
    expect((await actions.locate({ projectId: "p1", path: "src/a.ts" })).location.rootPath).toBe("src/a.ts");
    expect(cwdCalls).toEqual([]);
  });

  it("SSH projects are refused before anything is looked up: the file is not on this machine", async () => {
    expect(await failure(actions.locate({ terminalId: "tu", path: "/etc/hosts" }))).toMatchObject({ code: "INVALID", message: expect.stringContaining("uzak sunucuda") });
    expect(await failure(actions.locate({ projectId: "uzak", path: "~/Documents/rapor/index.html" }))).toMatchObject({ code: "INVALID" });
    expect(cwdCalls).toEqual([]);
  });

  it("unknown terminal, card or project → NOT_FOUND", async () => {
    for (const ref of [{ terminalId: "yok" }, { cardId: "yok" }, { projectId: "yok" }]) {
      expect(await failure(actions.locate({ ...ref, path: "a.html" })), JSON.stringify(ref)).toMatchObject({ code: "NOT_FOUND" });
    }
  });
});

describe("önizleme adresi", () => {
  it("previewUrl gives a path for the app to join to the engine it is connected to (browser on the app's machine)", async () => {
    const url = await actions.previewUrl({ terminalId: "ti", path: "~/Documents/rapor/index.html" });
    expect(url.path).toMatch(new RegExp(`^${FILES_PREVIEW_HTTP_PREFIX}[A-Za-z0-9_-]{43}/index\\.html$`));
    expect(url.single).toBe(false);
    expect(Object.keys(url).sort()).toEqual(["expiresAt", "path", "single"]);
    actions.revoke(url.path);
    expect(preview.stats().tokens).toBe(0);
  });

  it("engineUrl is a full address of this machine's listener; refused for a browser that runs elsewhere", async () => {
    const { projectId, url } = await actions.engineUrl({ terminalId: "t1", path: "~/Documents/rapor/index.html" });
    expect(projectId).toBe("p1");
    expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:7777${FILES_PREVIEW_HTTP_PREFIX}[A-Za-z0-9_-]{43}/index\\.html$`));
    preview.stop();
    expect(await failure(actions.engineUrl({ terminalId: "ti", path: "~/Documents/rapor/index.html" }))).toMatchObject({ code: "INVALID", message: expect.stringContaining("uygulamanın çalıştığı bilgisayarda") });
    listening = false;
    expect(await failure(actions.engineUrl({ terminalId: "t1", path: "~/Documents/rapor/index.html" }))).toMatchObject({ code: "INVALID" });
    // Nothing was issued for a refusal.
    expect(preview.stats().tokens).toBe(0);
  });

  it("a refused folder, a type that is not served and a missing file issue nothing", async () => {
    expect(await failure(actions.previewUrl({ projectId: "p1", path: "~/.ssh/a.html" }))).toMatchObject({ code: "INVALID", message: expect.stringContaining("Gizli") });
    expect(await failure(actions.previewUrl({ projectId: "p1", path: "src/a.ts" }))).toMatchObject({ code: "INVALID", message: expect.stringContaining("önizlenemez") });
    expect(await failure(actions.previewUrl({ projectId: "p1", path: "src" }))).toMatchObject({ code: "INVALID" });
    expect(await failure(actions.previewUrl({ projectId: "p1", path: "yok.html" }))).toMatchObject({ code: "NOT_FOUND" });
    expect(preview.stats().tokens).toBe(0);
  });
});

describe("istekler", () => {
  const ctx = { conn: {} };
  function fakeBrowsers(): { manager: BrowserManager; opened: [string, string][] } {
    const opened: [string, string][] = [];
    const state: BrowserState = { running: true, tabs: [{ id: "tab-1", title: "", url: "about:blank" }], activeTabId: "tab-1" };
    const manager = {
      onChange: () => () => {},
      isViewportOwner: () => false,
      openUrl: async (projectId: string, url: string) => {
        opened.push([projectId, url]);
        return state;
      },
    } as unknown as BrowserManager;
    return { manager, opened };
  }
  const browserHandlers = (browsers: BrowserManager | undefined, withPaths = true) =>
    createBrowserHandlers({
      browsers,
      requireProject: (id) => projects[id]!,
      send: () => {},
      broadcast: () => {},
      logger,
      startCommands: [],
      fileUrl: withPaths ? (ref) => actions.engineUrl(ref) : undefined,
    });

  it("browser.openFile opens the preview address in the terminal's project and logs no address", async () => {
    const { manager, opened } = fakeBrowsers();
    const r = await browserHandlers(manager).requests["browser.openFile"](ctx, { terminalId: "t1", path: "~/Documents/rapor/index.html" });
    expect(r.browser.running).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0]![0]).toBe("p1");
    expect(opened[0]![1]).toMatch(/^http:\/\/127\.0\.0\.1:7777\/files\/preview\/[A-Za-z0-9_-]{43}\/index\.html$/);
    const token = /preview\/([^/]+)\//.exec(opened[0]![1])![1]!;
    expect(logger.dump()).toContain("browser file opened");
    expect(logger.dump()).not.toContain(token);
    expect(logger.dump()).not.toContain("Documents");
  });

  it("browser.openFile opens nothing for a refusal, a client-run browser, or an engine without a browser", async () => {
    const { manager, opened } = fakeBrowsers();
    const h = browserHandlers(manager).requests["browser.openFile"];
    expect(await failure(async () => h(ctx, { terminalId: "t1", path: "~/.ssh/a.html" }))).toMatchObject({ code: "INVALID" });
    expect(await failure(async () => h(ctx, { terminalId: "ti", path: "~/Documents/rapor/index.html" }))).toMatchObject({ code: "INVALID" });
    expect(await failure(async () => h(ctx, { terminalId: "tu", path: "~/Documents/rapor/index.html" }))).toMatchObject({ code: "INVALID" });
    expect(await failure(async () => h(ctx, { terminalId: "t1", path: "~/Documents/yok.html" }))).toMatchObject({ code: "NOT_FOUND" });
    expect(opened).toEqual([]);
    expect(await failure(async () => browserHandlers(undefined).requests["browser.openFile"](ctx, { terminalId: "t1", path: "~/Documents/rapor/index.html" }))).toMatchObject({ code: "INVALID" });
    expect(await failure(async () => browserHandlers(manager, false).requests["browser.openFile"](ctx, { terminalId: "t1", path: "~/Documents/rapor/index.html" }))).toMatchObject({ code: "INVALID" });
    expect(preview.stats().tokens).toBe(0);
  });

  it("files.locate / files.previewUrl / files.previewRevoke answer through the same rules; INVALID without the feature", async () => {
    const deps = { files: createFileService({ config: cfg }), requireProject: (id: string) => projects[id]!, requireCard: (id: string) => cards[id]! };
    const on = createFilesHandlers({ ...deps, paths: actions });
    expect(await on["files.locate"](ctx, { terminalId: "t1", path: "~/Documents/rapor/index.html" })).toEqual({ path: join(home, "Documents", "rapor", "index.html"), kind: "page", browser: true });
    const url = await on["files.previewUrl"](ctx, { projectId: "istemci", path: "~/Documents/rapor/index.html" });
    expect(preview.stats().tokens).toBe(1);
    expect(on["files.previewRevoke"](ctx, { path: url.path })).toEqual({});
    expect(preview.stats().tokens).toBe(0);
    const off = createFilesHandlers(deps);
    expect(await failure(async () => off["files.locate"](ctx, { terminalId: "t1", path: "a" }))).toMatchObject({ code: "INVALID" });
    expect(await failure(async () => off["files.previewUrl"](ctx, { terminalId: "t1", path: "a" }))).toMatchObject({ code: "INVALID" });
    expect(off["files.previewRevoke"](ctx, { path: url.path })).toEqual({});
  });
});
