// Kendini güncelleme — Ayarlar › Bağlantı: which build the app is, which build the engine is, and the one choice
// the user has: update by itself, or only say that an update exists.
import { useId, useState } from "react";
import type { UpdateBridge, UpdateStatus } from "../../engine/update-ipc.ts";
import { defaultUpdateBridge, useUpdateStatus } from "./useUpdateStatus.ts";
import { useT, type MessageKey, type Translate } from "../../../i18n/index.ts";
import "./update.css";

function stateText(t: Translate, s: UpdateStatus): string {
  switch (s.phase) {
    case "disabled":
      return s.message ?? t("update.about.off");
    case "checking":
      return t("update.about.checking");
    case "available":
      return t("update.about.available", { buildId: s.target?.buildId ?? "" });
    case "downloading": {
      return s.progress && s.progress.total > 0
        ? t("update.about.downloadingPct", { pct: Math.floor((s.progress.received / s.progress.total) * 100) })
        : t("update.about.downloading");
    }
    case "verifying":
      return t("update.about.verifying");
    case "ready":
      return t("update.about.ready", { buildId: s.target?.buildId ?? "" });
    case "applying":
      return t("update.about.installing");
    case "blocked":
    case "error":
      return s.message ?? t("update.about.cannotInstall");
    case "idle":
      return s.message ?? (s.engine ? t("update.about.upToDate") : t("update.about.notChecked"));
  }
}

const COMPAT_TEXT: Record<UpdateStatus["compat"], MessageKey> = {
  unknown: "update.about.compatUnknown",
  ok: "update.about.compatOk",
  "engine-older": "update.about.compatEngineOlder",
  "app-older": "update.about.compatAppOlder",
};

export function AboutSection({ bridge = defaultUpdateBridge() }: { bridge?: UpdateBridge | undefined }) {
  const t = useT();
  const id = useId();
  const s = useUpdateStatus(bridge);
  const [confirmReset, setConfirmReset] = useState(false);
  if (!bridge || !s) return null;
  return (
    <section className="kp-about" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="kp-about__title">
        {t("update.about.title")}
      </h2>
      <dl className="kp-about__list">
        <dt>{t("update.about.app")}</dt>
        <dd data-kp-copy={s.app.buildId}>{s.app.buildId}</dd>
        <dt>{t("update.about.engine")}</dt>
        <dd data-kp-copy={s.engine?.build?.buildId ?? ""}>
          {s.engine === null ? t("update.about.notConnected") : (s.engine.build?.buildId ?? t("update.about.noBuildId", { version: s.engine.version ?? "?" }))}
        </dd>
        <dt>{t("update.about.compat")}</dt>
        <dd>{t(COMPAT_TEXT[s.compat])}</dd>
        <dt>{t("update.about.status")}</dt>
        <dd role="status">{stateText(t, s)}</dd>
      </dl>
      <label className="kp-about__auto">
        <input type="checkbox" checked={s.auto} disabled={s.phase === "disabled"} onChange={(e) => void bridge.setAuto(e.target.checked).catch(() => {})} />
        <span>{t("update.about.auto")}</span>
      </label>
      <p className="kp-about__hint">
        {t("update.about.hint")}
      </p>
      <div className="kp-about__actions">
        <button type="button" className="kp-btn" disabled={s.phase === "disabled"} onClick={() => void bridge.check().catch(() => {})}>
          {t("update.about.checkNow")}
        </button>
        {s.phase === "available" && s.target?.downgrade && (
          <button type="button" className="kp-btn" onClick={() => void bridge.confirmDowngrade(s.target!.buildId).catch(() => {})}>
            {t("update.about.downgrade", { version: s.target.version, date: s.target.builtAt ?? "?" })}
          </button>
        )}
        {s.phase === "available" && !s.target?.downgrade && (
          <button type="button" className="kp-btn kp-btn--primary" onClick={() => void bridge.download().catch(() => {})}>
            {t("update.about.download")}
          </button>
        )}
        {s.phase === "ready" && (
          <button type="button" className="kp-btn kp-btn--primary" onClick={() => void bridge.apply().catch(() => {})}>
            {t("update.about.apply")}
          </button>
        )}
      </div>
      {/* Recovery only: the rollback floor (newest build ever installed here) back to this build — e.g. after a
          wrongly dated build raised it. Two steps, so it is never a slip. */}
      <div className="kp-about__actions">
        {!confirmReset ? (
          <button type="button" className="kp-btn" onClick={() => setConfirmReset(true)}>
            {t("update.about.resetFloor")}
          </button>
        ) : (
          <>
            <span role="note">{t("update.about.resetFloorNote")}</span>
            <button type="button" className="kp-btn" onClick={() => setConfirmReset(false)}>
              {t("update.about.cancel")}
            </button>
            <button
              type="button"
              className="kp-btn kp-btn--primary"
              onClick={() => {
                setConfirmReset(false);
                void bridge.resetFloor().catch(() => {});
              }}
            >
              {t("update.about.resetFloorConfirm")}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
