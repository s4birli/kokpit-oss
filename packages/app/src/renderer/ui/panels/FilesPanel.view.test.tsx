// Dosyalar paneli — yer ve medya: side by side / stacked, the divider, the large preview, and video / sound /
// picture / PDF streamed from the engine (the URL is asked for, given back, and replaced once on a failure).
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultUiConfig } from "../config.ts";
import type { PanelContext } from "../layout/contract.ts";
import { FakeEngineClient, makeProject, makeSshProject } from "../test-utils/fake-client.ts";
import type { FakeTree } from "../test-utils/fake-files.ts";
import { FakeResizeObserver, makeFakeViewFactory } from "../test-utils/fake-view.ts";
import { filesPanel } from "./FilesPanel.tsx";
import { MEDIA_ERROR } from "./files-view.ts";
import { MemoryPanelState } from "./memory-state.ts";

const flush = () => act(async () => {});
const project = makeProject("p1", "Alfa");
const ENGINE = "ws://127.0.0.1:7420";
const WIDE = defaultUiConfig.filesSideBySideMinWidth + 200;
const NARROW = 230;

const TREE: FakeTree = {
  "README.md": "# Alfa\n",
  "notlar.txt": "not\n",
  "cikti/video.mp4": { binary: true, size: 5 * 1024 * 1024, media: "video", mime: "video/mp4" },
  "cikti/prores.mov": { binary: true, size: 12 * 1024 * 1024, media: "video", mime: "video/quicktime" },
  "cikti/ses.mp3": { binary: true, size: 2048, media: "audio", mime: "audio/mpeg" },
  "cikti/resim.png": { binary: true, size: 4096, media: "image", mime: "image/png" },
  "cikti/belge.pdf": { binary: true, size: 8192, media: "pdf", mime: "application/pdf" },
  "cikti/cizim.svg": { text: "<svg xmlns='http://www.w3.org/2000/svg'><script>window.kacak = 1</script></svg>", media: "image", mime: "image/svg+xml" },
  "cikti/veri.bin": { binary: true, size: 100 },
};

let width = NARROW;

function setup(opts: { state?: MemoryPanelState; engineUrl?: string | null; project?: typeof project } = {}) {
  const client = new FakeEngineClient({ projects: [project], files: TREE });
  const state = opts.state ?? new MemoryPanelState();
  const ctx: PanelContext = {
    client,
    config: defaultUiConfig,
    createView: makeFakeViewFactory().factory,
    project: opts.project ?? project,
    card: null,
    state,
    reveal: () => {},
    select: () => {},
    ...(opts.engineUrl === null ? {} : { engineUrl: opts.engineUrl ?? ENGINE }),
  };
  const utils = render(filesPanel.render(ctx));
  return { client, state, ctx, ...utils };
}

const panel = () => screen.getByRole("region", { name: "Dosyalar" });
const tree = () => within(panel()).getByRole("list", { name: "Dosya ağacı" });
const item = (name: string) => within(tree()).getByRole("button", { name });
const preview = () => within(panel()).getByRole("region", { name: "Önizleme" });
const queryPreview = () => within(panel()).queryByRole("region", { name: "Önizleme" });
const body = () => panel().querySelector<HTMLElement>(".kp-files__body")!;
const isLarge = () => preview().classList.contains("kp-files__preview--large");
const divider = () => within(panel()).getByRole("separator");

async function resize(to: number): Promise<void> {
  width = to;
  await act(async () => FakeResizeObserver.triggerAll());
}
async function openFolder(): Promise<void> {
  fireEvent.click(item("cikti"));
  await flush();
}
async function click(name: string): Promise<void> {
  fireEvent.click(item(name));
  await flush();
}
function failPlayer(el: Element, code: number): void {
  Object.defineProperty(el, "error", { configurable: true, value: { code } });
  fireEvent.error(el);
}

beforeEach(() => {
  width = NARROW;
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const w = this.classList.contains("kp-files__body") ? width : 0;
    return { x: 0, y: 0, left: 0, top: 0, width: w, height: 400, right: w, bottom: 400, toJSON: () => ({}) } as DOMRect;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("FilesPanel room", () => {
  it("a narrow panel stacks tree and preview; a wide one puts them side by side", async () => {
    setup();
    await flush();
    expect(body().classList.contains("kp-files__body--stacked")).toBe(true);
    await resize(WIDE);
    expect(body().classList.contains("kp-files__body--side")).toBe(true);
    await resize(NARROW);
    expect(body().classList.contains("kp-files__body--stacked")).toBe(true);
  });

  it("without a selected file the tree has the whole panel: no preview region, no divider", async () => {
    setup();
    await flush();
    expect(queryPreview()).toBeNull();
    expect(within(panel()).queryByRole("separator")).toBeNull();
    expect(body().style.gridTemplateRows).toBe("");
  });

  it("narrow: one click opens the file in the large preview; Esc brings the panel back and the focus to the file", async () => {
    setup();
    await flush();
    await click("README.md");
    expect(isLarge()).toBe(true);
    expect(preview().querySelector("code")!.textContent).toBe("# Alfa\n");
    const shrink = within(preview()).getByRole("button", { name: "Küçült" });
    expect(shrink.getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(shrink);
    fireEvent.keyDown(document, { key: "Escape" });
    await flush();
    expect(isLarge()).toBe(false);
    expect(document.activeElement).toBe(item("README.md"));
    // The file stays previewed below the tree, each in its own track.
    expect(body().style.gridTemplateRows).toContain("fr");
    expect(divider().getAttribute("aria-orientation")).toBe("horizontal");
  });

  it("wide: a click previews beside the tree; Büyüt and a double click open the large preview", async () => {
    setup();
    await flush();
    await resize(WIDE);
    await click("README.md");
    expect(isLarge()).toBe(false);
    expect(body().style.gridTemplateColumns).toContain("fr");
    expect(divider().getAttribute("aria-orientation")).toBe("vertical");
    fireEvent.click(within(preview()).getByRole("button", { name: "Büyüt" }));
    await flush();
    expect(isLarge()).toBe(true);
    fireEvent.click(within(preview()).getByRole("button", { name: "Küçült" }));
    await flush();
    expect(isLarge()).toBe(false);
    expect(document.activeElement).toBe(within(preview()).getByRole("button", { name: "Büyüt" }));
    fireEvent.doubleClick(item("notlar.txt"));
    await flush();
    expect(isLarge()).toBe(true);
    expect(preview().querySelector("code")!.textContent).toBe("not\n");
  });

  it("a restored selection never opens large by itself, and the large preview is not persisted", async () => {
    const state = new MemoryPanelState();
    const first = setup({ state });
    await flush();
    await click("README.md");
    expect(isLarge()).toBe(true);
    first.unmount();
    setup({ state });
    await flush();
    expect(preview().querySelector("code")!.textContent).toBe("# Alfa\n");
    expect(isLarge()).toBe(false);
  });

  it("Önizlemeyi kapat gives the room back to the tree and forgets the file", async () => {
    const { state } = setup();
    await flush();
    await click("README.md");
    fireEvent.click(within(preview()).getByRole("button", { name: "Önizlemeyi kapat" }));
    await flush();
    expect(queryPreview()).toBeNull();
    expect(state.get("selected")).toBeNull();
    expect(item("README.md").getAttribute("aria-current")).toBeNull();
  });

  it("the divider moves with the arrow keys, per layout, inside its bounds, and is remembered", async () => {
    const state = new MemoryPanelState();
    const { filesSplitRatio: def, filesSplitKeyStep: step, filesSplitMinRatio: min } = defaultUiConfig;
    const first = setup({ state });
    await flush();
    await click("README.md");
    fireEvent.keyDown(document, { key: "Escape" });
    await flush();
    expect(Number(divider().getAttribute("aria-valuenow"))).toBeCloseTo(def.stacked * 100);
    fireEvent.keyDown(divider(), { key: "ArrowDown" });
    expect(Number(divider().getAttribute("aria-valuenow"))).toBeCloseTo((def.stacked + step) * 100);
    // The other axis' keys do nothing here.
    fireEvent.keyDown(divider(), { key: "ArrowRight" });
    expect(Number(divider().getAttribute("aria-valuenow"))).toBeCloseTo((def.stacked + step) * 100);
    for (let i = 0; i < 40; i++) fireEvent.keyDown(divider(), { key: "ArrowUp" });
    expect(Number(divider().getAttribute("aria-valuenow"))).toBeCloseTo(min * 100);

    await resize(WIDE);
    expect(Number(divider().getAttribute("aria-valuenow"))).toBeCloseTo(def.side * 100);
    fireEvent.keyDown(divider(), { key: "ArrowRight" });
    expect(state.get<{ side: number; stacked: number }>("split")).toEqual({ stacked: min, side: expect.closeTo(def.side + step) });
    first.unmount();

    setup({ state });
    await flush();
    await resize(WIDE);
    expect(Number(divider().getAttribute("aria-valuenow"))).toBeCloseTo((def.side + step) * 100);
  });

  it("dragging the divider sets the tree's share from the pointer", async () => {
    setup();
    await flush();
    await resize(WIDE);
    await click("README.md");
    fireEvent.pointerDown(divider(), { clientX: 0 });
    await act(async () => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: WIDE / 2 }));
      window.dispatchEvent(new MouseEvent("pointerup", { clientX: WIDE / 2 }));
    });
    expect(Number(divider().getAttribute("aria-valuenow"))).toBeCloseTo(50);
  });

  it("ignores a malformed stored split", async () => {
    const state = new MemoryPanelState();
    state.set("split", { side: "geniş", stacked: 7 });
    state.set("selected", "README.md");
    setup({ state });
    await flush();
    expect(Number(divider().getAttribute("aria-valuenow"))).toBeCloseTo((1 - defaultUiConfig.filesSplitMinRatio) * 100);
    await resize(WIDE);
    expect(Number(divider().getAttribute("aria-valuenow"))).toBeCloseTo(defaultUiConfig.filesSplitRatio.side * 100);
  });
});

describe("FilesPanel media", () => {
  async function open(name: string) {
    const s = setup();
    await flush();
    await openFolder();
    await click(name);
    return s;
  }

  it("a video plays in a <video controls> fed by the engine's one-file URL, and takes the keyboard", async () => {
    const { client } = await open("video.mp4");
    expect(client.callsOf("files.mediaUrl")).toEqual([{ projectId: "p1", path: "cikti/video.mp4" }]);
    const video = preview().querySelector("video")!;
    expect(video.getAttribute("src")).toBe(`http://127.0.0.1:7420${client.files.mediaUrls[0]}`);
    expect(video.controls).toBe(true);
    expect(video.getAttribute("preload")).toBe("metadata");
    expect(video.hasAttribute("autoplay")).toBe(false);
    // Large preview (narrow panel): the player has the focus, so Space plays / pauses.
    expect(isLarge()).toBe(true);
    expect(document.activeElement).toBe(video);
    expect(within(preview()).getByText("5 MB")).toBeTruthy();
    expect(preview().textContent).not.toMatch(/İkili dosya/);
  });

  it("sound, pictures and PDFs get their own element", async () => {
    const { client } = await open("ses.mp3");
    expect(preview().querySelector("audio")!.controls).toBe(true);
    await click("resim.png");
    const img = preview().querySelector("img")!;
    expect(img.getAttribute("src")).toBe(`http://127.0.0.1:7420${client.files.mediaUrls.at(-1)}`);
    expect(img.getAttribute("alt")).toBe("cikti/resim.png");
    await click("belge.pdf");
    const frame = preview().querySelector("iframe")!;
    // The viewer's toolbar (which would show the token as the file's name) is switched off.
    expect(frame.getAttribute("src")).toBe(`http://127.0.0.1:7420${client.files.mediaUrls.at(-1)}#toolbar=0&navpanes=0`);
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(preview().querySelector("video, audio, img")).toBeNull();
  });

  it("an SVG is shown as a picture, never as markup of this page", async () => {
    await open("cizim.svg");
    expect(preview().querySelector("img")).toBeTruthy();
    expect(preview().querySelector("svg, script")).toBeNull();
    expect(preview().querySelector("code")).toBeNull();
    expect((window as unknown as { kacak?: number }).kacak).toBeUndefined();
  });

  it("a picture fits the panel; a click shows it at its own size and back", async () => {
    await open("resim.png");
    const zoom = within(preview()).getByRole("button", { name: "Resmi gerçek boyutunda göster" });
    expect(zoom.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(zoom);
    expect(preview().querySelector(".kp-files__media--actual")).toBeTruthy();
    fireEvent.click(within(preview()).getByRole("button", { name: "Resmi panele sığdır" }));
    expect(preview().querySelector(".kp-files__media--actual")).toBeNull();
  });

  it("a binary file of no known type keeps the note and asks for no URL", async () => {
    const { client } = await open("veri.bin");
    expect(within(preview()).getByText(/İkili dosya \(100 B\); önizleme yok/)).toBeTruthy();
    expect(client.callsOf("files.mediaUrl")).toEqual([]);
  });

  it("gives the URL back when another file is selected, the preview closes or the panel goes away", async () => {
    const { client, unmount } = await open("video.mp4");
    const first = client.files.mediaUrls[0]!;
    await click("resim.png");
    expect(client.callsOf("files.mediaRevoke")).toEqual([{ path: first }]);
    expect(client.files.mediaUrls).toHaveLength(1);
    fireEvent.click(within(preview()).getByRole("button", { name: "Önizlemeyi kapat" }));
    await flush();
    expect(client.files.mediaUrls).toHaveLength(0);
    await click("ses.mp3");
    expect(client.files.mediaUrls).toHaveLength(1);
    unmount();
    await flush();
    expect(client.files.mediaUrls).toHaveLength(0);
  });

  it("a failing player asks the engine once more, then names the codec problem with the file's type", async () => {
    const { client } = await open("prores.mov");
    const before = preview().querySelector("video")!;
    failPlayer(before, MEDIA_ERROR.unsupported);
    await flush();
    // A fresh URL, the old one given back.
    expect(client.callsOf("files.mediaUrl")).toHaveLength(2);
    expect(client.files.mediaUrls).toHaveLength(1);
    const again = preview().querySelector("video")!;
    expect(again.getAttribute("src")).not.toBe(before.getAttribute("src"));
    failPlayer(again, MEDIA_ERROR.unsupported);
    await flush();
    const alert = within(preview()).getByRole("alert");
    expect(alert.textContent).toMatch(/Bu video Kokpit'te oynatılamıyor/);
    expect(alert.textContent).toContain("video/quicktime");
    expect(alert.textContent).toContain("12 MB");
    expect(alert.textContent).toMatch(/dönüştürme yapmaz/);
    expect(preview().querySelector("video")).toBeNull();
    expect(client.callsOf("files.mediaUrl")).toHaveLength(2);
  });

  it("a player that recovered gets its retry back, and resumes where it was", async () => {
    const { client } = await open("video.mp4");
    const v1 = preview().querySelector("video")!;
    Object.defineProperty(v1, "currentTime", { configurable: true, writable: true, value: 42 });
    failPlayer(v1, MEDIA_ERROR.network);
    await flush();
    const v2 = preview().querySelector("video")!;
    let sought = 0;
    Object.defineProperty(v2, "currentTime", { configurable: true, get: () => sought, set: (t: number) => (sought = t) });
    Object.defineProperty(v2, "videoWidth", { configurable: true, value: 640 });
    Object.defineProperty(v2, "videoHeight", { configurable: true, value: 360 });
    fireEvent.loadedMetadata(v2);
    expect(sought).toBe(42);
    fireEvent.canPlay(v2);
    failPlayer(v2, MEDIA_ERROR.network);
    await flush();
    expect(client.callsOf("files.mediaUrl")).toHaveLength(3);
    expect(within(preview()).queryByRole("alert")).toBeNull();
  });

  it("a video whose picture cannot be decoded says so and keeps playing the sound", async () => {
    await open("video.mp4");
    const video = preview().querySelector("video")!;
    Object.defineProperty(video, "videoWidth", { configurable: true, value: 0 });
    Object.defineProperty(video, "videoHeight", { configurable: true, value: 0 });
    fireEvent.loadedMetadata(video);
    expect(within(preview()).getByRole("alert").textContent).toMatch(/Görüntü kodeği çözülemiyor/);
    expect(preview().querySelector("video")).toBeTruthy();
  });

  it("a picture that cannot be shown says so", async () => {
    await open("resim.png");
    fireEvent.error(preview().querySelector("img")!);
    await flush();
    fireEvent.error(preview().querySelector("img")!);
    await flush();
    expect(within(preview()).getByRole("alert").textContent).toMatch(/Resim gösterilemedi/);
  });

  it("shows the engine's refusal (e.g. content that does not match the extension)", async () => {
    const s = setup();
    await flush();
    await openFolder();
    s.client.fail("files.mediaUrl", "INVALID", "Dosyanın içeriği uzantısıyla uyuşmuyor; açılmadı");
    await click("video.mp4");
    expect(within(preview()).getByRole("alert").textContent).toMatch(/uzantısıyla uyuşmuyor/);
    expect(preview().querySelector("video")).toBeNull();
  });

  it("without an engine address there is nothing to load", async () => {
    const s = setup({ engineUrl: null });
    await flush();
    await openFolder();
    await click("video.mp4");
    expect(within(preview()).getByRole("alert").textContent).toMatch(/adresi geçersiz/);
    expect(preview().querySelector("video")).toBeNull();
    void s;
  });

  it("a reconnect asks for a new URL (the engine ended the old connection's)", async () => {
    const { client } = await open("video.mp4");
    const before = preview().querySelector("video")!.getAttribute("src");
    client.setState("reconnecting");
    client.emitReconnected();
    await flush();
    expect(client.callsOf("files.mediaUrl")).toHaveLength(2);
    expect(preview().querySelector("video")!.getAttribute("src")).not.toBe(before);
  });

  it("Yenile reloads the media view", async () => {
    const { client } = await open("video.mp4");
    fireEvent.keyDown(document, { key: "Escape" });
    await flush();
    fireEvent.click(within(panel()).getByRole("button", { name: "Yenile" }));
    await flush();
    expect(client.callsOf("files.mediaUrl")).toHaveLength(2);
    expect(client.files.mediaUrls).toHaveLength(1);
  });

  it("ssh projects keep their note: no tree, no media request", async () => {
    const client = new FakeEngineClient({ projects: [project], files: TREE });
    render(
      filesPanel.render({
        client,
        config: defaultUiConfig,
        createView: makeFakeViewFactory().factory,
        project: makeSshProject("s1", "Uzak", "h1"),
        card: null,
        state: new MemoryPanelState(),
        reveal: () => {},
        select: () => {},
        engineUrl: ENGINE,
      }),
    );
    await flush();
    expect(within(panel()).getByText(/SSH projelerinde Dosyalar yok/)).toBeTruthy();
    expect(client.calls.filter((c) => c.method.startsWith("files."))).toEqual([]);
  });
});
