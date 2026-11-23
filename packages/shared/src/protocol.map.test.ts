// İş C — Harita: protocol additions.
import { describe, expect, it } from "vitest";
import { MAP_HTTP_PREFIX, MapInfoSchema, isMapTokenPath, parseClientMessage } from "./protocol.ts";

const ok = (m: unknown) => parseClientMessage(JSON.stringify(m)).ok;
const req = (method: string, params: unknown) => ({ type: "req", id: 1, method, params });

describe("harita protokolü", () => {
  it("accepts map.info and map.token with a project id", () => {
    expect(ok(req("map.info", { projectId: "p1" }))).toBe(true);
    expect(ok(req("map.token", { projectId: "p1" }))).toBe(true);
  });

  it.each([
    ["missing projectId", {}],
    ["empty projectId", { projectId: "" }],
    ["extra path field", { projectId: "p1", path: "../../etc/passwd" }],
    ["extra file field", { projectId: "p1", file: "/etc/passwd" }],
  ])("rejects map requests: %s", (_n, params) => {
    expect(ok(req("map.info", params))).toBe(false);
    expect(ok(req("map.token", params))).toBe(false);
  });

  it("describes map info", () => {
    expect(MapInfoSchema.safeParse({ available: false }).success).toBe(true);
    expect(
      MapInfoSchema.safeParse({
        available: true,
        file: "graphify-out/graph.html",
        generatedAt: "2026-11-16T10:00:00.000Z",
        updateCommand: 'claude "/graphify ."',
      }).success,
    ).toBe(true);
    expect(MapInfoSchema.safeParse({}).success).toBe(false);
  });

  it("recognises only well-formed token paths", () => {
    expect(MAP_HTTP_PREFIX.startsWith("/")).toBe(true);
    expect(isMapTokenPath(`${MAP_HTTP_PREFIX}abcDEF_-0123456789abcdef0123456789abcdef`)).toBe(true);
    expect(isMapTokenPath(`${MAP_HTTP_PREFIX}`)).toBe(false);
    expect(isMapTokenPath(`${MAP_HTTP_PREFIX}../etc/passwd`)).toBe(false);
    expect(isMapTokenPath(`${MAP_HTTP_PREFIX}abc/def`)).toBe(false);
    expect(isMapTokenPath(`${MAP_HTTP_PREFIX}abc%2f..`)).toBe(false);
    expect(isMapTokenPath("/health")).toBe(false);
  });
});
