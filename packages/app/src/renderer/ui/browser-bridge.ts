// İş B: the preload's local-browser bridge (`runOn: "client"` projects), when running inside Electron.
export function bridgeOpenLocal(): ((projectId: string) => Promise<void>) | undefined {
  const bridge = typeof window === "undefined" ? undefined : window.kokpit?.browser;
  return bridge ? (projectId) => bridge.openLocal(projectId) : undefined;
}
