// Bağlantılar — opens a link the user chose in a terminal, where that TERMINAL'S project says: the project's Chrome
// on the engine machine (`browser.openUrl`), this machine's profile Chrome, or the default browser. One opener per
// app window (the Workbench makes it); each terminal gets a view of it bound to its own project.
// Only http(s) is ever opened; the address is validated here, and again by main and by the engine.
//
// Yollar: a local file path a program printed is resolved by the ENGINE (the file is on its machine), and only when
// the user acts on the link — the answer is kept for `pathCacheMs`, so resting the pointer on a path asks once. A
// page opens in the project's browser through the engine's preview address (`browser.openFile`; the address never
// passes through the app). A project whose browser runs on THIS machine gets the address from `files.previewUrl`
// and joins it to the engine it is connected to. Files of the project's folder are shown in Dosyalar.
import { createRateLimiter, parseLinkTarget, type BrowserState, type FileLocation, type Project } from "@kokpit/shared";
import { createContext, useContext } from "react";
import { t } from "../../i18n/index.ts";
import { type LinkMenuChoice, type LinksBridge, type LinksConfig } from "../engine/links-ipc.ts";
import type { EngineClient } from "../engine/types.ts";
import { errorMessage } from "./errors.ts";
import { linkDestination, pathAction, pathMenuOffers, type LinkDestination, type PathState } from "./link-actions.ts";
import { engineHttpUrl } from "./map-url.ts";

/** A path as the terminal shows it (FoundPath): the path and what follows it on the line. */
export interface PathLinkRef {
  path: string;
  tail: string;
}

/** What a terminal needs to act on the file paths in its output. */
export interface TerminalPathHost {
  /** What is known without asking the engine: a fresh answer, or undefined. */
  peek(ref: PathLinkRef): PathState | undefined;
  /** Asks the engine what the path points at (once per `pathCacheMs`). Never rejects. */
  resolve(ref: PathLinkRef): Promise<PathState>;
  /**
   * Opens the path — as the result of a user gesture only. "auto": what a click does (pathAction); "browser" /
   * "files": the menu's choice. Rejects with an Error whose message is meant for the user.
   */
  open(ref: PathLinkRef, how: "auto" | "browser" | "files"): Promise<void>;
  /** Right click: the native menu; resolves with the choice ("copy" is already done), null = none. */
  menu(ref: PathLinkRef): Promise<LinkMenuChoice | null>;
}

/** What a terminal needs to act on its links. */
export interface TerminalLinkHost {
  /** Where an http(s) link of this terminal opens right now. */
  destination(): LinkDestination;
  machineName(): string;
  /**
   * Opens `url` — as the result of a user gesture only. "project": where the project's links go; "external": the
   * default browser. Rejects with an Error whose message is meant for the user.
   */
  open(url: string, where: "project" | "external"): Promise<void>;
  /** Right click: shows the native menu; resolves with the choice ("copy" is already done), null = none. */
  menu(url: string): Promise<LinkMenuChoice | null>;
  /** Yollar: present when the host knows which terminal it serves. */
  path?: TerminalPathHost;
}

export interface LinkOpener {
  /** `terminal`: the terminal whose output the links are in — needed for file paths (its folder decides). */
  forProject(projectId: string, terminal?: { id: string }): TerminalLinkHost;
}

export interface LinkOpenerDeps {
  client: Pick<EngineClient, "request">;
  /** The project as the app knows it now. */
  project(projectId: string): Project | undefined;
  /** Around `browser.openUrl`: the Workbench prepares the Tarayıcı panel, then shows it. */
  engineOpen: {
    before(projectId: string, url: string): void;
    after(projectId: string, browser: BrowserState): void;
  };
  /** `window.kokpit.links`; absent outside Electron. */
  links: LinksBridge | undefined;
  /** `window.kokpit.browser.openLocal`; absent outside Electron. */
  openLocal: ((projectId: string, url: string) => Promise<void>) | undefined;
  config: LinksConfig;
  machineName: string;
  now?: () => number;
  /**
   * Yollar: shows a file of the project's (card's) folder in Dosyalar, selected and large. False when that project
   * is not the one on screen. Absent = Dosyalar cannot be driven here.
   */
  showFile?: (projectId: string, location: FileLocation) => boolean;
  /** Yollar: the ws:// address of the engine this window is connected to. */
  engineUrl?: () => string | undefined;
}

export function createLinkOpener(deps: LinkOpenerDeps): LinkOpener {
  const { config } = deps;
  // One allowance for the whole window: a gesture storm in several terminals is still a storm.
  const limiter = createRateLimiter({ ...config.rate, ...(deps.now ? { now: deps.now } : {}) });

  async function open(projectId: string, raw: string, where: "project" | "external"): Promise<void> {
    const target = parseLinkTarget(raw);
    if (target.kind === "file") throw new Error(t("links.text.refusedFile"));
    if (target.kind === "refused") {
      throw new Error(target.reason === "scheme" && target.scheme !== undefined ? t("links.text.refusedScheme", { scheme: target.scheme }) : t("links.text.refusedInvalid"));
    }
    if (!limiter.allow()) throw new Error(t("links.text.rateLimited"));
    const destination = where === "external" ? "external" : linkDestination(deps.project(projectId));
    const failed = (err: unknown): Error => new Error(t("links.text.failed", { error: errorMessage(err) }));
    if (destination === "engine") {
      deps.engineOpen.before(projectId, target.url);
      let browser: BrowserState;
      try {
        ({ browser } = await deps.client.request("browser.openUrl", { projectId, url: target.url }));
      } catch (err) {
        throw failed(err);
      }
      deps.engineOpen.after(projectId, browser);
      return;
    }
    if (destination === "client") {
      if (!deps.openLocal) throw new Error(t("links.text.noLocal"));
      await deps.openLocal(projectId, target.url).catch((err: unknown) => {
        throw failed(err);
      });
      return;
    }
    if (!deps.links) throw new Error(t("links.text.noExternal"));
    await deps.links.openExternal(target.url).catch((err: unknown) => {
      throw failed(err);
    });
  }

  const now = deps.now ?? Date.now;

  /** The file paths of one terminal. */
  function pathHost(projectId: string, terminalId: string): TerminalPathHost {
    const destination = (): LinkDestination => linkDestination(deps.project(projectId));
    /** By path + what follows it: the engine's answer, kept for `pathCacheMs`. */
    const cache = new Map<string, { at: number; state: PathState | undefined; pending: Promise<PathState> }>();
    const keyOf = (ref: PathLinkRef): string => `${ref.path}\n${ref.tail}`;
    const params = (ref: PathLinkRef) => ({ terminalId, path: ref.path, ...(ref.tail !== "" ? { tail: ref.tail } : {}) });
    const fresh = (ref: PathLinkRef) => {
      const t = now();
      for (const [key, entry] of cache) if (t - entry.at >= config.pathCacheMs) cache.delete(key);
      return cache.get(keyOf(ref));
    };

    function resolve(ref: PathLinkRef): Promise<PathState> {
      const hit = fresh(ref);
      if (hit) return hit.pending;
      if (destination() === "external") return Promise.resolve({ status: "failed", message: t("links.text.pathRemote") });
      const entry: { at: number; state: PathState | undefined; pending: Promise<PathState> } = {
        at: now(),
        state: undefined,
        pending: deps.client.request("files.locate", params(ref)).then(
          (location): PathState => ({ status: "found", location }),
          (err: unknown): PathState => ({ status: "failed", message: errorMessage(err) }),
        ),
      };
      void entry.pending.then((state) => {
        entry.state = state;
      });
      cache.set(keyOf(ref), entry);
      return entry.pending;
    }

    async function inBrowser(ref: PathLinkRef): Promise<void> {
      const where = destination();
      const failed = (err: unknown): Error => new Error(t("links.text.pathFailed", { error: errorMessage(err) }));
      if (where === "engine") {
        // No address to remember: the panel must not reselect an older tab over the one this opens.
        deps.engineOpen.before(projectId, "");
        let browser: BrowserState;
        try {
          ({ browser } = await deps.client.request("browser.openFile", params(ref)));
        } catch (err) {
          throw failed(err);
        }
        deps.engineOpen.after(projectId, browser);
        return;
      }
      if (where !== "client") throw new Error(t("links.text.pathRemote"));
      // The project's Chrome runs on this machine; the file is on the engine's: its listener serves it to us.
      if (!deps.openLocal) throw new Error(t("links.text.noLocal"));
      let path: string;
      try {
        ({ path } = await deps.client.request("files.previewUrl", params(ref)));
      } catch (err) {
        throw failed(err);
      }
      const url = engineHttpUrl(deps.engineUrl?.(), path);
      if (url === null) throw new Error(t("links.text.pathNoEngineAddress"));
      await deps.openLocal(projectId, url).catch((err: unknown) => {
        throw failed(err);
      });
    }

    async function open(ref: PathLinkRef, how: "auto" | "browser" | "files"): Promise<void> {
      const state = await resolve(ref);
      if (state.status !== "found") throw new Error(state.status === "failed" ? state.message : t("links.text.pathMissing"));
      const { location } = state;
      const action = how === "auto" ? pathAction(location) : how;
      if (action === "none") throw new Error(location.browserRefusal ?? t("links.text.pathMenuOnly"));
      // The menu's items are only offers: what the engine said decides, here as there.
      const offers = pathMenuOffers(location, destination());
      if ((action === "browser" && !offers.browser) || (action === "files" && !offers.files)) throw new Error(location.browserRefusal ?? t("links.text.pathMenuOnly"));
      if (!limiter.allow()) throw new Error(t("links.text.rateLimited"));
      if (action === "browser") return inBrowser(ref);
      if (!deps.showFile?.(projectId, location)) throw new Error(t("links.text.pathOtherProject"));
    }

    return {
      peek: (ref) => fresh(ref)?.state,
      resolve,
      open,
      async menu(ref) {
        if (!deps.links) return null;
        const state = await resolve(ref);
        const location = state.status === "found" ? state.location : undefined;
        return deps.links.menu({ path: location?.path ?? ref.path, ...pathMenuOffers(location, destination()) });
      },
    };
  }

  return {
    forProject(projectId, terminal) {
      const destination = (): LinkDestination => linkDestination(deps.project(projectId));
      return {
        destination,
        machineName: () => deps.machineName,
        open: (url, where) => open(projectId, url, where),
        menu: async (url) => (deps.links ? deps.links.menu({ url, browser: destination() !== "external" }) : null),
        ...(terminal ? { path: pathHost(projectId, terminal.id) } : {}),
      };
    },
  };
}

/** The window's opener; null where links are not wired (tests of single panels). */
export const LinkOpenerContext = createContext<LinkOpener | null>(null);
export function useLinkOpener(): LinkOpener | null {
  return useContext(LinkOpenerContext);
}
