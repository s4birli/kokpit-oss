// İş B: protocol endpoints of the per-project browser. server.ts spreads `requests` into its handler map,
// routes `browser.input` / `browser.ack` frames to `onMessage`, and calls `dropConn` when a connection goes.
import type {
  BrowserClientMessage,
  BrowserResultMap,
  BrowserState,
  ParamsOf,
  Project,
  ServerMessage,
  Tool,
} from "@kokpit/shared";
import { webLinkUrl } from "@kokpit/shared";
import { commandStartsBrowser, linkOrigin, type BrowserManager } from "../browser.ts";
import { EngineError, engineError, type Logger } from "../contracts.ts";

type BrowserMethod = keyof BrowserResultMap;
/** Structural subset of the server's per-request context: the connection is only used as a key. */
interface BrowserCtx {
  conn: object;
}
type BrowserHandler<M extends BrowserMethod> = (ctx: BrowserCtx, params: ParamsOf<M>) => Promise<BrowserResultMap[M]> | BrowserResultMap[M];

export interface BrowserHandlerDeps {
  /** Absent in engines/tests without a browser: every request then answers INVALID (tabs: not running). */
  browsers: BrowserManager | undefined;
  requireProject(projectId: string): Project;
  send(conn: object, msg: ServerMessage): void;
  broadcast(msg: ServerMessage): void;
  logger: Logger;
  /** Programs (first word of a terminal's command) that also start the project's browser; [] = only `opensBrowser`. */
  startCommands: readonly string[];
  /**
   * Yollar: a local file as an address of the engine's own listener that the project's Chrome can load
   * (handlers/paths.ts). Absent = `browser.openFile` answers INVALID.
   */
  fileUrl?: ((ref: ParamsOf<"browser.openFile">) => Promise<{ projectId: string; url: string }>) | undefined;
}

export interface BrowserHandlers {
  requests: { [M in BrowserMethod]: BrowserHandler<M> };
  onMessage(conn: object, msg: BrowserClientMessage): void;
  dropConn(conn: object): void;
  /**
   * terminal.open: a tool with `opensBrowser`, or a command (the tool's or a raw one) running one of `startCommands`
   * (e.g. claude, whose browser plugins connect through the terminal's env), starts the project's engine browser
   * (best effort, not awaited).
   */
  onTerminalOpen(project: Project, tool: Tool | undefined, command?: string): void;
  stop(): void;
}

const NOT_RUNNING: BrowserState = { running: false, tabs: [] };

export function createBrowserHandlers(deps: BrowserHandlerDeps): BrowserHandlers {
  const { browsers, send, broadcast, logger } = deps;
  const requireProject = (projectId: string): Project => deps.requireProject(projectId);
  const unsubscribe = browsers?.onChange((projectId) => broadcast({ type: "event", name: "browser.changed", projectId })) ?? (() => {});

  function manager(): BrowserManager {
    if (!browsers) throw engineError("INVALID", "engine.handlers.browser.none");
    return browsers;
  }

  /** The project must exist and run its browser on the engine. */
  function engineProject(projectId: string): string {
    const project = requireProject(projectId);
    if (project.browser?.runOn === "client") {
      throw engineError("INVALID", "engine.handlers.browser.clientSide");
    }
    return project.id;
  }

  /** The state as the asking connection sees it: whether IT drives the page's viewport. */
  const browser = async ({ conn }: BrowserCtx, projectId: string, state: (m: BrowserManager, id: string) => Promise<BrowserState>) => {
    const m = manager();
    const id = engineProject(projectId);
    return { browser: { ...(await state(m, id)), viewportOwner: m.isViewportOwner(id, conn) } };
  };

  const requests: BrowserHandlers["requests"] = {
    "browser.open": (c, p) => browser(c, p.projectId, (m, id) => m.open(id)),
    "browser.close": async (_c, p) => {
      await manager().close(requireProject(p.projectId).id);
      return {};
    },
    "browser.tabs": async ({ conn }, p) => {
      // Also for a project whose browser opens on the app's machine: it just is not running here.
      const id = requireProject(p.projectId).id;
      return browsers ? { browser: { ...(await browsers.state(id)), viewportOwner: browsers.isViewportOwner(id, conn) } } : { browser: NOT_RUNNING };
    },
    "browser.navigate": (c, p) => browser(c, p.projectId, (m, id) => m.navigate(id, p.url)),
    "browser.back": (c, p) => browser(c, p.projectId, (m, id) => m.back(id)),
    "browser.forward": (c, p) => browser(c, p.projectId, (m, id) => m.forward(id)),
    "browser.reload": (c, p) => browser(c, p.projectId, (m, id) => m.reload(id, p.ignoreCache === true)),
    "browser.selectTab": (c, p) => browser(c, p.projectId, (m, id) => m.selectTab(id, p.tabId)),
    "browser.newTab": (c, p) => browser(c, p.projectId, (m, id) => m.newTab(id, p.url)),
    // Bağlantılar: a link the user chose in a terminal. Only the origin is logged — a path or query may hold a token.
    "browser.openUrl": (c, p) =>
      browser(c, p.projectId, async (m, id) => {
        const url = webLinkUrl(p.url);
        if (url === null) throw engineError("INVALID", "engine.handlers.browser.httpOnly");
        const state = await m.openUrl(id, url);
        logger.info("browser link opened", { projectId: id, origin: linkOrigin(url) });
        return state;
      }),
    // Yollar: a page (or picture, video, PDF) on this machine. The address holds a token: nothing of it is logged.
    "browser.openFile": async (c, p) => {
      if (!deps.fileUrl) throw engineError("INVALID", "engine.handlers.browser.filesNotInBrowser");
      manager();
      const { projectId, url } = await deps.fileUrl(p);
      return browser(c, projectId, async (m, id) => {
        const state = await m.openUrl(id, url);
        logger.info("browser file opened", { projectId: id });
        return state;
      });
    },
    "browser.closeTab": (c, p) => browser(c, p.projectId, (m, id) => m.closeTab(id, p.tabId)),
    "browser.screencast.start": async ({ conn }, p) => {
      const { projectId, maxWidth, maxHeight, quality } = p;
      await manager().subscribe(engineProject(projectId), conn, { maxWidth, maxHeight, quality }, (msg) => send(conn, msg));
      return {};
    },
    "browser.screencast.stop": ({ conn }, p) => {
      browsers?.unsubscribe(requireProject(p.projectId).id, conn);
      return {};
    },
    "browser.extensions.list": async (_c, p) => {
      const id = engineProject(p.projectId);
      return { extensions: browsers ? await browsers.extensions(id) : [] };
    },
    "browser.extensions.loadUnpacked": async (_c, p) => ({
      extensions: await manager().loadExtension(engineProject(p.projectId), p.path),
    }),
    "browser.extensions.remove": async (_c, p) => ({
      extensions: await manager().removeExtension(engineProject(p.projectId), p.path),
    }),
    "browser.zoom.set": (_c, p) => manager().setZoom(engineProject(p.projectId), p.zoom, p.mode),
    "browser.viewport.set": async ({ conn }, p) => {
      const { projectId, width, height, interaction } = p;
      return { applied: await manager().setViewport(engineProject(projectId), { width, height }, { key: conn, interaction: interaction === true }) };
    },
    "browser.showWindow": async (_c, p) => {
      await manager().showWindow(engineProject(p.projectId));
      return {};
    },
    // Kopyalama: the page's selection out, clipboard text in. Never logged — not even their sizes with the project.
    "browser.copy": async (_c, p) => ({ text: await manager().copySelection(engineProject(p.projectId), { cut: p.cut === true }) }),
    "browser.paste": async (_c, p) => {
      await manager().pasteText(engineProject(p.projectId), p.text);
      return {};
    },
    "browser.context": (_c, p) => manager().contextAt(engineProject(p.projectId), { x: p.x, y: p.y }),
  };

  return {
    requests,
    onMessage(conn, msg) {
      if (!browsers) return;
      if (msg.type === "browser.ack") {
        browsers.ack(msg.projectId, conn, msg.frameId);
        return;
      }
      browsers.input(msg.projectId, msg.event).catch((err: unknown) => {
        // A click racing a closed browser is normal; anything else is worth a line in the log.
        if (err instanceof EngineError && err.code === "NOT_FOUND") return;
        logger.warn("browser input failed", { projectId: msg.projectId, err: err instanceof Error ? err.message : String(err) });
      });
    },
    dropConn(conn) {
      browsers?.unsubscribeAll(conn);
    },
    onTerminalOpen(project, tool, command) {
      const program = command ?? tool?.command;
      const wanted = tool?.opensBrowser === true || (program !== undefined && commandStartsBrowser(program, deps.startCommands));
      // Same rule as KOKPIT_CDP_URL (browserTerminalEnv): only local terminals of engine-side browsers.
      if (!browsers || !wanted || project.location.kind === "ssh") return;
      if (project.browser?.runOn === "client") return;
      browsers.open(project.id).catch((err: unknown) => {
        logger.warn("starting the browser for a terminal failed", { projectId: project.id, err: err instanceof Error ? err.message : String(err) });
      });
    },
    stop: unsubscribe,
  };
}
