// Dosyalar: which viewer a file gets, how the panel splits its room, the media URL and the player's error texts.
import { describe, expect, it } from "vitest";
import { defaultUiConfig } from "../config.ts";
import { chooseViewer, clampSplit, filesLayout, mediaFailure, mediaFileUrl, MEDIA_ERROR, type Viewer } from "./files-view.ts";

const TOKEN = "A".repeat(43);

describe("chooseViewer", () => {
  it.each<[string, Parameters<typeof chooseViewer>[0], Viewer]>([
    ["text", { text: "a", size: 1, truncated: false }, "text"],
    ["cut text", { text: "a", size: 9, truncated: true }, "text"],
    ["an unknown binary", { binary: true, size: 9, truncated: false }, "binary"],
    ["a video", { binary: true, size: 9, truncated: false, media: "video" }, "video"],
    ["audio", { binary: true, size: 9, truncated: false, media: "audio" }, "audio"],
    ["an image", { binary: true, size: 9, truncated: false, media: "image" }, "image"],
    ["a pdf", { binary: true, size: 9, truncated: false, media: "pdf" }, "pdf"],
    // SVG is text; it is shown as a picture (in <img>), never put into the page.
    ["an svg", { text: "<svg/>", size: 6, truncated: false, media: "image" }, "image"],
    ["neither text nor binary", { size: 0, truncated: false }, "binary"],
  ])("%s", (_n, result, viewer) => {
    expect(chooseViewer(result)).toBe(viewer);
  });

  it("an unknown media kind from a newer engine is not guessed at", () => {
    expect(chooseViewer({ binary: true, size: 1, truncated: false, media: "page" as never })).toBe("binary");
    expect(chooseViewer({ text: "x", size: 1, truncated: false, media: "script" as never })).toBe("text");
  });
});

describe("filesLayout", () => {
  const min = defaultUiConfig.filesSideBySideMinWidth;
  it("puts tree and preview side by side only when the panel is wide enough", () => {
    expect(filesLayout(min, defaultUiConfig)).toBe("side");
    expect(filesLayout(min + 400, defaultUiConfig)).toBe("side");
    expect(filesLayout(min - 1, defaultUiConfig)).toBe("stacked");
    expect(filesLayout(230, defaultUiConfig)).toBe("stacked");
  });
  it("an unmeasurable panel counts as narrow", () => {
    for (const w of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(filesLayout(w, defaultUiConfig)).toBe("stacked");
  });
});

describe("clampSplit", () => {
  it("keeps the tree's share inside the configured bounds and falls back to the default", () => {
    const { filesSplitMinRatio: min, filesSplitRatio } = defaultUiConfig;
    expect(clampSplit(0.5, "side", defaultUiConfig)).toBe(0.5);
    expect(clampSplit(0, "side", defaultUiConfig)).toBe(min);
    expect(clampSplit(1, "stacked", defaultUiConfig)).toBe(1 - min);
    for (const bad of [undefined, null, "0.5", Number.NaN, {}, []]) {
      expect(clampSplit(bad, "side", defaultUiConfig)).toBe(filesSplitRatio.side);
      expect(clampSplit(bad, "stacked", defaultUiConfig)).toBe(filesSplitRatio.stacked);
    }
  });
});

describe("mediaFileUrl", () => {
  it("builds the engine's http URL for a media token path", () => {
    expect(mediaFileUrl("ws://127.0.0.1:7420", `/files/media/${TOKEN}`)).toBe(`http://127.0.0.1:7420/files/media/${TOKEN}`);
    expect(mediaFileUrl("wss://mini.tail.ts.net", `/files/media/${TOKEN}`)).toBe(`https://mini.tail.ts.net/files/media/${TOKEN}`);
    expect(mediaFileUrl("ws://[fd7a::1]:7420/", `/files/media/${TOKEN}`)).toBe(`http://[fd7a::1]:7420/files/media/${TOKEN}`);
  });
  it.each([
    ["no engine address", undefined, `/files/media/${TOKEN}`],
    ["not a ws address", "http://127.0.0.1:7420", `/files/media/${TOKEN}`],
    ["garbage address", "ws://", `/files/media/${TOKEN}`],
    ["an absolute URL as path", "ws://127.0.0.1:7420", `http://evil.example/files/media/${TOKEN}`],
    ["a protocol-relative path", "ws://127.0.0.1:7420", `//evil.example/files/media/${TOKEN}`],
    ["a traversing path", "ws://127.0.0.1:7420", `/files/media/../${TOKEN}`],
    ["a path with a query", "ws://127.0.0.1:7420", `/files/media/${TOKEN}?x=1`],
    ["a map path", "ws://127.0.0.1:7420", `/map/${TOKEN}`],
    ["a javascript URL", "ws://127.0.0.1:7420", "javascript:alert(1)"],
  ])("refuses %s", (_n, engineUrl, path) => {
    expect(mediaFileUrl(engineUrl, path)).toBeNull();
  });
});

describe("mediaFailure", () => {
  const info = { kind: "video" as const, mime: "video/quicktime", size: "12 MB" };
  it("a decode or unsupported-source error is a codec problem, named with the file's type", () => {
    for (const code of [MEDIA_ERROR.decode, MEDIA_ERROR.unsupported]) {
      const text = mediaFailure(code, info);
      expect(text).toContain("video/quicktime");
      expect(text).toContain("12 MB");
      expect(text).toMatch(/kodeğini çözemiyor/);
      expect(text).toMatch(/dönüştürme yapmaz/);
    }
    expect(mediaFailure(MEDIA_ERROR.unsupported, { ...info, kind: "audio", mime: "audio/ogg" })).toMatch(/^Bu ses/);
  });
  it("a network error says the file could not be read", () => {
    expect(mediaFailure(MEDIA_ERROR.network, info)).toMatch(/okunamadı/);
    expect(mediaFailure(undefined, info)).toMatch(/okunamadı/);
    expect(mediaFailure(MEDIA_ERROR.network, info)).not.toMatch(/kodeğini/);
  });
});
