import { useCallback, useEffect, useState } from "react";
import { InsecureTransportOptIn } from "./connect/InsecureTransportOptIn.tsx";
import { ConnectScreen } from "./connect/ConnectScreen.tsx";
import { createEngineClient, type CreateClientOptions } from "./engine/client.ts";
import type { EngineClient, EngineSettings, SettingsBridge } from "./engine/types.ts";
import { Settings } from "./ui/settings/Settings.tsx";
import { SETTINGS_TABS, type SettingsTab } from "./ui/settings/tabs.ts";
import { useMenuCommand } from "./ui/menu/menu-commands.ts";
import type { TerminalViewFactory } from "./ui/terminal-view.ts";
import { Workbench } from "./ui/Workbench.tsx";
import { AboutSection } from "./ui/update/AboutSection.tsx";
import { defaultUpdateBridge } from "./ui/update/useUpdateStatus.ts";
import { useT, type MessageKey } from "../i18n/index.ts";

export interface AppProps {
  bridge: SettingsBridge;
  /** Injectable for tests. */
  createClient?: (settings: EngineSettings, opts?: CreateClientOptions) => EngineClient;
  /** Injectable for tests; defaults to xterm. */
  createView?: TerminalViewFactory;
}

type View =
  | { kind: "loading" }
  | { kind: "connect"; initialUrl?: string; notice?: MessageKey }
  /** `settingsTab` set = the settings screen is open over the (still mounted) workbench. */
  | { kind: "connected"; settings: EngineSettings; settingsTab: SettingsTab | null };

const UNAUTHORIZED_NOTICE: MessageKey = "connect.notice.unauthorized";
/** Kendini güncelleme: settings are stored but this build cannot read their key (macOS Keychain). */
const LOCKED_NOTICE: MessageKey = "connect.notice.locked";

export function App({ bridge, createClient = createEngineClient, createView }: AppProps) {
  const t = useT();
  const [view, setView] = useState<View>({ kind: "loading" });
  const [selectProject, setSelectProject] = useState<{ projectId: string; seq: number }>();

  useEffect(() => {
    let cancelled = false;
    bridge.load().then(
      async (settings) => {
        if (settings) return { kind: "connected", settings, settingsTab: null } as const;
        // Nothing usable: either nothing is stored, or it is stored and its key cannot be decrypted right now.
        const locked = await bridge.locked?.().catch(() => null);
        return locked ? ({ kind: "connect", initialUrl: locked.url, notice: LOCKED_NOTICE } as const) : ({ kind: "connect" } as const);
      },
      () => ({ kind: "connect" }) as const,
    ).then((next) => {
      if (!cancelled) setView(next);
    });
    // Kendini güncelleme: the page rendered — the health signal of a freshly installed build.
    defaultUpdateBridge()?.rendererReady().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  const settings = view.kind === "connected" ? view.settings : null;
  const [client, setClient] = useState<EngineClient | null>(null);

  useEffect(() => {
    if (!settings) return;
    // Every (re)connection passes main's transport gate first (connection-gate.ts): the key's handshake only starts
    // over this Mac, Tailscale or wss:// — or an address the user opted in for.
    const gate = bridge.connection;
    const c = createClient(settings, gate ? { checkTransport: (url) => gate.check(url) } : {});
    const onState = () => {
      // Kendini güncelleme: the connection came up (first time, or after the engine was redeployed) → ask for updates now.
      if (c.state === "open") defaultUpdateBridge()?.check().catch(() => {});
      if (c.state === "unauthorized") {
        setView({ kind: "connect", initialUrl: settings.url, notice: UNAUTHORIZED_NOTICE });
      }
    };
    const off = c.onState(onState);
    setClient(c);
    onState();
    return () => {
      off();
      c.close();
      setClient(null);
    };
  }, [settings, createClient, bridge]);

  const setSettingsTab = useCallback((tab: SettingsTab | null) => {
    setView((v) => (v.kind === "connected" ? { ...v, settingsTab: tab } : v));
  }, []);
  // İş M: Ayarlar… (and Git › Siteleri düzenle…) from the menu bar; a site opened from Git closes the settings over it.
  useMenuCommand((c) => {
    if (c.type === "settings.open") setSettingsTab(SETTINGS_TABS.find((s) => s.id === c.tab)?.id ?? "projects");
    else if (c.type === "site.open") setSettingsTab(null);
  });
  const onSaved = useCallback((s: EngineSettings) => setView({ kind: "connected", settings: s, settingsTab: null }), []);

  if (view.kind === "loading") return null;

  if (view.kind === "connect") {
    return <ConnectScreen bridge={bridge} initialUrl={view.initialUrl} notice={view.notice && t(view.notice)} onSaved={onSaved} />;
  }

  if (!client) return null;
  const tab = view.settingsTab;
  return (
    <>
      {/* Stays mounted while settings are open, so terminals keep streaming and state is kept. */}
      <div hidden={tab !== null}>
        <Workbench
          client={client}
          engineUrl={view.settings.url}
          createView={createView}
          selectProject={selectProject}
          onOpenSettings={(tab) => setSettingsTab(tab ?? "projects")}
        />
      </div>
      {tab !== null && (
        <Settings
          client={client}
          tab={tab}
          onTabChange={setSettingsTab}
          onBack={() => setSettingsTab(null)}
          onInstalled={(terminal) => {
            setSettingsTab(null);
            setSelectProject((prev) => ({ projectId: terminal.projectId, seq: (prev?.seq ?? 0) + 1 }));
          }}
          connection={
            <>
              <ConnectScreen embedded bridge={bridge} initialUrl={view.settings.url} onSaved={onSaved} />
              {bridge.connection && (
                <InsecureTransportOptIn
                  connection={bridge.connection}
                  url={view.settings.url}
                  // A new client (same settings) tries again right away, through the gate.
                  onChanged={() => setView((v) => (v.kind === "connected" ? { ...v, settings: { ...v.settings } } : v))}
                />
              )}
              <AboutSection />
            </>
          }
        />
      )}
    </>
  );
}
