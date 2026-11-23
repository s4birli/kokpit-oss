// Claude kullanımı — the usage block of one Claude account and the list of all accounts' blocks.
// Shown in Ayarlar › Claude hesapları (one block per account) and in the Claude panel's "Kullanım" tab.
//
// Two kinds of numbers, never mixed up: the table, models and projects are Kokpit's own count from this Mac's
// session transcripts; the meters are Claude Code's own quota figures and appear only when it reported them
// (status line snapshot, or "Claude'a sor" — one small request, asked for explicitly).
import type { ClaudePlanWindow, ClaudeUsageAccount, ClaudeUsageResult, ClaudeUsageTotals } from "@kokpit/shared";
import { useEffect, useId, useState } from "react";
import { intlLocale, useT, type MessageKey } from "../../i18n/index.ts";
import type { EngineClient } from "../engine/types.ts";
import {
  CLAUDE_USAGE_EVENTS,
  fetchClaudeUsage,
  formatPercent,
  formatTokens,
  formatUsd,
  formatWhen,
  PLAN_KEYS as PLAN_LABEL_KEYS,
  PLAN_SOURCE_KEYS,
  totalTokens,
  usageSourceNote,
  USAGE_WINDOWS,
  windowLabels,
  type UsageWindowId,
} from "./claude-usage.ts";
import { useEngineResource, type EngineResource } from "./hooks/useEngineResource.ts";
import { useAction } from "./settings/parts.tsx";
import "./claude-usage.css";

const PERCENT_MAX = 100;
const NO_VALUE = "—";
const COLUMNS: readonly { key: keyof ClaudeUsageTotals | "total"; label: MessageKey }[] = [
  { key: "total", label: "usage.columns.total" },
  { key: "input", label: "usage.columns.input" },
  { key: "output", label: "usage.columns.output" },
  { key: "cacheWrite", label: "usage.columns.cacheWrite" },
  { key: "cacheRead", label: "usage.columns.cacheRead" },
  { key: "messages", label: "usage.columns.messages" },
];
const PLAN_KEYS = ["fiveHour", "sevenDay"] as const;

const capitalize = (s: string, locale: string): string => (s === "" ? s : s[0]!.toLocaleUpperCase(locale) + s.slice(1));

/** The usage of all accounts: loaded on connect, on `claudeUsage.changed`, and every `refreshIntervalMs` while mounted. */
export function useClaudeUsage(client: EngineClient): EngineResource<ClaudeUsageResult> {
  const usage = useEngineResource(client, fetchClaudeUsage, CLAUDE_USAGE_EVENTS);
  const interval = usage.data?.refreshIntervalMs;
  const { reload } = usage;
  useEffect(() => {
    if (interval === undefined) return;
    const id = setInterval(() => void reload(), interval);
    return () => clearInterval(id);
  }, [interval, reload]);
  return usage;
}

export interface ClaudeUsageBlockProps {
  client: EngineClient;
  account: ClaudeUsageAccount;
  /** The result the account came from (window lengths, price date, whether asking Claude is possible). */
  meta: ClaudeUsageResult;
  /** Intl locale override (tests); default: the app's language. */
  locale?: string | undefined;
  /** Heading above the block (the settings list already names the account). */
  title?: string;
  now?: number;
  /** Re-read the numbers (after a refresh or a probe). */
  onChanged(): Promise<void>;
}

export function ClaudeUsageBlock({ client, account: a, meta, locale: localeOverride, title, now = Date.now(), onChanged }: ClaudeUsageBlockProps) {
  const t = useT();
  const locale = localeOverride ?? intlLocale();
  const [selected, setSelected] = useState<UsageWindowId>("week");
  const [confirming, setConfirming] = useState(false);
  const refresh = useAction();
  const probe = useAction();
  const labels = windowLabels(meta);
  const hasCost = meta.pricesAsOf !== undefined;
  const firstPass = a.updatedAt === undefined && a.indexing;
  const empty = a.windows.week.totals.messages === 0 && a.windows.today.totals.messages === 0;
  const tokens = (n: number): string => formatTokens(n, locale);

  const doRefresh = (): void => {
    void refresh.run(async () => {
      await client.request("claudeUsage.get", { accountId: a.accountId, refresh: true });
      await onChanged();
    });
  };
  const doProbe = (): void => {
    void probe.run(async () => {
      setConfirming(false);
      await client.request("claudeUsage.probe", { accountId: a.accountId, confirm: true });
      await onChanged();
    });
  };

  return (
    <div role="group" aria-label={t("usage.blockLabel", { name: a.name })} className="kp-usage">
      {title !== undefined && <h4 className="kp-usage__title">{title}</h4>}
      {a.error !== undefined && (
        <p role="alert" className="kp-error">
          {a.error}
        </p>
      )}

      {a.plan ? (
        <div className="kp-usage__plan">
          {PLAN_KEYS.map((key) => {
            const w = a.plan?.[key];
            return w ? <PlanMeter key={key} label={t("usage.planQuota", { plan: t(PLAN_LABEL_KEYS[key]) })} window={w} locale={locale} now={now} /> : null;
          })}
        </div>
      ) : (
        <p className="kp-usage__hint">{t("usage.noPlanNote")}</p>
      )}

      {firstPass ? (
        <p className="kp-usage__hint">{t("usage.readingSessions")}</p>
      ) : empty ? (
        <p className="kp-usage__hint">{t("usage.empty", { window: labels.week })}</p>
      ) : (
        <>
          <div className="kp-usage__scroll">
            <table className="kp-usage__table">
            <thead>
              <tr>
                <th scope="col">{t("usage.period")}</th>
                {COLUMNS.map((c) => (
                  <th key={c.key} scope="col">
                    {t(c.label)}
                  </th>
                ))}
                {hasCost && <th scope="col">{t("usage.estimatedCost")}</th>}
              </tr>
            </thead>
            <tbody>
              {USAGE_WINDOWS.map((id) => {
                const w = a.windows[id];
                return (
                  <tr key={id}>
                    <th scope="row">
                      <button type="button" className="kp-usage__window" aria-pressed={selected === id} onClick={() => setSelected(id)}>
                        {labels[id]}
                      </button>
                    </th>
                    {COLUMNS.map((c) => (
                      <td key={c.key}>{tokens(c.key === "total" ? totalTokens(w.totals) : w.totals[c.key])}</td>
                    ))}
                    {hasCost && <td>{w.estimatedCostUsd !== undefined ? formatUsd(w.estimatedCostUsd, locale) : NO_VALUE}</td>}
                  </tr>
                );
              })}
            </tbody>
            </table>
          </div>
          <div className="kp-usage__breakdown">
            <Bars title={t("usage.models", { window: labels[selected] })} rows={a.windows[selected].byModel.map((m) => ({ key: m.family, name: capitalize(m.family, locale), total: totalTokens(m) }))} format={tokens} />
            <Bars
              title={t("usage.projects", { window: labels[selected] })}
              rows={a.windows[selected].topProjects.map((p) => ({ key: `${p.projectId ?? ""}:${p.name}`, name: p.name, total: totalTokens(p) }))}
              format={tokens}
            />
          </div>
        </>
      )}

      {a.partial && <p className="kp-usage__hint">{t("usage.partial")}</p>}
      {hasCost && <p className="kp-usage__hint">{t("usage.costNote", { date: meta.pricesAsOf ?? "" })}</p>}
      <p className="kp-usage__hint">{usageSourceNote()}</p>

      {confirming && (
        <p className="kp-usage__confirm">
          <span>{t("usage.probeNote")}</span>
          <button type="button" className="kp-btn kp-btn--primary" disabled={probe.busy} onClick={doProbe}>
            {t("usage.ask")}
          </button>
          <button type="button" className="kp-btn" onClick={() => setConfirming(false)}>
            {t("usage.cancel")}
          </button>
        </p>
      )}
      {probe.error && (
        <p role="alert" className="kp-error">
          {t("usage.probeFailed", { error: probe.error })}
        </p>
      )}
      {refresh.error && (
        <p role="alert" className="kp-error">
          {t("usage.refreshFailed", { error: refresh.error })}
        </p>
      )}

      <p className="kp-usage__foot">
        <span>{a.updatedAt !== undefined ? t("usage.updated", { when: formatWhen(a.updatedAt, locale, now) }) : t("usage.notYet")}</span>
        {a.indexing && !firstPass && <span>{t("usage.reading")}</span>}
        <button type="button" className="kp-btn kp-btn--quiet" aria-label={t("usage.refreshLabel", { name: a.name })} disabled={refresh.busy} onClick={doRefresh}>
          {t("usage.refresh")}
        </button>
        {meta.probeAvailable && !confirming && (
          <button type="button" className="kp-btn kp-btn--quiet" aria-label={t("usage.askLabel", { name: a.name })} disabled={probe.busy} onClick={() => setConfirming(true)}>
            {probe.busy ? t("usage.asking") : t("usage.askButton")}
          </button>
        )}
      </p>
    </div>
  );
}

function PlanMeter({ label, window: w, locale, now }: { label: string; window: ClaudePlanWindow; locale: string; now: number }) {
  const t = useT();
  const shown = Math.min(PERCENT_MAX, Math.max(0, w.usedPercent));
  const text = formatPercent(w.usedPercent, locale);
  return (
    <div className="kp-usage__meter-row">
      <span className="kp-usage__meter-label">{label}</span>
      <span role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={PERCENT_MAX} aria-valuenow={shown} aria-valuetext={text} className="kp-usage__meter">
        <span className="kp-usage__meter-fill" style={{ inlineSize: `${shown}%` }} />
      </span>
      <span className="kp-usage__value">{text}</span>
      <span className="kp-usage__meter-detail">
        {t("usage.meterDetail", { resets: formatWhen(w.resetsAt, locale, now), source: t(PLAN_SOURCE_KEYS[w.source]), captured: formatWhen(w.capturedAt, locale, now) })}
      </span>
    </div>
  );
}

function Bars({ title, rows, format }: { title: string; rows: { key: string; name: string; total: number }[]; format(n: number): string }) {
  const id = useId();
  if (rows.length === 0) return null;
  const max = Math.max(1, ...rows.map((r) => r.total));
  return (
    <div className="kp-usage__bars">
      <h5 id={id} className="kp-usage__bars-title">
        {title}
      </h5>
      <ul aria-labelledby={id} className="kp-usage__bar-list">
        {rows.map((r) => (
          <li key={r.key} className="kp-usage__bar-row">
            <span className="kp-usage__bar-name">{r.name}</span>
            <span className="kp-usage__bar" aria-hidden="true">
              <span className="kp-usage__bar-fill" style={{ inlineSize: `${(r.total / max) * PERCENT_MAX}%` }} />
            </span>
            <span className="kp-usage__value">{format(r.total)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface ClaudeUsageListProps {
  client: EngineClient;
  /** Intl locale override (tests); default: the app's language. */
  locale?: string | undefined;
  /** The selected project's account: its block comes first and is marked. */
  firstAccountId?: string | undefined;
  /** The selected project uses the default account (it names none): that one comes first. */
  firstDefault?: boolean | undefined;
}

/** Every account's block, the selected project's account first. */
export function ClaudeUsageList({ client, locale, firstAccountId, firstDefault }: ClaudeUsageListProps) {
  const t = useT();
  const usage = useClaudeUsage(client);
  const data = usage.data;
  if (!data) {
    return usage.error ? (
      <p role="alert" className="kp-error">
        {t("usage.loadFailed", { error: usage.error })}
      </p>
    ) : (
      <p className="kp-usage__hint">{t("usage.loading")}</p>
    );
  }
  const isFirst = (a: ClaudeUsageAccount): boolean => (firstAccountId !== undefined ? a.accountId === firstAccountId : firstDefault === true && a.isDefault === true);
  const accounts = [...data.accounts].sort((x, y) => Number(isFirst(y)) - Number(isFirst(x)));
  return (
    <div className="kp-usage-list">
      {usage.error && (
        <p role="alert" className="kp-error">
          {t("usage.loadFailed", { error: usage.error })}
        </p>
      )}
      {accounts.length === 0 && <p className="kp-usage__hint">{t("usage.noAccounts")}</p>}
      {accounts.map((a) => (
        <ClaudeUsageBlock
          key={a.accountId}
          client={client}
          account={a}
          meta={data}
          locale={locale}
          title={isFirst(a) ? t("usage.thisProject", { name: a.name }) : a.name}
          onChanged={usage.reload}
        />
      ))}
    </div>
  );
}
