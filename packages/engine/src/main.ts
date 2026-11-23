// Engine entry point: load config, wire the modules, listen, shut down cleanly.
// Run with `node packages/engine/src/main.ts` (Node strips the TypeScript types).
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createActivityTracker, withActivity } from "./activity.ts";
import { join } from "node:path";
import { browserTerminalEnv, chromeProbeOnce, createBrowserManager } from "./browser.ts";
import { moduleServerDeps, prepareModuleLaunch, shutdownModules, type EngineModule } from "./engine-module.ts";
import { BUILD_FEATURE_FILE, featuresFromEnv } from "@kokpit/shared";
import { createKeychain } from "./keychain.ts"; // Girişler
import { createLoginService } from "./logins.ts"; // Girişler
import { agentsPresentIn } from "./login-agents.ts"; // Girişler
import { createCardService } from "./cards.ts";
import { dataPaths, hostPaths as resolveHostPaths, loadConfig } from "./config.ts";
import * as git from "./git.ts";
import { quoteShellArg, resolveLaunch } from "./launch.ts";
import { createClaudeAccountService } from "./claude-accounts.ts";
import { createClaudeBrowserSettings } from "./claude-settings.ts";
import { createLogger } from "./logger.ts";
import { localClientAddress } from "./net.ts";
import { createMapService, loadMapConfig } from "./map.ts";
import { createPlaywrightOutputSweeper, playwrightOutputBaseDir, playwrightOutputDirFor } from "./playwright-output.ts";
import { createFileService, loadFilesConfig } from "./files.ts";
import { createMediaService } from "./files-media.ts";
import { createPreviewService } from "./files-preview.ts"; // Yollar
import { createCwdLookup, createPathLocator } from "./local-paths.ts"; // Yollar
import { createTerminalOpen } from "./terminal-open.ts"; // Yollar
import { fileURLToPath } from "node:url";
import { createFlowService, loadFlowConfig } from "./flow.ts"; // İş W
import { createClaudeInventory, loadClaudeInventoryConfig } from "./claude-inventory.ts";
import { appUpdatesDir, createAppUpdateService, loadAppUpdatesConfig } from "./app-updates.ts"; // Kendini güncelleme
import { computeBuildInfo } from "@kokpit/shared/build-info"; // Kendini güncelleme
import { createClaudeUsageService, loadClaudeUsageConfig } from "./claude-usage.ts";
import { browserWindowOf, type Project } from "@kokpit/shared";
import { createProjectService } from "./projects.ts";
import { createPtyManager } from "./pty.ts";
import { createBgAgentsService } from "./bg-agents.ts";
import { createEngineServer } from "./server.ts";
import { createSettingsService } from "./settings.ts";
import { createSshHostService } from "./ssh.ts";
import { createFileStore } from "./store.ts";
import { clockFromEnv, createTodoService } from "./todos.ts";
import { createToolService, loadToolDefaults } from "./tools.ts";
import { setLocale } from "@kokpit/shared/i18n";

const PACKAGE_JSON = new URL("../package.json", import.meta.url);
const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as { version: string };

async function main(): Promise<void> {
  // KOKPIT_LOG_DEBUG=1 also writes debug lines (e.g. every tick of "oturumu açık tut").
  const logger = createLogger({ debug: process.env.KOKPIT_LOG_DEBUG === "1" });
  const config = await loadConfig({ logger });
  // i18n: the engine's own text (notices, result messages, its errors' `message`) is in the configured language.
  setLocale(config.language);
  const paths = dataPaths(config);
  const hostPaths = resolveHostPaths();
  const store = createFileStore(paths.stateFile, logger);
  const { tunables } = config;
  // Optional modules (kokpit.features.json, narrowed by KOKPIT_FEATURES): one that is off is never created.
  const features = featuresFromEnv(BUILD_FEATURE_FILE, process.env);
  const modules: EngineModule[] = [];

  // İş C (Adım 8): Claude envanteri — read from the project's Claude account (İş H); a non-default account may
  // symlink its skills into the default account's dir (shared roots). Called after `claudeAccounts` exists.
  const claudeInventoryConfig = loadClaudeInventoryConfig(config.claudeInventory);
  const claudeInventoryService = () =>
    createClaudeInventory({
      config: claudeInventoryConfig,
      homeDir: hostPaths.homeDir,
      configDirFor: (project) => claudeAccounts.configDirFor(project),
      sharedRoots: (project) => claudeAccounts.sharedRootsFor(project),
    });

  // İş A: activity tracking wraps the PtyManager; patterns are read from the tools on every check.
  const toolDefaults = loadToolDefaults();
  const activity = createActivityTracker({
    ...tunables.activity,
    logger,
    patternsFor: (toolId) =>
      (toolId !== undefined ? store.getTool(toolId)?.waitingPatterns : undefined) ?? toolDefaults.genericWaitingPatterns,
  });
  const ptys = withActivity(
    createPtyManager({
      config,
      paths,
      store,
      logger,
      flushIntervalMs: tunables.flushIntervalMs,
      killGraceMs: tunables.killGraceMs,
      ...(tunables.terminalZdotdir !== undefined ? { zdotdir: tunables.terminalZdotdir } : {}),
    }),
    activity,
  );

  // Usage counts read the store directly so services don't depend on each other in a cycle.
  const projectsUsingHost = (hostId: string) =>
    store.listProjects().filter((p) => p.location.kind === "ssh" && p.location.hostId === hostId).length;
  const projectsUsingTool = (toolId: string) => store.listProjects().filter((p) => p.defaultToolId === toolId).length;
  const isGlobalDefault = (toolId: string) => store.getSettings().defaultToolId === toolId;

  const sshHosts = createSshHostService({ hostPaths, store, logger, projectsUsingHost });

  const tools = createToolService({
    config,
    store,
    logger,
    projectsUsingTool,
    isGlobalDefault,
    defaults: toolDefaults.tools,
    checkTimeoutMs: toolDefaults.checkTimeoutMs,
    idMaxLen: toolDefaults.idMaxLen,
    idFallback: toolDefaults.idFallback,
    laterSteps: toolDefaults.laterSteps,
    waitingPatternSteps: toolDefaults.waitingPatternSteps,
    files: toolDefaults.files,
    fileArgs: toolDefaults.fileArgs,
  });
  tools.init();

  // After tools.init: the initial default is applied only if that tool exists.
  const settings = createSettingsService({
    store,
    logger,
    tools: { get: (id) => tools.get(id) },
    initialDefaultToolId: toolDefaults.defaultToolId,
  });
  settings.init();

  // İş B: per-project Chrome.
  // Adım 9 İş T: Playwright MCP output — one folder per project under the engine user's per-user temp dir (macOS:
  // /var/folders/…/T) or the configured parent, never the project folder; swept at start and periodically.
  const playwrightOutputBase = playwrightOutputBaseDir(config.browser, tmpdir());
  const playwrightOutputSweeper = createPlaywrightOutputSweeper({
    baseDir: playwrightOutputBase,
    retentionDays: config.browser.playwrightMcpOutputRetentionDays,
    intervalMs: config.browser.playwrightMcpOutputSweepIntervalMs,
    maxEntries: config.browser.playwrightMcpOutputSweepMaxEntries,
    logger,
  });
  const browserEnvOptions = {
    cdpEndpointEnv: config.browser.playwrightMcpCdpEndpointEnv,
    outputDirEnv: config.browser.playwrightMcpOutputDirEnv,
    outputDirFor: (projectId: string): string | null => {
      try {
        return playwrightOutputDirFor(playwrightOutputBase, projectId);
      } catch {
        logger.warn("proje kimliği klasör adı olamıyor; Playwright çıktı klasörü verilmedi", { projectId });
        return null;
      }
    },
  };
  // Gizli tarayıcı kimliği: the installed Chrome is asked once for both managers below.
  const chromeProbe = chromeProbeOnce(config.browser);
  const browsers = createBrowserManager({
    config: config.browser,
    chromeProbe,
    dataDir: config.dataDir,
    logger,
    extensionStore: store,
    portStore: store,
    zoomStore: store,
    // Adım 9 İş A: a started browser's address goes into the project's Claude settings file.
    onStarted: (projectId) => claudeBrowserSettings.sync(projectId, { started: true }),
    // Gizli tarayıcı: each project's Chrome runs hidden (no window on this Mac's screen) unless set to visible.
    windowOf: (projectId) => {
      const project = projects.get(projectId);
      return project ? browserWindowOf(project) : "hidden";
    },
  });
  /** The browser env of a project's local terminals — the one place it is computed (terminals and settings file). */
  const browserEnvFor = (project: Project) => browserTerminalEnv(project, (id) => browsers.cdpUrlFor(id), browserEnvOptions);

  // Girişler: saved logins of the project browsers — passwords in this Mac's Keychain (`security`), metadata in the state.
  const logins = createLoginService({
    config: config.logins,
    store,
    keychain: createKeychain({ config: config.logins }),
    page: browsers,
    logger,
    // "An agent runs in this project right now": any terminal of the project or its cards, or a background Claude
    // session in its folder. Only strengthens the warning and asks again per fill — the per-project acceptance is
    // required regardless (the DevTools port is reachable by every program of this user).
    agentsPresent: (projectId) =>
      agentsPresentIn(projectId, {
        terminalCount: (id) => ptys.list({ projectId: id }).length,
        bgSessions: async () => (await bgAgents.list()).sessions,
      }),
  });


  // ---- İş H: Claude accounts (one config dir per subscription) ----
  const claudeAccounts = createClaudeAccountService({ store, logger, homeDir: hostPaths.homeDir, tunables: config.claudeAccounts });
  claudeAccounts.init();

  // Dosyalar: browsing, and streaming of media files for in-app viewing (same path rules).
  const filesConfig = loadFilesConfig(config.files);
  const files = createFileService({ config: filesConfig });
  const media = createMediaService({ config: filesConfig.media, resolve: files.resolve, logger });
  // Yollar: a local page served for a project's browser, paths a terminal printed, and `open` inside a terminal.
  const preview = createPreviewService({ config: filesConfig.preview, homeDir: hostPaths.homeDir, logger });
  const pathLocator = createPathLocator({
    config: filesConfig.paths,
    homeDir: hostPaths.homeDir,
    resolveInRoot: files.resolve,
    mediaKindOf: media.kindOf,
    preview,
  });
  const terminalOpen = createTerminalOpen({
    config: filesConfig.open,
    engineDir: fileURLToPath(new URL("..", import.meta.url)),
    shell: config.shell,
    userZdotdir: tunables.terminalZdotdir,
    env: process.env,
    // The shim runs on this machine: loopback when the engine listens there, else its Tailscale address.
    endpoint: () => localClientAddress(server.addresses()),
    logger,
  });

  const projects = createProjectService({
    claudeAccounts, // İş H
    config,
    paths,
    hostPaths,
    store,
    logger,
    sshHosts: { get: (id) => sshHosts.get(id) },
    tools: { get: (id) => tools.get(id) },
    git: { clone: (url, dest) => git.clone(url, dest, tunables.gitCloneTimeoutMs) },
    onBeforeDelete: (projectId) => {
      ptys.closeAllForProject(projectId);
      for (const m of modules) m.forgetProject?.(projectId); // nothing may keep acting for a project that is gone
      terminalOpen.revokeProject(projectId); // Yollar: nor show anything in its name
      preview.revokeProject(projectId);
      void browsers.close(projectId).catch(() => {});
      store.setBrowserExtensions(projectId, []);
      claudeBrowserSettings.forget(projectId);
      store.setBrowserPort(projectId, undefined);
      store.setBrowserZoom(projectId, undefined);
      logins.forgetProject(projectId); // Girişler: its Keychain items go with it
    },
    onAfterUpdate: (project, previous) => {
      claudeBrowserSettings.sync(project.id);
      // Gizli tarayıcı: a running Chrome follows the new window mode (restarted; its tabs come back).
      if (browserWindowOf(project) !== browserWindowOf(previous)) {
        browsers.applyWindow(project.id).catch((err: unknown) =>
          logger.warn("applying the browser window mode failed", { projectId: project.id, err: err instanceof Error ? err.message : String(err) }),
        );
      }
    },
    browserProject: {
      id: config.browser.projectId,
      name: config.browser.projectName,
      path: join(config.dataDir, config.browser.workspaceDirName),
    },
  });
  await projects.init();

  // Adım 9 İş A: background Claude sessions do not inherit a terminal's env; they read the project's settings file.
  const claudeBrowserSettings = createClaudeBrowserSettings({
    path: config.browser.claudeSettingsPath,
    store,
    logger,
    getProject: (id) => projects.get(id),
    envFor: browserEnvFor,
    isRunning: (id) => browsers.isRunning(id),
    // A project whose folder is the home dir would otherwise put the file into Claude's own config dir.
    protectedDirs: () => claudeAccounts.distinctDirs().map((a) => a.configDir),
  });
  claudeBrowserSettings.syncAll();

  const cards = createCardService({
    config,
    paths,
    store,
    logger,
    slugMaxLen: tunables.slugMaxLen,
    slugFallback: tunables.slugFallback,
    onBeforeRemove: (cardId) => ptys.closeAllForCard(cardId),
  });

  // ---- todos ---- (clock pinnable via KOKPIT_TEST_NOW for end-to-end tests only)
  const todos = createTodoService({ store, now: clockFromEnv(process.env), projectExists: (id) => !!projects.get(id) });

  // ---- İş A (Adım 7): background Claude sessions ----
  const bgAgents = createBgAgentsService({
    ...tunables.bgAgents,
    logger,
    projects: { list: () => projects.list() },
    cards: { list: () => store.listCards() },
    builtinProjectId: tunables.builtinProjectId,
    accounts: () => claudeAccounts.distinctDirs(), // İş H
  });

  // ---- Claude kullanımı: per account, counted from its own session transcripts (numbers only) ----
  const claudeUsage = createClaudeUsageService({
    config: loadClaudeUsageConfig(config.claudeUsage),
    dataDir: config.dataDir,
    logger,
    accounts: () => claudeAccounts.list().map((a) => ({ accountId: a.id, name: a.name, configDir: a.configDir, isDefault: !!a.isDefault })),
    projects: () => projects.list(),
    cards: () => store.listCards(),
    claudeBinary: tunables.bgAgents.claudeBinary,
  });

  // Kendini güncelleme: the engine runs its TypeScript as checked out, so "the build" is this start: package
  // version + the commit the code is at + now. The published app build lives under the data dir.
  const build = computeBuildInfo({ packageJsonPath: fileURLToPath(PACKAGE_JSON) });
  const appUpdatesConfig = loadAppUpdatesConfig(config.appUpdates);
  const appUpdates = createAppUpdateService({ config: appUpdatesConfig, dir: appUpdatesDir(appUpdatesConfig, config.dataDir), engineBuild: build, logger });

  const server = createEngineServer({
    build,
    appUpdates,
    // İş H
    claudeAccounts: {
      service: claudeAccounts,
      loginCommand: [tunables.bgAgents.claudeBinary, ...config.claudeAccounts.loginArgs].map(quoteShellArg).join(" "),
    },
    bgAgents,
    claudeUsage,
    todos,
    config,
    store,
    projects,
    sshHosts,
    tools,
    settings,
    cards,
    ptys,
    logger,
    version: pkg.version,
    builtinProjectId: tunables.builtinProjectId,
    map: createMapService({ config: loadMapConfig(config.map), logger }),
    files,
    media,
    paths: { locator: pathLocator, preview, cwd: createCwdLookup({ config: filesConfig.paths, logger }) },
    terminalOpen,
    flow: createFlowService({ config: loadFlowConfig(config.flow, toolDefaults.fileArgs) }), // İş W
    claudeInventory: claudeInventoryService(),
    activity,
    resolveLaunch: (input) => {
      // Modules may prepare a tool launch (e.g. its own config file), or refuse it. An explicit command is never a
      // tool launch, so it never gets one.
      const mcp = input.command === undefined ? prepareModuleLaunch(modules, input.tool, input.project) : undefined;
      // Yollar: this terminal's own credential for `open` (local terminals of projects whose browser runs here).
      let opener: ReturnType<typeof terminalOpen.prepare>;
      const release = (): void => {
        mcp?.release();
        opener?.release();
      };
      try {
        const spec = resolveLaunch({
          ...input,
          config,
          hostPaths,
          sshBinary: tunables.sshBinary,
          placeholders: { ...toolDefaults.fileArgs, ...mcp?.placeholders },
        });
        const env = browserEnvFor(input.project);
        const account = claudeAccounts.envFor(input.project, input.claudeAccountId); // İş H
        opener = terminalOpen.prepare(input.project, input.card);
        return { ...spec, env: { ...spec.env, ...opener?.env, ...env, ...account }, onExit: release };
      } catch (err) {
        release();
        throw err;
      }
    },
    browsers,
    logins,
    browserStartCommands: config.browser.startForCommands,
    features,
    ...moduleServerDeps(modules),
  });

  await server.start();
  playwrightOutputSweeper.start(); // background: never delays or fails startup
  logger.info("listening", { addresses: server.addresses(), dataDir: config.dataDir, projects: projects.list().length, buildId: build.buildId, modules: modules.map((m) => m.id) });

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info("stopping", { signal });
    try {
      await server.stop();
      bgAgents.dispose();
      await claudeUsage.dispose();
      playwrightOutputSweeper.dispose();
      await logins.idle(); // a Keychain write in flight finishes before the process goes
      await browsers.shutdown();
      await shutdownModules(modules, (id, err) => logger.warn("module shutdown failed", { module: id, err: err instanceof Error ? err.message : String(err) }));
      terminalOpen.shutdown();
      await ptys.shutdown();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`kokpit-engine: ${msg}\n`);
  process.exit(1);
});
