// Adım 9 İş A: per-project switch for writing the browser's address into the project's Claude settings file.
import { describe, expect, it } from "vitest";
import { parseClientMessage, ProjectSchema } from "./protocol.ts";

const ok = (m: unknown) => parseClientMessage(JSON.stringify(m)).ok;
const req = (method: string, params: unknown) => ({ type: "req", id: 1, method, params });
const base = { id: "p", name: "P", location: { kind: "local", path: "/x" } };

describe("İş A (Adım 9): project.claudeBrowserEnv", () => {
  it("is an optional boolean on the project (absent = on)", () => {
    expect(ProjectSchema.safeParse(base).success).toBe(true);
    expect(ProjectSchema.safeParse({ ...base, claudeBrowserEnv: false }).success).toBe(true);
    expect(ProjectSchema.safeParse({ ...base, claudeBrowserEnv: true }).success).toBe(true);
    expect(ProjectSchema.safeParse({ ...base, claudeBrowserEnv: "no" }).success).toBe(false);
  });

  it("projects.create / projects.update accept it as a boolean only", () => {
    expect(ok(req("projects.create", { name: "P", location: { kind: "local", path: "/x" }, claudeBrowserEnv: false }))).toBe(true);
    expect(ok(req("projects.update", { projectId: "p", claudeBrowserEnv: true }))).toBe(true);
    expect(ok(req("projects.update", { projectId: "p", claudeBrowserEnv: null }))).toBe(false);
    expect(ok(req("projects.update", { projectId: "p", claudeBrowserEnv: 1 }))).toBe(false);
  });
});
