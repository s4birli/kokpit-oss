// İş F — Dosyalar paneli: lazy tree, read-only preview, persisted expansion/selection.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Card, Project } from "@kokpit/shared";
import { defaultUiConfig } from "../config.ts";
import type { PanelContext } from "../layout/contract.ts";
import { FakeEngineClient, makeCard, makeProject, makeSshProject } from "../test-utils/fake-client.ts";
import type { FakeTree } from "../test-utils/fake-files.ts";
import { makeFakeViewFactory } from "../test-utils/fake-view.ts";
import { FilesPanel, filesPanel } from "./FilesPanel.tsx";
import { MemoryPanelState } from "./memory-state.ts";

const flush = () => act(async () => {});
const project = makeProject("p1", "Alfa");

const TREE: FakeTree = {
  "README.md": "# Alfa\nikinci satır\n",
  "src/main.ts": "console.log(1);\n",
  "src/lib/util.ts": "export {};\n",
  "logo.png": { binary: true, size: 2048 },
  "big.log": { text: "a".repeat(1024), size: 3 * 1024 * 1024, truncated: true },
  "boş/": "",
};

function setup(opts: { tree?: FakeTree; state?: MemoryPanelState; card?: Card | null; project?: Project | null; client?: FakeEngineClient } = {}) {
  const client = opts.client ?? new FakeEngineClient({ projects: [project], files: opts.tree ?? TREE });
  const state = opts.state ?? new MemoryPanelState();
  const ctx: PanelContext = {
    client,
    config: defaultUiConfig,
    createView: makeFakeViewFactory().factory,
    project: opts.project === undefined ? project : opts.project,
    card: opts.card ?? null,
    state,
    reveal: () => {},
    select: () => {},
  };
  const utils = render(filesPanel.render(ctx));
  return { client, state, ctx, ...utils };
}

const panel = () => screen.getByRole("region", { name: "Dosyalar" });
const tree = () => within(panel()).getByRole("list", { name: "Dosya ağacı" });
const item = (name: string) => within(tree()).getByRole("button", { name });
const preview = () => within(panel()).getByRole("region", { name: "Önizleme" });

afterEach(cleanup);

describe("filesPanel definition", () => {
  it("is the 'files' panel titled Dosyalar, available once a project is selected", () => {
    expect(filesPanel.id).toBe("files");
    expect(filesPanel.title).toBe("Dosyalar");
    expect(filesPanel.available({ project: null, card: null })).toBe(false);
    expect(filesPanel.available({ project, card: null })).toBe(true);
  });
});

describe("FilesPanel", () => {
  it("does not repeat the project's name in its head (the project tab shows it); a card's name is shown", async () => {
    const { unmount } = setup();
    await flush();
    expect(panel().querySelector(".kp-files__where")).toBeNull();
    unmount();
    setup({ card: { id: "c1", projectId: "p1", name: "Kart Bir", branch: "kart-bir" } as Card });
    await flush();
    expect(panel().querySelector(".kp-files__where")?.textContent).toBe("Kart Bir");
  });

  it("lists the project root, folders first", async () => {
    const { client } = setup();
    await flush();
    const names = within(tree())
      .getAllByRole("button")
      .map((b) => b.querySelector(".kp-files__name")!.textContent);
    expect(names).toEqual(["boş", "src", "big.log", "logo.png", "README.md"]);
    // Kopyalama: right click on an entry offers its path.
    const paths = within(tree())
      .getAllByRole("button")
      .map((b) => b.getAttribute("data-copy"));
    expect(paths).toEqual(["boş", "src", "big.log", "logo.png", "README.md"]);
    expect(client.callsOf("files.list")).toEqual([{ projectId: "p1", path: "" }]);
  });

  it("expands and collapses folders lazily", async () => {
    const { client } = setup();
    await flush();
    const src = item("src");
    expect(src.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(src);
    await flush();
    expect(item("src").getAttribute("aria-expanded")).toBe("true");
    expect(item("main.ts")).toBeTruthy();
    expect(client.callsOf("files.list")).toContainEqual({ projectId: "p1", path: "src" });
    fireEvent.click(item("lib"));
    await flush();
    expect(item("util.ts")).toBeTruthy();
    fireEvent.click(item("src"));
    await flush();
    expect(within(tree()).queryByRole("button", { name: "main.ts" })).toBeNull();
    // Re-expanding uses what was loaded; no extra request.
    const before = client.callsOf("files.list").length;
    fireEvent.click(item("src"));
    await flush();
    expect(item("main.ts")).toBeTruthy();
    expect(client.callsOf("files.list").length).toBe(before);
  });

  it("shows an empty folder as such", async () => {
    setup();
    await flush();
    fireEvent.click(item("boş"));
    await flush();
    expect(within(tree()).getByText("Boş klasör")).toBeTruthy();
  });

  it("previews a text file read-only, with line numbers", async () => {
    const { client } = setup();
    await flush();
    fireEvent.click(item("README.md"));
    await flush();
    expect(item("README.md").getAttribute("aria-current")).toBe("true");
    const p = preview();
    expect(within(p).getByText("README.md")).toBeTruthy();
    expect(p.querySelector("code")!.textContent).toBe("# Alfa\nikinci satır\n");
    expect(p.querySelector(".kp-files__gutter")!.textContent).toBe("1\n2");
    expect(p.querySelector("textarea, input, [contenteditable='true']")).toBeNull();
    expect(client.callsOf("files.read")).toEqual([{ projectId: "p1", path: "README.md" }]);
  });

  it("explains binary and big files", async () => {
    setup();
    await flush();
    fireEvent.click(item("logo.png"));
    await flush();
    expect(within(preview()).getByText(/İkili dosya/)).toBeTruthy();
    expect(preview().querySelector("code")).toBeNull();
    fireEvent.click(item("big.log"));
    await flush();
    expect(within(preview()).getByText(/Büyük dosya: ilk 1 KB gösteriliyor \(toplam 3 MB\)/)).toBeTruthy();
    expect(preview().querySelector("code")!.textContent).toBe("a".repeat(1024));
  });

  it("persists expanded folders and the selected file, and restores them", async () => {
    const state = new MemoryPanelState();
    setup({ state });
    await flush();
    fireEvent.click(item("src"));
    await flush();
    fireEvent.click(item("main.ts"));
    await flush();
    expect(state.get("expanded")).toEqual(["src"]);
    expect(state.get("selected")).toBe("src/main.ts");
    cleanup();

    const again = setup({ state });
    await flush();
    expect(item("src").getAttribute("aria-expanded")).toBe("true");
    expect(item("main.ts").getAttribute("aria-current")).toBe("true");
    expect(preview().querySelector("code")!.textContent).toBe("console.log(1);\n");
    expect(again.client.callsOf("files.read")).toEqual([{ projectId: "p1", path: "src/main.ts" }]);
  });

  it("drops persisted folders and files that no longer exist", async () => {
    const state = new MemoryPanelState();
    state.set("expanded", ["gitti", "src", 42]);
    state.set("selected", "gitti/x.ts");
    setup({ state });
    await flush();
    expect(item("src").getAttribute("aria-expanded")).toBe("true");
    expect(state.get("expanded")).toEqual(["src"]);
    expect(state.get("selected")).toBeNull();
    expect(within(panel()).queryByRole("region", { name: "Önizleme" })?.querySelector("code") ?? null).toBeNull();
  });

  it("ignores malformed persisted state", async () => {
    const state = new MemoryPanelState();
    state.set("expanded", "src");
    state.set("selected", { path: "x" });
    setup({ state });
    await flush();
    expect(item("src").getAttribute("aria-expanded")).toBe("false");
  });

  it("Yenile reloads open folders and the previewed file", async () => {
    const { client } = setup();
    await flush();
    fireEvent.click(item("src"));
    await flush();
    fireEvent.click(item("main.ts"));
    await flush();
    client.files.tree = { ...TREE, "src/main.ts": "console.log(2);\n", "src/yeni.ts": "" };
    fireEvent.click(within(panel()).getByRole("button", { name: "Yenile" }));
    await flush();
    expect(item("yeni.ts")).toBeTruthy();
    expect(preview().querySelector("code")!.textContent).toBe("console.log(2);\n");
  });

  it("browses a card's worktree when a card is selected", async () => {
    const card = makeCard("c1", "p1", "Kart");
    const client = new FakeEngineClient({ projects: [project], cards: [card] });
    client.files.trees["c:c1"] = { "kart.txt": "kart\n" };
    setup({ client, card });
    await flush();
    expect(item("kart.txt")).toBeTruthy();
    expect(client.callsOf("files.list")).toEqual([{ cardId: "c1", path: "" }]);
  });

  it("shows a note for ssh projects without asking the engine", async () => {
    const ssh = makeSshProject("s1", "Uzak", "h1", "/srv/app");
    const { client } = setup({ project: ssh });
    await flush();
    expect(within(panel()).getByText(/SSH projelerinde Dosyalar yok/)).toBeTruthy();
    expect(client.callsOf("files.list")).toEqual([]);
  });

  it("shows engine errors (e.g. no folder on this machine)", async () => {
    const client = new FakeEngineClient({ projects: [project] });
    client.fail("files.list", "INVALID", "Bu projenin bu makinede klasörü yok");
    setup({ client });
    await flush();
    expect(within(panel()).getByRole("alert").textContent).toMatch(/klasörü yok/);
  });

  it("does not render a tree without a project", () => {
    render(<FilesPanel client={new FakeEngineClient()} config={defaultUiConfig} project={null} card={null} state={new MemoryPanelState()} />);
    expect(within(panel()).getByText(/Proje seçilmedi/)).toBeTruthy();
  });

  it("reloads after a reconnect", async () => {
    const { client } = setup();
    await flush();
    client.setState("reconnecting");
    client.emitReconnected();
    await flush();
    expect(client.callsOf("files.list").length).toBe(2);
  });

  it("monkey: random clicks never throw and requests stay relative", async () => {
    const { client } = setup();
    await flush();
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let i = 0; i < 80; i++) {
      // Plain DOM query: role queries recompute styles for the whole panel on every round.
      const buttons = panel().querySelectorAll("button");
      fireEvent.click(buttons[rand(buttons.length)]!);
      await flush();
    }
    for (const p of [...client.callsOf("files.list"), ...client.callsOf("files.read")]) {
      expect(p.path.startsWith("/")).toBe(false);
      expect(p.path.split("/")).not.toContain("..");
    }
  });
});
