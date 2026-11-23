// İş M — Ayarlar › Siteler: the sites of the Git menu and the Web panel. Stored by main on this machine (next to the UI
// state); main validates the list again and refreshes the menu. A site's id never changes, because its login
// partition (`persist:web-<id>`) belongs to it.
import { useEffect, useId, useState } from "react";
import { checkSites, newSiteId, SITE_TRANSPORT_BADGES, siteTransport, siteUrlError, type WebBridge, type WebSite } from "../../engine/web-ipc.ts";
import "../panels/web.css";
import { intlLocale, useT } from "../../../i18n/index.ts";
import { errorMessage } from "../errors.ts";
import { checkName } from "./validation.ts";
import { ErrorText, TextField } from "./parts.tsx";

type SitesBridge = WebBridge["sites"];

/** The address field's message: the list's own rule (https, or http to a Tailscale/loopback IP), as a sentence. */
function checkSiteUrl(v: string): string | undefined {
  const error = siteUrlError(v.trim());
  return error === undefined ? undefined : `${error.charAt(0).toLocaleUpperCase(intlLocale())}${error.slice(1)}`;
}

function bridgeFromWindow(): SitesBridge | undefined {
  return typeof window === "undefined" ? undefined : window.kokpit?.web?.sites;
}

export interface SitesTabProps {
  /** Defaults to the preload's `window.kokpit.web.sites`; absent outside Electron. */
  bridge?: SitesBridge | undefined;
}

export function SitesTab(props: SitesTabProps) {
  const t = useT();
  const bridge = "bridge" in props ? props.bridge : bridgeFromWindow();
  if (!bridge) return <p className="kp-field__hint">{t("settings.sites.onlyInApp")}</p>;
  return <SitesEditor bridge={bridge} />;
}

/** "http · Tailscale" next to a plain-http site, so it is never mistaken for an https one. */
function TransportBadge({ url }: { url: string }) {
  const transport = siteTransport(url.trim());
  if (transport === "https") return null;
  const badge = SITE_TRANSPORT_BADGES[transport];
  return (
    <span className="kp-web__badge" title={badge.title}>
      {badge.label}
    </span>
  );
}

function SitesEditor({ bridge }: { bridge: SitesBridge }) {
  const t = useT();
  const [draft, setDraft] = useState<WebSite[] | null>(null);
  // Every id seen in a loaded or saved list: a deleted site's partition still holds its login until main clears it,
  // so a new site must never reuse one of these ids (delete + re-add in one save would otherwise inherit it).
  const [usedIds, setUsedIds] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [addErrors, setAddErrors] = useState<{ name?: string; url?: string }>({});
  const addId = useId();

  useEffect(() => {
    let alive = true;
    bridge.load().then(
      (list) => {
        if (!alive) return;
        setDraft(list);
        setUsedIds(list.map((s) => s.id));
      },
      (err: unknown) => alive && setError(errorMessage(err)),
    );
    return () => {
      alive = false;
    };
  }, [bridge]);

  if (!draft) return error ? <ErrorText error={error} /> : null;

  const edit = (fn: (list: WebSite[]) => WebSite[]): void => {
    setDraft((d) => (d ? fn(d) : d));
    setSaved(false);
  };
  const update = (i: number, patch: Partial<WebSite>) => edit((list) => list.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number) =>
    edit((list) => {
      if (i <= 0) return list;
      const next = [...list];
      [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
      return next;
    });

  const add = (): void => {
    const urlError = checkSiteUrl(url);
    const errors = { ...(checkName(name) ? { name: checkName(name)! } : {}), ...(urlError ? { url: urlError } : {}) };
    setAddErrors(errors);
    if (errors.name || errors.url) return;
    edit((list) => [...list, { id: newSiteId(url, [...usedIds, ...list.map((s) => s.id)]), title: name.trim(), url: url.trim() }]);
    setName("");
    setUrl("");
  };

  const save = async (): Promise<void> => {
    const check = checkSites(draft);
    if (!check.ok) {
      setError(check.errors.join(" "));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await bridge.save(check.sites);
      setDraft(check.sites);
      setUsedIds((ids) => [...new Set([...ids, ...check.sites.map((s) => s.id)])]);
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="kp-settings__tab kp-sites">
      <p className="kp-field__hint">{t("settings.sites.intro")}</p>
      <ul className="kp-list">
        {draft.map((s, i) => (
          <li key={s.id} className="kp-item kp-sites__row">
            <TextField label={t("settings.common.name")} value={s.title} onChange={(v) => update(i, { title: v })} />
            <TextField label={t("settings.sites.address")} value={s.url} mono inputMode="url" onChange={(v) => update(i, { url: v })} />
            <div className="kp-item__actions">
              <TransportBadge url={s.url} />
              <button type="button" className="kp-btn" aria-label={t("settings.sites.upAria", { title: s.title })} disabled={i === 0} onClick={() => move(i)}>
                ↑
              </button>
              <button type="button" className="kp-btn kp-btn--danger" aria-label={t("settings.common.deleteAria", { name: s.title })} onClick={() => edit((list) => list.filter((_, j) => j !== i))}>
                {t("settings.common.delete")}
              </button>
            </div>
          </li>
        ))}
      </ul>
      <fieldset className="kp-sites__add" aria-labelledby={`${addId}-legend`}>
        <legend id={`${addId}-legend`}>{t("settings.sites.addLegend")}</legend>
        <TextField label={t("settings.common.name")} value={name} onChange={setName} {...(addErrors.name ? { error: addErrors.name } : {})} />
        <TextField label={t("settings.sites.address")} value={url} mono inputMode="url" placeholder="https://" onChange={setUrl} {...(addErrors.url ? { error: addErrors.url } : {})} />
        <button type="button" className="kp-btn" onClick={add}>
          {t("settings.sites.add")}
        </button>
      </fieldset>
      <ErrorText error={error} />
      <div className="kp-item__actions">
        <button type="button" className="kp-btn kp-btn--primary" disabled={busy} onClick={() => void save()}>
          {t("settings.common.save")}
        </button>
        {saved && (
          <span role="status" className="kp-field__hint">
            {t("settings.sites.saved")}
          </span>
        )}
      </div>
    </div>
  );
}
