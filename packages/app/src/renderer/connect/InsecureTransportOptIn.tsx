// Ayarlar › Bağlantı: the explicit, per-address opt-in "güvenli olmayan ağda yine de bağlan". Off by default; the
// warning names the risk. Only shown for an address the transport gate refuses (or one already opted in).
import { useEffect, useId, useState } from "react";
import type { ConnectionBridge } from "../engine/types.ts";
import "./InsecureTransportOptIn.css";
import { useT, type MessageKey } from "../../i18n/index.ts";

export const INSECURE_OPT_IN_LABEL: MessageKey = "connect.insecure.label";
export const INSECURE_OPT_IN_WARNING: MessageKey = "connect.insecure.warning";

interface Props {
  connection: ConnectionBridge;
  url: string;
  /** The choice changed: the connection should be tried again now. */
  onChanged?: () => void;
}

export function InsecureTransportOptIn({ connection, url, onChanged }: Props) {
  const t = useT();
  const id = useId();
  const [state, setState] = useState<{ needed: boolean; on: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([connection.check(url), connection.insecureAllowed(url)]).then(
      ([verdict, on]) => {
        if (!cancelled) setState({ needed: !verdict.ok || on, on });
      },
      () => {
        if (!cancelled) setState(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [connection, url]);

  if (!state?.needed) return null;
  return (
    <section className="kp-optin" aria-labelledby={`${id}-label`}>
      <label id={`${id}-label`} className="kp-optin__label">
        <input
          type="checkbox"
          checked={state.on}
          disabled={busy}
          onChange={(e) => {
            const on = e.currentTarget.checked;
            setBusy(true);
            connection.setInsecure(url, on).then(
              () => {
                setState({ needed: true, on });
                setBusy(false);
                onChanged?.();
              },
              () => setBusy(false),
            );
          }}
        />{" "}
        {t(INSECURE_OPT_IN_LABEL)}
      </label>
      <p className="kp-optin__warning" role="note">
        {t(INSECURE_OPT_IN_WARNING)}
      </p>
    </section>
  );
}
