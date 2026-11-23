// İş A (Adım 7) — "Arka plan ajanları" in the Ajanlar panel: Claude Code background sessions of the selected
// project (or all, with "Tüm projeler"), grouped Seni bekliyor / Çalışıyor / Bitti, with Bağlan / Kayıtlar / Durdur.
import type { BgAgentSession } from "@kokpit/shared";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { relativeTime } from "./agents.ts";
import { BG_REASON_KEY, groupBgAgents, type BgAgentGroup } from "./bg-agents.ts";
import { errorMessage } from "./errors.ts";
import { copyValue } from "./copy-menu.ts";

export interface BgAgentsSectionProps {
  /** Every session the engine knows. */
  sessions: readonly BgAgentSession[];
  error?: string | null;
  /** Selected project; undefined = nothing selected (all sessions are shown). */
  projectId: string | undefined;
  /** "Proje › Kart" or "Diğer", shown when sessions of several projects are listed. */
  placeOf(session: BgAgentSession): string;
  /** İş H: name of the session's Claude account when it is not the default one. */
  accountOf?(session: BgAgentSession): string | undefined;
  now: number;
  /** Ask to show one session (e.g. from the rail): it is listed, marked and its Bağlan focused; a new `seq` repeats. */
  highlight?: { id: string; seq: number } | null;
  onAttach(id: string): Promise<void>;
  onLogs(id: string): Promise<{ text: string; truncated: boolean }>;
  onStop(id: string): Promise<void>;
}

type Logs = { session: BgAgentSession; text: string | null; truncated: boolean; error: string | null };

export function BgAgentsSection(props: BgAgentsSectionProps) {
  const t = useT();
  const { sessions, projectId, highlight } = props;
  const headingId = useId();
  const [allProjects, setAllProjects] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({ waiting: true, running: true, done: false });
  const [logs, setLogs] = useState<Logs | null>(null);
  const showAll = allProjects || projectId === undefined;

  // A highlighted session outside the current filter switches to "Tüm projeler"; a done one opens Bitti.
  useEffect(() => {
    if (!highlight) return;
    const s = sessions.find((x) => x.id === highlight.id);
    if (!s) return;
    if (s.projectId !== projectId) setAllProjects(true);
    setOpen((o) => (o[s.state] ? o : { ...o, [s.state]: true }));
  }, [highlight?.id, highlight?.seq]); // only on a new request, not on every list change

  const groups = useMemo(
    () => groupBgAgents(showAll ? sessions : sessions.filter((s) => s.projectId === projectId), t),
    [sessions, showAll, projectId, t],
  );
  const empty = groups.every((g) => g.sessions.length === 0);

  const openLogs = async (session: BgAgentSession): Promise<void> => {
    setLogs({ session, text: null, truncated: false, error: null });
    try {
      const r = await props.onLogs(session.id);
      setLogs((cur) => (cur?.session.id === session.id ? { session, text: r.text, truncated: r.truncated, error: null } : cur));
    } catch (err) {
      setLogs((cur) =>
        cur?.session.id === session.id ? { session, text: null, truncated: false, error: t("agents.bg.logsFailed", { error: errorMessage(err) }) } : cur,
      );
    }
  };

  return (
    <section className="kp-bga" aria-labelledby={headingId}>
      <div className="kp-bga__head">
        <h4 id={headingId} className="kp-agents__section">
          {t("agents.bg.title")}
        </h4>
        <label className="kp-bga__all">
          <input
            type="checkbox"
            checked={showAll}
            disabled={projectId === undefined}
            onChange={(e) => setAllProjects(e.target.checked)}
          />
          {t("agents.bg.allProjects")}
        </label>
      </div>
      {props.error && (
        <p role="alert" className="kp-error">
          {props.error}
        </p>
      )}
      {empty ? (
        <p className="kp-agents__empty">{showAll ? t("agents.bg.empty") : t("agents.bg.emptyProject")}</p>
      ) : (
        groups.map((g) =>
          g.sessions.length === 0 ? null : (
            <Group
              key={g.key}
              group={g}
              open={open[g.key] ?? false}
              onToggle={() => setOpen((o) => ({ ...o, [g.key]: !o[g.key] }))}
              showPlace={showAll}
              placeOf={props.placeOf}
              {...(props.accountOf ? { accountOf: props.accountOf } : {})}
              now={props.now}
              highlight={highlight}
              onAttach={props.onAttach}
              onStop={props.onStop}
              onLogs={openLogs}
            />
          ),
        )
      )}
      {logs && <LogsDrawer logs={logs} onClose={() => setLogs(null)} />}
    </section>
  );
}

interface GroupProps extends Omit<BgAgentsSectionProps, "sessions" | "onLogs" | "projectId" | "error"> {
  group: BgAgentGroup;
  open: boolean;
  onToggle(): void;
  showPlace: boolean;
  onLogs(session: BgAgentSession): Promise<void>;
}

function Group({ group, open, onToggle, ...rest }: GroupProps) {
  const t = useT();
  const listId = useId();
  return (
    <div className={`kp-bga__group kp-bga__group--${group.key}`}>
      <button type="button" className="kp-bga__toggle" aria-expanded={open} aria-controls={listId} onClick={onToggle}>
        {t("agents.bg.groupToggle", { title: group.title, count: group.sessions.length })}
      </button>
      {open && (
        <ul id={listId} className="kp-agents__list" aria-label={group.title}>
          {group.sessions.map((s) => (
            <Row key={s.id} session={s} {...rest} />
          ))}
        </ul>
      )}
    </div>
  );
}

interface RowProps extends Omit<GroupProps, "group" | "open" | "onToggle"> {
  session: BgAgentSession;
}

function Row({ session: s, showPlace, placeOf, accountOf, now, highlight, onAttach, onLogs, onStop }: RowProps) {
  const t = useT();
  const account = accountOf?.(s); // İş H
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attachRef = useRef<HTMLButtonElement>(null);
  const marked = highlight?.id === s.id;

  useEffect(() => {
    if (marked) attachRef.current?.focus();
  }, [marked, highlight?.seq]);

  const act = async (what: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(`${what}: ${errorMessage(err)}`);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <li className={marked ? "kp-bga__row kp-bga__row--marked" : "kp-bga__row"} data-bg-agent-id={s.id} {...copyValue(s.id)}>
      <span className="kp-agent__top">
        <span className="kp-agent__name">{s.name}</span>
        {showPlace && <span className="kp-agent__card">{placeOf(s)}</span>}
        {account !== undefined && (
          <span className="kp-account-badge" title={t("agents.bg.account")}>
            {account}
          </span>
        )}
        {s.waitingReason && (
          <span className="kp-agent-chip kp-agent-chip--waiting">{t(BG_REASON_KEY[s.waitingReason])}</span>
        )}
        {s.startedAt && <span className="kp-agent__time">{relativeTime(s.startedAt, now)}</span>}
      </span>
      <span className="kp-bga__actions">
        <button
          ref={attachRef}
          type="button"
          className="kp-btn kp-btn--primary"
          disabled={busy}
          aria-label={t("agents.bg.attachLabel", { name: s.name })}
          onClick={() => void act(t("agents.bg.attachFailed"), () => onAttach(s.id))}
        >
          {t("agents.bg.attach")}
        </button>
        <button type="button" className="kp-btn" aria-label={t("agents.bg.logsLabel", { name: s.name })} onClick={() => void onLogs(s)}>
          {t("agents.bg.logs")}
        </button>
        {s.state !== "done" &&
          (confirming ? (
            <>
              <span className="kp-bga__confirm">{t("agents.bg.stopConfirm")}</span>
              <button
                type="button"
                className="kp-btn kp-btn--danger"
                disabled={busy}
                onClick={() => void act(t("agents.bg.stopFailed"), () => onStop(s.id))}
              >
                {t("agents.bg.stopYes")}
              </button>
              <button type="button" className="kp-btn" disabled={busy} onClick={() => setConfirming(false)}>
                {t("agents.bg.cancel")}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="kp-btn kp-btn--quiet"
              disabled={busy}
              aria-label={t("agents.bg.stopLabel", { name: s.name })}
              onClick={() => setConfirming(true)}
            >
              {t("agents.bg.stop")}
            </button>
          ))}
      </span>
      {error && (
        <p role="alert" className="kp-error">
          {error}
        </p>
      )}
    </li>
  );
}

function LogsDrawer({ logs, onClose }: { logs: Logs; onClose(): void }) {
  const t = useT();
  const titleId = useId();
  return (
    <aside className="kp-bga__logs" role="dialog" aria-labelledby={titleId}>
      <header className="kp-panel__head">
        <h4 id={titleId} className="kp-panel__title">
          {t("agents.bg.logsLabel", { name: logs.session.name })}
        </h4>
        <button type="button" className="kp-btn" onClick={onClose} autoFocus>
          {t("agents.bg.close")}
        </button>
      </header>
      {logs.error ? (
        <p role="alert" className="kp-error">
          {logs.error}
        </p>
      ) : logs.text === null ? (
        <p className="kp-agents__empty">{t("agents.bg.loading")}</p>
      ) : (
        <>
          {logs.truncated && <p className="kp-agents__empty">{t("agents.bg.truncated")}</p>}
          <pre className="kp-bga__logs-text">{logs.text || t("agents.bg.noLogs")}</pre>
        </>
      )}
    </aside>
  );
}
