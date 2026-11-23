import { describe, expect, it } from "vitest";
import type { Project } from "@kokpit/shared";
import { supportsCards } from "./projects.ts";

const project = (location: Project["location"], extra: Partial<Project> = {}): Project => ({
  id: "p",
  name: "P",
  location,
  ...extra,
});

describe("supportsCards", () => {
  it("local folders and GitHub clones support cards", () => {
    expect(supportsCards(project({ kind: "local", path: "/x/repo" }))).toBe(true);
    expect(supportsCards(project({ kind: "github", url: "https://github.com/o/r", path: "/d/repos/p" }))).toBe(true);
  });

  it("SSH projects never do", () => {
    expect(supportsCards(project({ kind: "ssh", hostId: "h", path: "/srv" }))).toBe(false);
  });


  it("the built-in project (home folder) never does, even though it is local", () => {
    expect(supportsCards(project({ kind: "local", path: "/Users/u" }, { builtin: true }))).toBe(false);
  });
});
