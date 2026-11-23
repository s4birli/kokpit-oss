// Dosyalar — medya: which engine the app is connected to, as the main process knows it. The page connects only with
// settings it loaded from the settings store, so the address last loaded or saved there is the engine's; the
// window's request guard (frame-guard.ts) lets media load from that origin only.
import { engineHttpOrigin } from "./frame-guard.ts";
import type { SettingsStore } from "./settings-store.ts";

export interface EngineOriginTracker {
  /** The settings store, with every load / save / clear noted. */
  store: SettingsStore;
  /** `http(s)://host:port` of the engine's listener, or null while no address is known. */
  origin(): string | null;
}

export function trackEngineOrigin(inner: SettingsStore): EngineOriginTracker {
  let origin: string | null = null;
  const load: SettingsStore["load"] = async () => {
    const settings = await inner.load();
    origin = engineHttpOrigin(settings?.url);
    return settings;
  };
  return {
    origin: () => origin,
    store: {
      ...inner,
      load,
      async save(input) {
        await inner.save(input);
        // What was stored, not what was asked for: the store validates and normalises.
        await load();
      },
      async clear() {
        await inner.clear();
        origin = null;
      },
    },
  };
}
