// Kendini güncelleme: the strip in the connection banner's place — "Güncelleme hazır — yeniden başlat" and the
// states that explain themselves instead of failing quietly (engine older, update rolled back, cannot install here).
import type { UpdateBridge } from "../../engine/update-ipc.ts";
import { updateNotice, type UpdateAction } from "./update-text.ts";
import { defaultUpdateBridge, useUpdateStatus } from "./useUpdateStatus.ts";
import { useT } from "../../../i18n/index.ts";
import "./update.css";

function run(bridge: UpdateBridge, kind: UpdateAction, buildId: string | undefined): void {
  const work =
    kind === "apply"
      ? bridge.apply()
      : kind === "download"
        ? bridge.download()
        : kind === "move"
          ? bridge.moveToApplications()
          : kind === "downgrade"
            ? bridge.confirmDowngrade(buildId ?? "")
            : bridge.dismiss();
  work.catch(() => {});
}

export function UpdateNotice({ bridge = defaultUpdateBridge() }: { bridge?: UpdateBridge | undefined }) {
  useT(); // re-render on a language switch (updateNotice reads the texts)
  const status = useUpdateStatus(bridge);
  const notice = updateNotice(status);
  if (!bridge || !notice) return null;
  const { action } = notice;
  return (
    <div role="status" className={`kp-banner kp-banner--update kp-banner--update-${notice.tone}`}>
      <span>{notice.text}</span>
      {action && (
        <button type="button" className="kp-banner__action" onClick={() => run(bridge, action.kind, status?.target?.buildId)}>
          {action.label}
        </button>
      )}
    </div>
  );
}
