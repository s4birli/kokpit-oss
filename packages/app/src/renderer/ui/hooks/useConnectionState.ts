import { useCallback, useSyncExternalStore } from "react";
import type { ConnectionState, EngineClient } from "../../engine/types.ts";

export function useConnectionState(client: EngineClient): ConnectionState {
  const subscribe = useCallback((cb: () => void) => client.onState(() => cb()), [client]);
  return useSyncExternalStore(subscribe, () => client.state);
}
