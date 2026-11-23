// Optional engine modules: what one contributes to the engine, so main.ts wires every module the same way and a
// build without it (kokpit.features.json) has nothing of it. A module is created only when its feature is on.
import type { Project, Tool } from "@kokpit/shared";
import type { EngineServerDeps } from "./server.ts";

export interface ModuleLaunch {
  /** Placeholders for the tool's command (`expandPlaceholders`). */
  placeholders?: Record<string, string>;
  /** Called when the terminal exits, or its launch failed. Safe to call more than once. */
  release(): void;
}

export interface EngineModule {
  /** Its id in kokpit.features.json (for logs). */
  id: string;
  /** Server dependencies it provides; the server registers their request handlers. */
  server?: Partial<EngineServerDeps>;
  /** A project is about to be deleted: nothing may keep acting in its name. */
  forgetProject?(projectId: string): void;
  /** A terminal starts `tool` (not an explicit command) in `project`. May throw EngineError to refuse it. */
  prepareLaunch?(tool: Tool | undefined, project: Project): ModuleLaunch | undefined;
  /** Engine shutdown; modules stop in the reverse order of creation. */
  shutdown?(): Promise<void> | void;
}

/** The server dependencies of every module, merged (a later module's key wins; ids never collide in practice). */
export function moduleServerDeps(modules: readonly EngineModule[]): Partial<EngineServerDeps> {
  return Object.assign({}, ...modules.map((m) => m.server ?? {})) as Partial<EngineServerDeps>;
}

/** Every module's launch preparation for one terminal; if one throws, those already prepared are released. */
export function prepareModuleLaunch(modules: readonly EngineModule[], tool: Tool | undefined, project: Project): ModuleLaunch {
  const prepared: ModuleLaunch[] = [];
  try {
    for (const m of modules) {
      const p = m.prepareLaunch?.(tool, project);
      if (p) prepared.push(p);
    }
  } catch (err) {
    for (const p of prepared) p.release();
    throw err;
  }
  return {
    placeholders: Object.assign({}, ...prepared.map((p) => p.placeholders ?? {})) as Record<string, string>,
    release: () => {
      for (const p of prepared) p.release();
    },
  };
}

/** Shuts modules down newest first (a module may use an older one until it is stopped). */
export async function shutdownModules(modules: readonly EngineModule[], onError: (id: string, err: unknown) => void): Promise<void> {
  for (const m of [...modules].reverse()) {
    try {
      await m.shutdown?.();
    } catch (err) {
      onError(m.id, err);
    }
  }
}
