// Adım 2: project view (cardless terminals), tool picker, SSH projects, reload events.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workbench, type WorkbenchProps } from "./Workbench.tsx";
import { defaultUiConfig } from "./config.ts";
import {
  FakeEngineClient,
  makeCard,
  makeHost,
  makeProject,
  makeProjectTerminal,
  makeSshProject,
  makeTerminal,
  makeTool,
} from "./test-utils/fake-client.ts";
import { FakeResizeObserver, makeFakeViewFactory } from "./test-utils/fake-view.ts";
import { launcherToolSelect, launchTerminal, showTerminal, terminalTabTitles } from "./test-utils/terminal-tabs.ts";

const flush = () => act(async () => {});
const dims = defaultUiConfig.fallbackDims;

function seed() {
  return new FakeEngineClient({
    projects: [
      makeProject("p1", "Alfa", { defaultToolId: "t2" }),
      makeSshProject("p3", "Uzak", "h1", "/srv/app"),
      makeProject("home", "Ev", { builtin: true, location: { kind: "local", path: "/Users/u" } }),
      makeProject("p2", "Beta", { location: { kind: "github", url: "https://github.com/o/beta", path: "/data/repos/p2" } }),
    ],
    cards: [makeCard("a", "p1", "Kart A"), makeCard("c", "p2", "Kart C")],
    terminals: [
      makeTerminal("ta1", "a", "A-1", "p1"),
      makeProjectTerminal("tp1", "p1", "P-1"),
      makeProjectTerminal("tp2", "p1", "P-2"),
      makeProjectTerminal("tq1", "p2", "Q-1"),
    ],
    hosts: [makeHost("h1", "oracle")],
    tools: [makeTool("t1", "Birinci"), makeTool("t2", "İkinci")],
  });
}

async function setup(client = seed(), props: Partial<WorkbenchProps> = {}) {
  const views = makeFakeViewFactory();
  const utils = render(<Workbench client={client} onOpenSettings={() => {}} createView={views.factory} {...props} />);
  await flush();
  return { client, views, ...utils };
}

const rail = () => screen.getByRole("navigation");
const main = () => screen.getByRole("main");
async function click(name: string) {
  fireEvent.click(within(rail()).getByRole("button", { name }));
  await flush();
}
// Terminals are opened from the Terminal panel's launcher only.
const toolSelect = launcherToolSelect;
const newTerminal = launchTerminal;
/** The project's tab above the work area; its tooltip is the project's location. */
const projectTab = (name: string) => within(screen.getByRole("toolbar", { name: "Proje sekmeleri" })).getByRole("button", { name });

beforeEach(() => {
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Workbench projects", () => {
  it("lists the built-in project first", async () => {
    await setup();
    const names = Array.from(rail().querySelectorAll(".kp-project__name")).map((b) => b.textContent);
    expect(names).toEqual(["Ev", "Alfa", "Uzak", "Beta"]);
  });

  it("clicking a project shows its cardless terminals; no header row, the location is the tab's tooltip", async () => {
    const { client } = await setup();
    await click("Alfa");
    expect(within(rail()).getByRole("button", { name: "Alfa" }).getAttribute("aria-current")).toBe("true");
    // The name stays for assistive tech only; nothing else sits between the tabs and the dock.
    expect(within(main()).getByRole("heading", { name: "Alfa" }).classList.contains("kp-visually-hidden")).toBe(true);
    expect(document.querySelector(".kp-header")).toBeNull();
    expect(document.querySelector(".kp-topbar")?.nextElementSibling?.classList.contains("kp-visually-hidden")).toBe(true);
    expect(projectTab("Alfa").getAttribute("title")).toBe(`${defaultUiConfig.machineName}: /repos/p1`);
    expect(within(main()).queryByText(/\/repos\/p1/)).toBeNull();
    expect(client.callsOf("terminals.list")).toEqual([{ projectId: "p1" }]);
    expect(terminalTabTitles()).toEqual(["P-1", "P-2"]);
    expect(screen.getByRole("region", { name: "Terminal: P-1" })).toBeTruthy();
    await showTerminal("P-2");
    expect(screen.getByRole("region", { name: "Terminal: P-2" })).toBeTruthy();
    expect(document.querySelector('[data-terminal-id="ta1"]')).toBeNull();
  });

  it("shows GitHub and SSH locations", async () => {
    await setup();
    await click("Beta");
    expect(projectTab("Beta").getAttribute("title")).toBe("GitHub: https://github.com/o/beta");
    await click("Uzak");
    expect(projectTab("Uzak").getAttribute("title")).toBe("SSH: oracle:/srv/app");
  });

  it("switching from a card to a project and back swaps the panels", async () => {
    await setup();
    await click("Kart A");
    expect(screen.getByRole("region", { name: "Terminal: A-1" })).toBeTruthy();
    await click("Alfa");
    expect(screen.queryByRole("region", { name: "Terminal: A-1" })).toBeNull();
    expect(screen.getByRole("region", { name: "Terminal: P-1" })).toBeTruthy();
    expect(within(rail()).getByRole("button", { name: "Kart A" }).getAttribute("aria-current")).toBeNull();
  });

  it("tool picker preselects the project's default tool and sends it", async () => {
    const { client } = await setup();
    await click("Alfa");
    const options = Array.from(toolSelect().options).map((o) => o.textContent);
    expect(options).toEqual(["Yalnız kabuk", "Birinci", "İkinci"]);
    expect(toolSelect().value).toBe("t2");
    await newTerminal();
    expect(client.callsOf("terminal.open").at(-1)).toEqual({ projectId: "p1", ...dims, toolId: "t2" });
    expect(screen.getByRole("region", { name: "Terminal: t2-komutu" })).toBeTruthy();
  });

  it("explicit tool, 'Yalnız kabuk' and a command override", async () => {
    const { client } = await setup();
    await click("Alfa");
    fireEvent.change(toolSelect(), { target: { value: "t1" } });
    await newTerminal();
    fireEvent.change(toolSelect(), { target: { value: "" } });
    await newTerminal();
    fireEvent.change(toolSelect(), { target: { value: "t1" } });
    await newTerminal("  benim --x ");
    const opens = client.callsOf("terminal.open");
    expect(opens[0]).toEqual({ projectId: "p1", ...dims, toolId: "t1" });
    // "Yalnız kabuk" asks for a plain shell explicitly, so no default applies on the engine.
    expect(opens[1]).toEqual({ projectId: "p1", ...dims, toolId: null });
    expect(opens[2]).toEqual({ projectId: "p1", ...dims, command: "benim --x" });
  });

  it("a project without a default tool and no global default starts with 'Yalnız kabuk'", async () => {
    const { client } = await setup();
    await click("Beta");
    expect(toolSelect().value).toBe("");
    await newTerminal();
    expect(client.callsOf("terminal.open").at(-1)).toEqual({ projectId: "p2", ...dims, toolId: null });
  });

  it("a project without a default tool preselects the global default", async () => {
    const client = seed();
    client.settings = { defaultToolId: "t1" };
    await setup(client);
    await click("Beta");
    expect(toolSelect().value).toBe("t1");
    await newTerminal();
    expect(client.callsOf("terminal.open").at(-1)).toEqual({ projectId: "p2", ...dims, toolId: "t1" });
    await click("Alfa");
    expect(toolSelect().value).toBe("t2"); // the project's own default wins
  });

  it("a project whose default tool is gone falls back to the global default", async () => {
    const client = seed();
    client.settings = { defaultToolId: "t1" };
    client.projects[0] = makeProject("p1", "Alfa", { defaultToolId: "silinmis" });
    await setup(client);
    await click("Alfa");
    expect(toolSelect().value).toBe("t1");
  });

  it("settings.changed reloads the preselected global default", async () => {
    const { client } = await setup();
    await click("Beta");
    expect(toolSelect().value).toBe("");
    client.settings = { defaultToolId: "t2" };
    act(() => client.emitEvent({ type: "event", name: "settings.changed" }));
    await flush();
    expect(toolSelect().value).toBe("t2");
  });

  it("card header preselects the global default when the project has none", async () => {
    const client = seed();
    client.settings = { defaultToolId: "t1" };
    await setup(client);
    await click("Kart C");
    expect(toolSelect().value).toBe("t1");
  });

  it("card header has the same picker with the project's default tool", async () => {
    const { client } = await setup();
    await click("Kart A");
    expect(toolSelect().value).toBe("t2");
    await newTerminal();
    expect(client.callsOf("terminal.open").at(-1)).toEqual({ cardId: "a", ...dims, toolId: "t2" });
  });

  it("SSH projects have no cards and no 'Yeni kart'", async () => {
    const { client } = await setup();
    const uzak = within(rail()).getByRole("group", { name: "Uzak" });
    expect(within(uzak).queryByRole("button", { name: /Yeni kart/ })).toBeNull();
    expect(within(rail()).getByRole("button", { name: "Yeni kart: Alfa" })).toBeTruthy();
    expect(within(rail()).getByRole("button", { name: "Yeni kart: Beta" })).toBeTruthy();
    expect(client.callsOf("cards.list").map((p) => p.projectId)).not.toContain("p3");
  });

  it("the built-in project (home folder, not a repo) has no 'Yeni kart'", async () => {
    const { client } = await setup();
    const ev = within(rail()).getByRole("group", { name: "Ev" });
    expect(within(ev).queryByRole("button", { name: /Yeni kart/ })).toBeNull();
    expect(client.callsOf("cards.list").map((p) => p.projectId)).not.toContain("home");
  });

  it("projects.changed reloads the projects", async () => {
    const { client } = await setup();
    client.projects.push(makeProject("p9", "Yeni proje"));
    act(() => client.emitEvent({ type: "event", name: "projects.changed" }));
    await flush();
    expect(within(rail()).getByRole("button", { name: "Yeni proje" })).toBeTruthy();
  });

  it("tools.changed reloads the tool picker", async () => {
    const { client } = await setup();
    await click("Alfa");
    client.tools.push(makeTool("t3", "Üçüncü"));
    act(() => client.emitEvent({ type: "event", name: "tools.changed" }));
    await flush();
    expect(Array.from(toolSelect().options).map((o) => o.textContent)).toContain("Üçüncü");
  });

  it("sshHosts.changed refreshes the SSH location line", async () => {
    const { client } = await setup();
    await click("Uzak");
    client.hosts[0]!.name = "yeni-ad";
    act(() => client.emitEvent({ type: "event", name: "sshHosts.changed" }));
    await flush();
    expect(projectTab("Uzak").getAttribute("title")).toBe("SSH: yeni-ad:/srv/app");
  });

  it("terminals.changed reloads only the matching project list", async () => {
    const { client } = await setup();
    await click("Alfa");
    client.terminals.push(makeProjectTerminal("tp3", "p1", "P-3"));
    act(() => client.emitEvent({ type: "event", name: "terminals.changed", projectId: "p2" }));
    act(() => client.emitEvent({ type: "event", name: "terminals.changed", projectId: "p1", cardId: "a" }));
    await flush();
    expect(client.callsOf("terminals.list")).toHaveLength(1);
    act(() => client.emitEvent({ type: "event", name: "terminals.changed", projectId: "p1" }));
    await flush();
    expect(terminalTabTitles()).toEqual(["P-1", "P-2", "P-3"]);
    await showTerminal("P-3");
    expect(screen.getByRole("region", { name: "Terminal: P-3" })).toBeTruthy();
  });

  it("deleting a card selects its project", async () => {
    await setup();
    await click("Kart A");
    fireEvent.click(screen.getByRole("button", { name: "Kartı sil" }));
    fireEvent.click(screen.getByRole("button", { name: "Silmeyi onayla" }));
    await flush();
    expect(within(main()).getByRole("heading", { name: "Alfa" })).toBeTruthy();
  });

  it("selectProject request switches to that project and the work view", async () => {
    const { client, rerender, views } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Yapılacaklar" }));
    client.terminals.push(makeProjectTerminal("inst", "home", "kurulum"));
    rerender(
      <Workbench
        client={client}
        onOpenSettings={() => {}}
        createView={views.factory}
        selectProject={{ projectId: "home", seq: 1 }}
      />,
    );
    await flush();
    expect(within(main()).getByRole("heading", { name: "Ev" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Terminal: kurulum" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Çalışma" }).getAttribute("aria-pressed")).toBe("true");
  });
});
