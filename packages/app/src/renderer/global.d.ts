import type { LocalEngineBridge } from "./engine/local-engine-ipc.ts";
import type { LocalBrowserBridge } from "./engine/local-browser-ipc.ts";
import type { SettingsBridge } from "./engine/types.ts";
import type { UiStateBridge } from "./engine/ui-state-ipc.ts";
import type { MenuBridge } from "./engine/menu-ipc.ts";
import type { WebBridge } from "./engine/web-ipc.ts";
import type { WindowBridge } from "./engine/window-ipc.ts";
import type { ClipboardBridge } from "./engine/clipboard-ipc.ts";
import type { LinksBridge } from "./engine/links-ipc.ts";
import type { UpdateBridge } from "./engine/update-ipc.ts";
import type { LanguageBridge } from "./engine/i18n-ipc.ts";

declare global {
  interface Window {
    /** Injected by the preload script (src/preload/index.ts). */
    readonly kokpit: SettingsBridge & {
      readonly browser?: LocalBrowserBridge;
      readonly uiState?: UiStateBridge;
      /** İş M */
      readonly menu?: MenuBridge;
      readonly web?: WebBridge;
      /** Performans: whether the window can be seen (shown, not minimized). */
      readonly window?: WindowBridge;
      /** Kopyalama: write-only clipboard (terminal OSC 52, "Kopyala" context menu). */
      readonly clipboard?: ClipboardBridge;
      /** Bağlantılar: the default browser and the right-click menu for links of the terminals. */
      readonly links?: LinksBridge;
      /** Kendini güncelleme: the updater's state and the user's choices. */
      readonly update?: UpdateBridge;
      /** Yerel bağlantı. */
      readonly localEngine?: LocalEngineBridge;
      /** i18n: the language setting main keeps. */
      readonly i18n?: LanguageBridge;
    };
  }
}

export {};
