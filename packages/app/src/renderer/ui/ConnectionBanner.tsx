import { HANDSHAKE_MESSAGES } from "@kokpit/shared";
import type { ConnectionState } from "../engine/types.ts";
import { UpdateNotice } from "./update/UpdateNotice.tsx";
import { useT, type Translate } from "../../i18n/index.ts";

interface Props {
  state: ConnectionState;
  /** Address the client is trying to reach; shown so a wrong/unreachable address is obvious. */
  engineUrl?: string;
  onOpenSettings: () => void;
  /** While `state` is "insecure-transport": the gate's own reason (else a general one is shown). */
  transportMessage?: string | undefined;
}

function message(t: Translate, state: ConnectionState, target: string): string | null {
  switch (state) {
    case "connecting":
      return t("workbench.banner.connecting", { target });
    case "reconnecting":
      return t("workbench.banner.reconnecting", { target });
    case "unauthorized":
      return t("workbench.banner.unauthorized");
    case "outdated-engine":
      return `${HANDSHAKE_MESSAGES["outdated-engine"]}${target}`;
    case "engine-unverified":
      return `${HANDSHAKE_MESSAGES.unverified}${target}`;
    case "insecure-transport":
      return `${t("workbench.banner.insecure")}${target}`;
    default:
      return null;
  }
}

export function ConnectionBanner({ state, engineUrl, onOpenSettings, transportMessage }: Props) {
  const t = useT();
  const target = engineUrl ? ` (${engineUrl})` : "";
  const text = state === "insecure-transport" && transportMessage ? `${transportMessage}${target}` : message(t, state, target);
  return (
    <>
      {text && (
        <div role="status" className={`kp-banner kp-banner--${state}`}>
          <span>{text}</span>
          <button type="button" className="kp-banner__action" onClick={onOpenSettings}>
            {t("workbench.banner.settings")}
          </button>
        </div>
      )}
      {/* Kendini güncelleme: "Güncelleme hazır — yeniden başlat" and its relatives share this strip's place. */}
      <UpdateNotice />
    </>
  );
}
