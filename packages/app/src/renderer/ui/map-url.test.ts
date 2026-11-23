import { describe, expect, it } from "vitest";
import { mapFrameUrl } from "./map-url.ts";

describe("mapFrameUrl", () => {
  it("maps the engine's ws/wss address to http/https on the same host and port", () => {
    expect(mapFrameUrl("ws://127.0.0.1:7420", "/map/abcdefghijklmnop")).toBe("http://127.0.0.1:7420/map/abcdefghijklmnop");
    expect(mapFrameUrl("wss://kutu.example:443/", "/map/abcdefghijklmnop")).toBe("https://kutu.example/map/abcdefghijklmnop");
    expect(mapFrameUrl("ws://[::1]:9000", "/map/abcdefghijklmnop")).toBe("http://[::1]:9000/map/abcdefghijklmnop");
  });

  it("drops any path, query or credentials of the engine address", () => {
    expect(mapFrameUrl("ws://u:p@127.0.0.1:7420/x?y=1#z", "/map/abcdefghijklmnop")).toBe("http://127.0.0.1:7420/map/abcdefghijklmnop");
  });

  it.each([
    ["missing engine url", undefined, "/map/abcdefghijklmnop"],
    ["garbage engine url", "not a url", "/map/abcdefghijklmnop"],
    ["non-ws engine url", "http://127.0.0.1:7420", "/map/abcdefghijklmnop"],
    ["path outside /map/", "ws://127.0.0.1:7420", "/health"],
    ["absolute url as path", "ws://127.0.0.1:7420", "https://evil.example/map/abcdefghijklmnop"],
    ["protocol-relative path", "ws://127.0.0.1:7420", "//evil.example/map/abcdefghijklmnop"],
    ["traversal in token", "ws://127.0.0.1:7420", "/map/../../etc/passwd"],
  ])("returns null for %s", (_n, engineUrl, path) => {
    expect(mapFrameUrl(engineUrl, path)).toBeNull();
  });
});
