// Bağlantılar — the decisions, apart from the terminal and the DOM so they can be read (and tested) as tables:
// which gesture on a link opens it and where, where a project's links go, and what the tooltip says.
import { isWebPagePath, type FileLocation, type LinkTarget, type Project } from "@kokpit/shared";
import { t } from "../../i18n/index.ts";
import { shortenUrl, type LinksConfig } from "../engine/links-ipc.ts";
import { isAppOnlyKind } from "./projects.ts";

const PRIMARY_BUTTON = 0;

/** Where an http(s) link of a project's terminal opens. */
export type LinkDestination =
  /** The project's Chrome on the engine machine (Tarayıcı panel). */
  | "engine"
  /** The project's own-profile Chrome on this machine (`browser.runOn: "client"`). */
  | "client"
  /** This machine's default browser. */
  | "external";

/**
 * The terminal's own project decides — not the selection. SSH projects: the link is about the remote host, where
 * no Kokpit browser runs; app-only projects have no browser at all. Both, and a project the app no longer knows, use the
 * default browser.
 */
export function linkDestination(project: Project | undefined): LinkDestination {
  if (!project || project.location.kind === "ssh" || isAppOnlyKind(project.location.kind)) return "external";
  return project.browser?.runOn === "client" ? "client" : "engine";
}

export type LinkGesture =
  /** Open where the project's links go. */
  | "open"
  /** Open in the default browser, whatever the project. */
  | "external"
  | "none";

export interface PointerGesture {
  button: number;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
}

export interface GestureContext {
  /** The program in the terminal tracks the mouse (Claude Code does): plain clicks belong to it. */
  tracking: boolean;
  plainClickOpens: boolean;
  isMac: boolean;
}

/**
 * macOS terminal conventions: ⌘ click always activates a link, also while the program tracks the mouse; ⌥⌘ click
 * sends it to the default browser. A plain click activates only when the program does not track the mouse (else
 * the click is the program's). ⌥ and ⇧ clicks are selection gestures, ⌃ click is the context menu.
 */
export function linkGesture(e: PointerGesture, ctx: GestureContext): LinkGesture {
  if (e.button !== PRIMARY_BUTTON) return "none";
  const accel = ctx.isMac ? e.metaKey : e.ctrlKey;
  if (accel) return e.altKey ? "external" : "open";
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return "none";
  return ctx.plainClickOpens && !ctx.tracking ? "open" : "none";
}

export interface TooltipContext {
  tracking: boolean;
  plainClickOpens: boolean;
  /** The engine machine's name (UiConfig.machineName). */
  machineName: string;
  /** OSC 8: the address the link's TEXT reads as, when that is another host's (deceptiveLinkText); else null. */
  shown: string | null;
}

export interface LinkTooltip {
  /** The real target, shortened; "" when it cannot be shown safely. */
  url: string;
  lines: string[];
  openable: boolean;
}

/**
 * What hovering a link shows: always the REAL target (never the link's text), and what the gestures do with it.
 * `raw` is the target as the program wrote it, shown for links that are never opened.
 */
export function linkTooltip(target: LinkTarget, destination: LinkDestination, ctx: TooltipContext, cfg: LinksConfig, raw = ""): LinkTooltip {
  if (target.kind !== "web") {
    const why =
      target.kind === "file"
        ? t("links.text.refusedFile")
        : target.reason === "scheme" && target.scheme !== undefined
          ? t("links.text.refusedScheme", { scheme: target.scheme })
          : t("links.text.refusedInvalid");
    // Control characters, emptiness, absurd length: nothing of it is shown, and there is nothing to copy.
    const showable = target.kind === "file" || target.reason === "scheme" || target.reason === "malformed" || target.reason === "credentials";
    if (!showable) return { url: "", lines: [why], openable: false };
    return { url: shortenUrl(target.kind === "file" ? target.url : raw, cfg.tooltipMaxChars), lines: [`${why} · ${t("links.text.refusedCopy")}`], openable: false };
  }
  const gesture = ctx.plainClickOpens && !ctx.tracking ? t("links.text.gestureClick") : t("links.text.gestureAccel");
  const where = destination === "engine" ? t("links.text.engine", { machine: ctx.machineName }) : destination === "client" ? t("links.text.client") : t("links.text.external");
  const more = [...(destination === "external" ? [] : [t("links.text.gestureExternal")]), t("links.text.gestureMenu")].join(" · ");
  return {
    url: shortenUrl(target.url, cfg.tooltipMaxChars),
    lines: [`${gesture}: ${where}`, more, ...(ctx.shown !== null ? [t("links.text.deceptive", { shown: shortenUrl(ctx.shown, cfg.tooltipMaxChars) })] : [])],
    openable: true,
  };
}

// ---- Yollar: a local file path a program printed ("open ~/Documents/rapor/index.html", "src/a.ts") ----

/** What activating a path does. */
export type PathAction =
  /** The project's browser, through the engine's preview address (pages; pictures, video, PDFs outside the project). */
  | "browser"
  /** Dosyalar: selected there and shown in the large preview. */
  | "files"
  /** A click does nothing; the menu may still offer something. */
  | "none";

/**
 * By what the engine found: a page goes to the browser; a picture, video, sound or PDF to Dosyalar when it is in
 * the project's folder, else to the browser; any other file to Dosyalar when it is in the folder; everything else
 * (folders, other files elsewhere, refused folders) is for the menu only.
 */
export function pathAction(location: FileLocation): PathAction {
  const inFolder = location.rootPath !== undefined;
  if (location.kind === "page") return location.browser ? "browser" : "none";
  if (location.kind === "media") return inFolder ? "files" : location.browser ? "browser" : "none";
  if (location.kind === "file") return inFolder ? "files" : "none";
  return "none";
}

/** What the right-click menu of a path offers besides "Yolu kopyala". */
export function pathMenuOffers(location: FileLocation | undefined, destination: LinkDestination): { browser: boolean; files: boolean } {
  if (!location || destination === "external") return { browser: false, files: false };
  return { browser: location.browser && location.kind !== "dir", files: location.rootPath !== undefined };
}

/** What is known about a path: nothing yet (the engine is asked only when the user acts), found, or not. */
export type PathState = { status: "pending" } | { status: "found"; location: FileLocation } | { status: "failed"; message: string };

/**
 * What hovering a path shows: the path (the file's real place once the engine said so) and where a click takes it.
 * `written` is the path as the program wrote it.
 */
export function pathTooltip(written: string, state: PathState, destination: LinkDestination, ctx: Omit<TooltipContext, "shown">, cfg: LinksConfig): LinkTooltip {
  const short = (path: string): string => shortenUrl(path, cfg.tooltipMaxChars);
  // SSH (and app-only) projects: the file is not on a machine Kokpit reads files from.
  if (destination === "external") return { url: short(written), lines: [`${t("links.text.pathRemote")} · ${t("links.text.pathCopy")}`], openable: false };
  if (state.status === "failed") return { url: short(written), lines: [`${state.message} · ${t("links.text.pathCopy")}`], openable: false };
  const gesture = ctx.plainClickOpens && !ctx.tracking ? t("links.text.gestureClick") : t("links.text.gestureAccel");
  const browser = destination === "engine" ? t("links.text.engine", { machine: ctx.machineName }) : t("links.text.client");
  if (state.status === "pending") {
    return { url: short(written), lines: [`${gesture}: ${isWebPagePath(written) ? browser : t("links.text.pathByType")}`, t("links.text.gestureMenu")], openable: true };
  }
  const action = pathAction(state.location);
  const url = short(state.location.path);
  if (action === "none") {
    const offers = pathMenuOffers(state.location, destination);
    return { url, lines: [`${state.location.browserRefusal ?? t("links.text.pathMenuOnly")} · ${offers.browser || offers.files ? t("links.text.gestureMenu") : t("links.text.pathCopy")}`], openable: false };
  }
  return { url, lines: [`${gesture}: ${action === "browser" ? browser : t("links.text.pathFiles")}`, t("links.text.gestureMenu")], openable: true };
}
