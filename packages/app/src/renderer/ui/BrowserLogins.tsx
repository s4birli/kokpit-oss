// Girişler: saved logins (username + password) of the project's browser. One small key button in the Tarayıcı
// toolbar; its popover lists the project's logins — the open site's first, each with a one-click "Doldur" — and has
// "Bu site için kaydet" and delete.
//
// The password is WRITE-ONLY here: it is typed into a password field, sent to the engine once (`logins.save`) and
// dropped from this component's state. It is stored in the Keychain of the engine's Mac. Nothing can show it again:
// "Doldur" sends ids only, and the engine puts the values into the page itself — only when the open page's origin
// is exactly the login's.
//
// Two risks are put in front of the user instead of being hidden; the ENGINE enforces both, this component only asks:
//   - an agent driving the same browser can read a filled password: the first fill in a project (and every fill
//     while a terminal that can reach the browser is running) asks "Yine de doldur / Vazgeç"; the acceptance is
//     remembered in the engine per project and can be taken back here;
//   - Keychain access (engine setting): in "confirm" mode each fill waits for the user's click in macOS's Keychain
//     dialog on the engine Mac; the popover says so while it waits.
import { loginOriginOf, type LoginFillField, type LoginPolicy, type SavedLogin } from "@kokpit/shared";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { EngineClient } from "../engine/types.ts";
import { useT } from "../../i18n/index.ts";
import { errorMessage, isDisconnected } from "./errors.ts";
import "./browser-logins.css";

export interface BrowserLoginsProps {
  client: EngineClient;
  projectId: string;
  /** Address of the page the panel shows ("" = none). Its origin is the site logins are saved for and offered on. */
  pageUrl: string;
}

function KeyIcon() {
  return (
    <svg className="kp-logins__icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="5" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 8h6.5M12 8v2.5M14.5 8v2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function BrowserLogins({ client, projectId, pageUrl }: BrowserLoginsProps) {
  const t = useT();
  const popId = useId();
  const userId = useId();
  const passId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [logins, setLogins] = useState<SavedLogin[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  /**
   * The site the save form was OPENED for (null = no form). It is fixed for the life of the form: what the user saw
   * when they decided to save is what is sent. If the panel's page moves to another origin meanwhile (a redirect,
   * an agent, another tab), the form is cancelled — the credentials are never silently bound to the new site.
   */
  const [formSite, setFormSite] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  /** The engine's policy for this project, as of the last list (the engine checks again on every fill). */
  const [policy, setPolicy] = useState<LoginPolicy | null>(null);
  /** The login whose fill waits for the user's "Yine de doldur". */
  const [risking, setRisking] = useState<SavedLogin | null>(null);
  /** A fill is on its way (in confirm mode: the Keychain dialog may be open on the engine Mac). */
  const [filling, setFilling] = useState(false);

  const site = loginOriginOf(pageUrl);

  /** Closing forgets everything typed — a password above all. */
  const close = useCallback(() => {
    setOpen(false);
    setFormSite(null);
    setUsername("");
    setPassword("");
    setConfirming(null);
    setRisking(null);
    setError(null);
    setStatus(null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const listed = await client.request("logins.list", { projectId });
      setLogins(listed.logins);
      setPolicy(listed.policy);
    } catch (err) {
      if (!isDisconnected(err)) setError(errorMessage(err));
    }
  }, [client, projectId]);

  // Another project's panel: nothing of the previous one stays on screen.
  useEffect(() => {
    setLogins(null);
    setPolicy(null);
    close();
  }, [projectId, close]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const outside = (e: MouseEvent) => {
      if (e.target instanceof Node && rootRef.current?.contains(e.target)) return;
      close();
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open, refresh, close]);

  useEffect(() => {
    if (formSite === null || formSite === site) return;
    setFormSite(null);
    setUsername("");
    setPassword("");
    setStatus(null);
    setError(t("logins.pageChanged", { formSite, now: site ?? t("logins.notASiteNow") }));
  }, [formSite, site, t]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  /** `confirmed`: the user just said "Yine de doldur" for this fill. */
  const doFill = (login: SavedLogin, confirmed: boolean) =>
    void run(async () => {
      setRisking(null);
      setFilling(true);
      try {
        if (confirmed && policy?.agentRiskAccepted !== true) {
          setPolicy((await client.request("logins.risk.set", { projectId, accepted: true })).policy);
        }
        const { filled } = await client.request("logins.fill", { projectId, id: login.id, ...(confirmed ? { confirmAgentRisk: true } : {}) });
        const only: LoginFillField | undefined = filled.length === 1 ? filled[0] : undefined;
        if (only === undefined) close();
        else setStatus(t(`logins.onlyField.${only}`));
      } finally {
        setFilling(false);
      }
    });

  /** Asks first when the engine would: no acceptance yet in this project, or an agent-capable terminal is running. */
  const fill = (login: SavedLogin) => {
    if (policy !== null && (!policy.agentRiskAccepted || policy.agentsPresent)) {
      setError(null);
      setRisking(login);
      return;
    }
    doFill(login, false);
  };

  const revokeRisk = () =>
    void run(async () => {
      setPolicy((await client.request("logins.risk.set", { projectId, accepted: false })).policy);
    });

  const remove = (login: SavedLogin) =>
    void run(async () => {
      setConfirming(null);
      await client.request("logins.delete", { id: login.id });
      await refresh();
    });

  const save = (e: FormEvent) => {
    e.preventDefault();
    // Sent for the site the form was opened on — and only while that is still the open site (see the effect above).
    if (formSite === null || formSite !== site) return;
    const origin = formSite;
    if (username.trim() === "" || password === "") {
      setError(t("logins.needBoth"));
      return;
    }
    void run(async () => {
      await client.request("logins.save", { projectId, origin, username: username.trim(), password });
      // Sent: the password leaves this component for good.
      setPassword("");
      setUsername("");
      setFormSite(null);
      await refresh();
    });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    close();
  };

  const here = site === undefined ? [] : (logins ?? []).filter((l) => l.origin === site);
  const others = (logins ?? []).filter((l) => site === undefined || l.origin !== site);

  const row = (login: SavedLogin, canFill: boolean) => (
    <li key={login.id} className="kp-logins__item" data-other={!canFill || undefined}>
      <span className="kp-logins__who" title={login.username}>
        <span className="kp-logins__name">{login.username}</span>
        {login.label !== undefined && <span className="kp-logins__label">{login.label}</span>}
        {!canFill && <span className="kp-logins__site">{login.origin}</span>}
      </span>
      {confirming === login.id ? (
        <span className="kp-logins__confirm">
          <span className="kp-logins__note">{t("logins.confirmRemove")}</span>
          <button type="button" className="kp-btn kp-btn--danger" aria-label={t("logins.confirmRemoveFor", { username: login.username })} disabled={busy} onClick={() => remove(login)}>
            {t("logins.remove")}
          </button>
          <button type="button" className="kp-btn kp-btn--quiet" onClick={() => setConfirming(null)}>
            {t("logins.cancel")}
          </button>
        </span>
      ) : (
        <span className="kp-logins__actions">
          {canFill && (
            <button type="button" className="kp-btn kp-btn--primary" aria-label={t("logins.fillFor", { username: login.username })} disabled={busy} onClick={() => fill(login)}>
              {t("logins.fill")}
            </button>
          )}
          <button type="button" className="kp-btn kp-btn--quiet" aria-label={t("logins.removeFor", { username: login.username })} disabled={busy} onClick={() => setConfirming(login.id)}>
            {t("logins.remove")}
          </button>
        </span>
      )}
    </li>
  );

  return (
    // Escape closes from the button too (after a click the focus is on the button, not inside the popover).
    <div className="kp-logins" ref={rootRef} onKeyDown={open ? onKeyDown : undefined}>
      <button
        type="button"
        className="kp-btn kp-btn--quiet kp-logins__toggle"
        aria-label={t("logins.title")}
        title={t("logins.tooltip")}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <KeyIcon />
      </button>
      {open && (
        <section id={popId} className="kp-logins__pop" role="dialog" aria-label={t("logins.title")}>
          {logins !== null && logins.length === 0 && <p className="kp-logins__note">{t("logins.empty")}</p>}
          {logins !== null && logins.length > 0 && site !== undefined && here.length === 0 && <p className="kp-logins__note">{t("logins.noneHere")}</p>}
          {here.length > 0 && (
            <ul className="kp-logins__list" aria-label={t("logins.here")}>
              {here.map((l) => row(l, true))}
            </ul>
          )}
          {others.length > 0 && (
            <>
              <p className="kp-logins__heading">{t("logins.others")}</p>
              <ul className="kp-logins__list" aria-label={t("logins.others")}>
                {others.map((l) => row(l, false))}
              </ul>
            </>
          )}
          {formSite !== null ? (
            <form className="kp-logins__form" aria-label={t("logins.saveHere")} onSubmit={save}>
              <p className="kp-logins__note">
                {t("logins.site")}: <span className="kp-logins__origin">{formSite}</span>
              </p>
              <label htmlFor={userId} className="kp-logins__note">
                {t("logins.username")}
              </label>
              <input id={userId} className="kp-input" value={username} autoComplete="off" spellCheck={false} autoFocus onChange={(e) => setUsername(e.target.value)} />
              <label htmlFor={passId} className="kp-logins__note">
                {t("logins.password")}
              </label>
              <input id={passId} className="kp-input" type="password" value={password} autoComplete="new-password" spellCheck={false} onChange={(e) => setPassword(e.target.value)} />
              <div className="kp-logins__actions">
                <button type="submit" className="kp-btn kp-btn--primary" disabled={busy}>
                  {busy ? t("logins.saving") : t("logins.save")}
                </button>
                <button
                  type="button"
                  className="kp-btn kp-btn--quiet"
                  onClick={() => {
                    setFormSite(null);
                    setUsername("");
                    setPassword("");
                    setError(null);
                  }}
                >
                  {t("logins.cancel")}
                </button>
              </div>
            </form>
          ) : (
            <div className="kp-logins__actions">
              <button type="button" className="kp-btn" disabled={site === undefined} onClick={() => {
                  setError(null);
                  setFormSite(site ?? null);
                }}
              >
                {t("logins.saveHere")}
              </button>
            </div>
          )}
          {site === undefined && <p className="kp-logins__note">{t("logins.notASite")}</p>}
          {risking && (
            <div className="kp-logins__risk" role="alertdialog" aria-label={t("logins.riskTitle")}>
              <p className="kp-logins__warn">
                {t("logins.risk")}
                {policy?.agentsPresent === true && ` ${t("logins.riskNow")}`}
              </p>
              <div className="kp-logins__actions">
                <button type="button" className="kp-btn kp-btn--danger" disabled={busy} onClick={() => doFill(risking, true)}>
                  {t("logins.fillAnyway")}
                </button>
                <button type="button" className="kp-btn kp-btn--quiet" onClick={() => setRisking(null)}>
                  {t("logins.cancel")}
                </button>
              </div>
            </div>
          )}
          {filling && policy?.keychainAccess === "confirm" && (
            <p role="status" className="kp-logins__note">
              {t("logins.waiting")}
            </p>
          )}
          {status && (
            <p role="status" className="kp-logins__note">
              {status}
            </p>
          )}
          {error && (
            <p role="alert" className="kp-error">
              {error}
            </p>
          )}
          <p className="kp-logins__note kp-logins__small">{t("logins.smallPrint")}</p>
          {policy && <p className="kp-logins__note kp-logins__small">{t(`logins.access.${policy.keychainAccess}`)}</p>}
          {policy?.agentRiskAccepted === true && (
            <div className="kp-logins__actions">
              <button type="button" className="kp-btn kp-btn--quiet kp-logins__small" disabled={busy} onClick={revokeRisk}>
                {t("logins.revokeRisk")}
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
