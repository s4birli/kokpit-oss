// Kendini güncelleme: what the strip above the workbench says for a given updater state — or nothing at all.
// Unobtrusive on purpose: checking and a background download say nothing; only what the user can act on shows.
import type { UpdateStatus } from "../../engine/update-ipc.ts";
import { t } from "../../../i18n/index.ts";

export type UpdateAction = "apply" | "download" | "move" | "dismiss" | "downgrade";

export interface UpdateNoticeText {
  text: string;
  tone: "info" | "warn";
  action?: { kind: UpdateAction; label: string };
}

const shortBuild = (buildId: string | undefined): string => buildId ?? t("update.notice.noBuildId");

export function updateNotice(s: UpdateStatus | null): UpdateNoticeText | null {
  if (!s || s.phase === "disabled") return null;
  if (s.phase === "applying") return { text: t("update.notice.applying"), tone: "info" };
  if (s.phase === "ready") {
    return {
      text: s.blocked === "other-instance" && s.message ? t("update.notice.readyWithMessage", { message: s.message }) : t("update.notice.ready"),
      tone: "info",
      action: { kind: "apply", label: t("update.notice.restart") },
    };
  }
  // The app is behind the engine and its update is on the way: say so instead of leaving failures unexplained.
  if (s.compat === "app-older" && (s.phase === "downloading" || s.phase === "verifying" || s.phase === "checking")) {
    return { text: t("update.notice.applying"), tone: "info" };
  }
  // An older build than ever installed here: only offered, with its own action — never "update".
  if (s.phase === "available" && s.target?.downgrade) {
    const what = `${s.target.version} (${s.target.builtAt ?? "?"})`;
    return { text: t("update.notice.olderPublished", { what }), tone: "warn", action: { kind: "downgrade", label: t("update.notice.downgrade", { what }) } };
  }
  if (s.phase === "available") {
    return { text: t("update.notice.available", { version: s.target?.version ?? t("update.notice.newBuild") }), tone: "info", action: { kind: "download", label: t("update.notice.download") } };
  }
  if (s.phase === "blocked") {
    const movable = s.blocked === "translocated" || s.blocked === "read-only";
    return {
      text: s.message ?? t("update.notice.blocked"),
      tone: "warn",
      ...(movable ? { action: { kind: "move" as const, label: t("update.notice.move") } } : {}),
    };
  }
  if (s.last && s.last.outcome !== "updated") {
    const detail = s.last.detail ?? s.last.buildId;
    const text = s.last.outcome === "rolledBack" ? t("update.notice.rolledBack", { detail }) : t("update.notice.failed", { detail });
    return { text, tone: "warn", action: { kind: "dismiss", label: t("update.notice.ok") } };
  }
  if (s.compat === "engine-older") {
    return { text: t("update.notice.engineOlder", { build: shortBuild(s.engine?.build?.buildId) }), tone: "warn" };
  }
  if (s.compat === "app-older") {
    return { text: s.message ? t("update.notice.appOlderWithMessage", { message: s.message }) : t("update.notice.appOlder"), tone: "warn" };
  }
  if (s.phase === "error" && s.message) return { text: s.message, tone: "warn" };
  return null;
}
