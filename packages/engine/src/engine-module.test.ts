import { describe, expect, it } from "vitest";
import type { Project, Tool } from "@kokpit/shared";
import { moduleServerDeps, prepareModuleLaunch, shutdownModules, type EngineModule } from "./engine-module.ts";
import { EngineError } from "./contracts.ts";

const project: Project = { id: "p", name: "P", location: { kind: "local", path: "/x" } };
const tool: Tool = { id: "t", name: "T", command: "t" };

describe("engine modules", () => {
  it("no modules: no server deps, an empty launch, nothing to shut down", async () => {
    expect(moduleServerDeps([])).toEqual({});
    const launch = prepareModuleLaunch([], tool, project);
    expect(launch.placeholders).toEqual({});
    expect(() => launch.release()).not.toThrow();
    await expect(shutdownModules([], () => {})).resolves.toBeUndefined();
  });

  it("merges server deps and launch placeholders, releases every launch", () => {
    const released: string[] = [];
    const mods: EngineModule[] = [
      { id: "a", server: { version: "a" }, prepareLaunch: () => ({ placeholders: { x: "1" }, release: () => released.push("a") }) },
      { id: "b", server: { builtinProjectId: "b" }, prepareLaunch: () => undefined },
      { id: "c", prepareLaunch: () => ({ placeholders: { y: "2" }, release: () => released.push("c") }) },
    ];
    expect(moduleServerDeps(mods)).toEqual({ version: "a", builtinProjectId: "b" });
    const launch = prepareModuleLaunch(mods, tool, project);
    expect(launch.placeholders).toEqual({ x: "1", y: "2" });
    launch.release();
    expect(released).toEqual(["a", "c"]);
  });

  it("a module refusing a launch releases what the others already prepared, and the refusal propagates", () => {
    const released: string[] = [];
    const mods: EngineModule[] = [
      { id: "a", prepareLaunch: () => ({ release: () => released.push("a") }) },
      {
        id: "b",
        prepareLaunch: () => {
          throw new EngineError("INVALID", "no");
        },
      },
    ];
    expect(() => prepareModuleLaunch(mods, tool, project)).toThrow("no");
    expect(released).toEqual(["a"]);
  });

  it("shuts down newest first and keeps going past a failing module", async () => {
    const order: string[] = [];
    const errors: string[] = [];
    const mods: EngineModule[] = [
      { id: "first", shutdown: () => void order.push("first") },
      {
        id: "second",
        shutdown: async () => {
          order.push("second");
          throw new Error("boom");
        },
      },
      { id: "third", shutdown: () => void order.push("third") },
    ];
    await shutdownModules(mods, (id) => errors.push(id));
    expect(order).toEqual(["third", "second", "first"]);
    expect(errors).toEqual(["second"]);
  });
});
