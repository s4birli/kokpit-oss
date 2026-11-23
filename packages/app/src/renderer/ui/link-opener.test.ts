// Bağlantılar: a gesture on a link → where it opens, per project kind. The engine, the local Chrome and the default
// browser are fakes; nothing is opened for real.
import type { BrowserState, Project } from "@kokpit/shared";
import { t as msg } from "../../i18n/index.ts";
import { describe, expect, it, vi } from "vitest";
import { linksConfig, type LinkMenuChoice, type LinkMenuRequest, type LinksConfig } from "../engine/links-ipc.ts";
import { EngineRequestError } from "../engine/types.ts";
import { createLinkOpener } from "./link-opener.ts";

const cfg: LinksConfig = { ...linksConfig, rate: { max: 3, windowMs: 10_000, minIntervalMs: 100 } };
const PROJECTS: Record<string, Project> = {
  local: { id: "local", name: "Yerel", location: { kind: "local", path: "/x" } },
  client: { id: "client", name: "İstemci", location: { kind: "local", path: "/x" }, browser: { runOn: "client" } },
  ssh: { id: "ssh", name: "Uzak", location: { kind: "ssh", hostId: "h" } },
};
const STATE: BrowserState = { running: true, tabs: [{ id: "T9", title: "", url: "https://example.com/a" }], activeTabId: "T9" };

function setup(over: { noLinks?: boolean; noLocal?: boolean; projects?: Record<string, Project> } = {}) {
  let now = 5_000;
  const log: unknown[][] = [];
  const projects = { ...(over.projects ?? PROJECTS) };
  let menuChoice: LinkMenuChoice | null = null;
  const request = vi.fn(async (method: string, params: unknown) => {
    log.push(["engine", method, params]);
    return { browser: STATE };
  });
  const opener = createLinkOpener({
    client: { request: request as never },
    project: (id) => projects[id],
    engineOpen: {
      before: (projectId, url) => void log.push(["before", projectId, url]),
      after: (projectId, browser) => void log.push(["after", projectId, browser.activeTabId]),
    },
    links: over.noLinks
      ? undefined
      : {
          openExternal: async (url) => void log.push(["external", url]),
          menu: async (req: LinkMenuRequest) => {
            log.push(["menu", req]);
            return menuChoice;
          },
        },
    openLocal: over.noLocal ? undefined : async (projectId, url) => void log.push(["local", projectId, url]),
    config: cfg,
    machineName: "Mac mini",
    now: () => now,
  });
  return { opener, log, request, projects, advance: (ms: number) => (now += ms), choose: (c: LinkMenuChoice | null) => (menuChoice = c) };
}

describe("createLinkOpener: where a link opens", () => {
  it("engine browser: asks the engine for the terminal's project, with the normalized address; the panel is told before and after", async () => {
    const t = setup();
    await t.opener.forProject("local").open("HTTP://LocalHost:3000/a?b=1", "project");
    expect(t.log).toEqual([
      ["before", "local", "http://localhost:3000/a?b=1"],
      ["engine", "browser.openUrl", { projectId: "local", url: "http://localhost:3000/a?b=1" }],
      ["after", "local", "T9"],
    ]);
  });

  it("browser on this machine: the project's local profile Chrome gets the address; the engine is not asked", async () => {
    const t = setup();
    await t.opener.forProject("client").open("https://example.com/a", "project");
    expect(t.log).toEqual([["local", "client", "https://example.com/a"]]);
  });

  it.each(["ssh", "silinmis"])("%s project: the default browser", async (id) => {
    const t = setup();
    await t.opener.forProject(id).open("https://example.com/a", "project");
    expect(t.log).toEqual([["external", "https://example.com/a"]]);
  });

  it.each(["local", "client", "ssh"])("the escape hatch (⌥⌘ click, the menu) is the default browser for a %s project too", async (id) => {
    const t = setup();
    await t.opener.forProject(id).open("https://example.com/a", "external");
    expect(t.log).toEqual([["external", "https://example.com/a"]]);
  });

  it("the project is looked up when the link is opened, not when the terminal was created", async () => {
    const t = setup();
    const host = t.opener.forProject("local");
    expect(host.destination()).toBe("engine");
    t.projects.local = { ...PROJECTS.local!, browser: { runOn: "client" } };
    expect(host.destination()).toBe("client");
    await host.open("https://example.com/a", "project");
    expect(t.log).toEqual([["local", "local", "https://example.com/a"]]);
  });

  it("reports the engine machine's name for the tooltip", () => {
    expect(setup().opener.forProject("local").machineName()).toBe("Mac mini");
  });
});

describe("createLinkOpener: what is never opened", () => {
  it.each([
    "javascript:alert(1)",
    "file:///etc/passwd",
    "vscode://file/x",
    "mailto:a@example.com",
    "kokpit-test-scheme://calistir",
    "about:blank",
    "chrome://settings",
    "data:text/html,x",
    "https://user:pw@example.com/",
    "https://example.com/\u0000",
    "example.com",
    "",
  ])("%j: refused for every destination, nothing is asked of anyone", async (raw) => {
    const t = setup();
    for (const id of ["local", "client", "ssh"]) {
      await expect(t.opener.forProject(id).open(raw, "project")).rejects.toThrow();
      await expect(t.opener.forProject(id).open(raw, "external")).rejects.toThrow();
    }
    expect(t.log).toEqual([]);
  });

  it("refusals say why, in Turkish", async () => {
    const t = setup();
    await expect(t.opener.forProject("local").open("vscode://file/x", "project")).rejects.toThrow("Bu tür bağlantı açılmaz (vscode:)");
    await expect(t.opener.forProject("local").open("file:///tmp/a", "project")).rejects.toThrow(msg("links.text.refusedFile"));
    await expect(t.opener.forProject("local").open("https://u:p@example.com/", "project")).rejects.toThrow(msg("links.text.refusedInvalid"));
  });
});

describe("createLinkOpener: limits and failures", () => {
  it("opens are rate-limited across all terminals of the window; refused links do not count", async () => {
    const t = setup();
    for (let i = 0; i < 10; i++) await expect(t.opener.forProject("local").open("javascript:1", "project")).rejects.toThrow();
    await t.opener.forProject("local").open("https://example.com/1", "project");
    await expect(t.opener.forProject("ssh").open("https://example.com/2", "project")).rejects.toThrow(msg("links.text.rateLimited"));
    t.advance(100);
    await t.opener.forProject("client").open("https://example.com/3", "project");
    t.advance(100);
    await t.opener.forProject("ssh").open("https://example.com/4", "external");
    t.advance(100);
    await expect(t.opener.forProject("local").open("https://example.com/5", "project")).rejects.toThrow(msg("links.text.rateLimited"));
    t.advance(cfg.rate.windowMs);
    await t.opener.forProject("local").open("https://example.com/6", "project");
    expect(t.request).toHaveBeenCalledTimes(2);
  });

  it("an engine refusal is reported with its reason; the panel is not revealed", async () => {
    const t = setup();
    t.request.mockRejectedValueOnce(new EngineRequestError("INVALID", "En fazla 50 sekme açılabilir"));
    await expect(t.opener.forProject("local").open("https://example.com/a", "project")).rejects.toThrow("Bağlantı açılamadı: En fazla 50 sekme açılabilir");
    expect(t.log.map((l) => l[0])).toEqual(["before"]);
  });

  it("outside Electron (no bridges) it says what is missing instead of failing silently", async () => {
    const t = setup({ noLinks: true, noLocal: true });
    await expect(t.opener.forProject("ssh").open("https://example.com/a", "project")).rejects.toThrow(msg("links.text.noExternal"));
    t.advance(1000);
    await expect(t.opener.forProject("client").open("https://example.com/a", "project")).rejects.toThrow(msg("links.text.noLocal"));
    expect(await t.opener.forProject("local").menu("https://example.com/a")).toBeNull();
  });
});

describe("createLinkOpener: the right-click menu", () => {
  it("asks main for the menu; “Tarayıcıda aç” is offered where the project has a browser of its own", async () => {
    const t = setup();
    t.choose("browser");
    expect(await t.opener.forProject("local").menu("https://example.com/a")).toBe("browser");
    expect(await t.opener.forProject("client").menu("https://example.com/a")).toBe("browser");
    await t.opener.forProject("ssh").menu("https://example.com/a");
    await t.opener.forProject("silinmis").menu("vscode://x");
    expect(t.log).toEqual([
      ["menu", { url: "https://example.com/a", browser: true }],
      ["menu", { url: "https://example.com/a", browser: true }],
      ["menu", { url: "https://example.com/a", browser: false }],
      ["menu", { url: "vscode://x", browser: false }],
    ]);
  });

  it("the menu itself opens nothing", async () => {
    const t = setup();
    t.choose("external");
    await t.opener.forProject("local").menu("https://example.com/a");
    expect(t.log.filter((l) => l[0] !== "menu")).toEqual([]);
  });
});
