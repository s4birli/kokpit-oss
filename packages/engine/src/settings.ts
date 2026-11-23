// SettingsService: engine-wide settings (the global default tool).
// The initial default comes from tools.defaults.json and is seeded once; after
// that only the user changes it. A stored null means the user chose "plain shell".
import type { ParamsOf, Settings, Tool } from "@kokpit/shared";
import { engineError, type Logger, type SettingsService, type StateStore } from "./contracts.ts";

/** Seed key in StateStore: the initial default tool was applied. */
const SEED_KEY = "default-settings";

export interface SettingsServiceDeps {
  store: StateStore;
  logger: Logger;
  tools: { get(toolId: string): Tool | undefined };
  /** Tool id applied once as the global default when the user never chose one. */
  initialDefaultToolId: string;
}

export function createSettingsService(deps: SettingsServiceDeps): SettingsService {
  const { store, logger, tools } = deps;


  function get(): Settings {
    const id = store.getSettings().defaultToolId;
    return {
      ...(id != null && tools.get(id) ? { defaultToolId: id } : {}),
    };
  }

  return {
    init(): void {
      if (store.isSeeded(SEED_KEY)) return;
      const id = deps.initialDefaultToolId;
      if (store.getSettings().defaultToolId === undefined && tools.get(id)) {
        store.updateSettings({ defaultToolId: id });
      }
      store.markSeeded(SEED_KEY);
    },

    get,

    update(input: ParamsOf<"settings.update">): Settings {
      const id = input.defaultToolId;
      if (id != null && !tools.get(id)) throw engineError("NOT_FOUND", "engine.settings.toolNotFound");
      const patch = {
        ...(id !== undefined ? { defaultToolId: id } : {}),
      };
      store.updateSettings(patch);
      logger.info("settings updated", patch);
      return get();
    },

  };
}
