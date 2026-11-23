// Bağlantılar: which gesture on a link does what, where a project's links open, and what the tooltip says.
import type { Project } from "@kokpit/shared";
import { t as msg } from "../../i18n/index.ts";
import { parseLinkTarget } from "@kokpit/shared";
import { describe, expect, it } from "vitest";
import { linksConfig } from "../engine/links-ipc.ts";
import { linkDestination, linkGesture, linkTooltip, type GestureContext, type LinkGesture, type PointerGesture } from "./link-actions.ts";

const LEFT = 0;
const press = (mods: Partial<Omit<PointerGesture, "button">> = {}, button = LEFT): PointerGesture => ({ button, metaKey: false, altKey: false, shiftKey: false, ctrlKey: false, ...mods });
const mac = (tracking: boolean, plainClickOpens = true): GestureContext => ({ tracking, plainClickOpens, isMac: true });

describe("linkGesture (macOS)", () => {
  // The whole table: gesture × "does the program track the mouse?".
  const table: [name: string, gesture: PointerGesture, notTracking: LinkGesture, tracking: LinkGesture][] = [
    ["plain click", press(), "open", "none"],
    ["⌘ click", press({ metaKey: true }), "open", "open"],
    ["⌥⌘ click", press({ metaKey: true, altKey: true }), "external", "external"],
    ["⇧⌘ click", press({ metaKey: true, shiftKey: true }), "open", "open"],
    ["⌥ click (terminal selection)", press({ altKey: true }), "none", "none"],
    ["⇧ click (extends the selection)", press({ shiftKey: true }), "none", "none"],
    ["⌃ click (the context menu)", press({ ctrlKey: true }), "none", "none"],
    ["middle button", press({}, 1), "none", "none"],
    ["⌘ middle button", press({ metaKey: true }, 1), "none", "none"],
    ["right button", press({}, 2), "none", "none"],
  ];
  it.each(table)("%s", (_name, gesture, notTracking, tracking) => {
    expect(linkGesture(gesture, mac(false))).toBe(notTracking);
    expect(linkGesture(gesture, mac(true))).toBe(tracking);
  });

  it("with plain clicks turned off in the config only ⌘ opens", () => {
    expect(linkGesture(press(), mac(false, false))).toBe("none");
    expect(linkGesture(press({ metaKey: true }), mac(false, false))).toBe("open");
    expect(linkGesture(press({ metaKey: true, altKey: true }), mac(true, false))).toBe("external");
  });

  it("elsewhere Ctrl plays ⌘'s part", () => {
    const other: GestureContext = { tracking: true, plainClickOpens: true, isMac: false };
    expect(linkGesture(press({ ctrlKey: true }), other)).toBe("open");
    expect(linkGesture(press({ ctrlKey: true, altKey: true }), other)).toBe("external");
    expect(linkGesture(press({ metaKey: true }), other)).toBe("none");
    expect(linkGesture(press(), other)).toBe("none");
  });
});

describe("linkDestination (the terminal's project decides)", () => {
  const base = { id: "p", name: "P" };
  const cases: [name: string, project: Project | undefined, where: ReturnType<typeof linkDestination>][] = [
    ["a local project: its Chrome on the engine machine", { ...base, location: { kind: "local", path: "/x" } }, "engine"],
    ["a GitHub project: the same", { ...base, location: { kind: "github", url: "https://github.com/a/b.git", path: "/c" } }, "engine"],
    ["browser explicitly on the engine", { ...base, location: { kind: "local", path: "/x" }, browser: { runOn: "engine" } }, "engine"],
    ["browser on this machine: the local profile Chrome", { ...base, location: { kind: "local", path: "/x" }, browser: { runOn: "client" } }, "client"],
    ["an SSH project: the default browser", { ...base, location: { kind: "ssh", hostId: "h" } }, "external"],
    ["an SSH project never uses a local profile Chrome either", { ...base, location: { kind: "ssh", hostId: "h" }, browser: { runOn: "client" } }, "external"],
    ["a project the app does not know (deleted meanwhile): the default browser", undefined, "external"],
  ];
  it.each(cases)("%s", (_name, project, where) => expect(linkDestination(project)).toBe(where));
});

describe("linkTooltip", () => {
  const cfg = linksConfig;
  const web = parseLinkTarget("https://example.com/yol?x=1");
  const ctx = { tracking: true, plainClickOpens: true, machineName: "Mac mini", shown: null };

  it("shows the real target and says where ⌘ click opens it — on the engine machine for an engine browser", () => {
    const tip = linkTooltip(web, "engine", ctx, cfg);
    expect(tip.url).toBe("https://example.com/yol?x=1");
    expect(tip.openable).toBe(true);
    expect(tip.lines[0]).toBe("⌘ tıkla: Mac mini'deki tarayıcıda açılır");
    expect(tip.lines.join("\n")).toContain(msg("links.text.gestureExternal"));
    expect(tip.lines.join("\n")).toContain(msg("links.text.gestureMenu"));
  });

  it("names the plain click too when the program does not track the mouse", () => {
    expect(linkTooltip(web, "engine", { ...ctx, tracking: false }, cfg).lines[0]).toBe("Tıkla ya da ⌘ tıkla: Mac mini'deki tarayıcıda açılır");
    expect(linkTooltip(web, "engine", { ...ctx, tracking: false, plainClickOpens: false }, cfg).lines[0]).toBe("⌘ tıkla: Mac mini'deki tarayıcıda açılır");
  });

  it("says this machine's project browser, or the default browser, for the other project kinds", () => {
    expect(linkTooltip(web, "client", ctx, cfg).lines[0]).toBe(`⌘ tıkla: ${msg("links.text.client")}`);
    const external = linkTooltip(web, "external", ctx, cfg);
    expect(external.lines[0]).toBe(`⌘ tıkla: ${msg("links.text.external")}`);
    // The escape hatch is the default browser already.
    expect(external.lines.join("\n")).not.toContain(msg("links.text.gestureExternal"));
  });

  it("the machine's name comes from the configuration", () => {
    expect(linkTooltip(web, "engine", { ...ctx, machineName: "Stüdyo Mac" }, cfg).lines[0]).toContain("Stüdyo Mac'deki tarayıcıda açılır");
  });

  it("a link whose text reads like another address carries a warning with that address", () => {
    const tip = linkTooltip(web, "engine", { ...ctx, shown: "https://banka.example/" }, cfg);
    expect(tip.lines.at(-1)).toBe("Dikkat: görünen adres başka (https://banka.example/)");
  });

  it("a long address is shortened in the middle, keeping the host", () => {
    const long = parseLinkTarget(`https://example.com/${"a".repeat(1000)}/son`);
    const tip = linkTooltip(long, "engine", ctx, cfg);
    expect(tip.url.length).toBeLessThanOrEqual(cfg.tooltipMaxChars);
    expect(tip.url.startsWith("https://example.com/")).toBe(true);
    expect(tip.url.endsWith("/son")).toBe(true);
  });

  it.each([
    ["vscode://file/tmp/a.ts", "Bu tür bağlantı açılmaz (vscode:)"],
    ["javascript:alert(1)", "Bu tür bağlantı açılmaz (javascript:)"],
    ["mailto:a@example.com", "Bu tür bağlantı açılmaz (mailto:)"],
    ["file:///tmp/a.txt", msg("links.text.refusedFile")],
    ["https://user:pw@example.com/", msg("links.text.refusedInvalid")],
    ["example.com/yol", msg("links.text.refusedInvalid")],
  ])("%s is not openable: the tooltip says so and offers copying", (raw, first) => {
    const tip = linkTooltip(parseLinkTarget(raw), "engine", ctx, cfg, raw);
    expect(tip.openable).toBe(false);
    expect(tip.lines).toEqual([`${first} · ${msg("links.text.refusedCopy")}`]);
    expect(tip.url).toBe(raw);
  });

  it("an address with control characters shows no text of its own", () => {
    const raw = "https://example.com/\u001b[31m";
    const tip = linkTooltip(parseLinkTarget(raw), "engine", ctx, cfg, raw);
    expect(tip).toEqual({ url: "", lines: [msg("links.text.refusedInvalid")], openable: false });
  });
});
