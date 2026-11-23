import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { validateNewEngineSettings, SETTINGS_LIMITS } from "../engine/options.ts";
import type { EngineSettings, SettingsBridge } from "../engine/types.ts";
import type { LocalEngineBridge } from "../engine/local-engine-ipc.ts";
import { useT } from "../../i18n/index.ts";

export interface ConnectScreenProps {
  bridge: SettingsBridge;
  /** Called after the settings were saved successfully. */
  onSaved: (settings: EngineSettings) => void;
  initialUrl?: string;
  /** Shown above the form, e.g. "Anahtar reddedildi". */
  notice?: string;
  /** Rendered inside another screen (settings): no full-page wrapper. */
  embedded?: boolean;
  /** Yerel bağlantı: defaults to the preload's `window.kokpit.localEngine`; absent outside Electron. */
  localEngine?: LocalEngineBridge;
}

/** Longest address hint accepted from main (a malformed reply hides the button). */
const MAX_ADDRESS_LEN = 300;

function defaultLocalEngine(): LocalEngineBridge | undefined {
  return typeof window === "undefined" ? undefined : window.kokpit?.localEngine;
}

type FieldErrors = Partial<Record<keyof EngineSettings, string>>;

export function ConnectScreen({
  bridge,
  onSaved,
  initialUrl = "",
  notice,
  embedded = false,
  localEngine = defaultLocalEngine(),
}: ConnectScreenProps) {
  const t = useT();
  const id = useId();
  const [url, setUrl] = useState(initialUrl);
  const [key, setKey] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Yerel bağlantı: address of a reachable engine on this Mac (no key reaches the page for this).
  const [localAddress, setLocalAddress] = useState<string | null>(null);
  const localInFlight = useRef(false);

  useEffect(() => {
    if (!localEngine) return;
    let cancelled = false;
    localEngine.detect().then(
      (info) => {
        const address = info?.address;
        if (!cancelled && typeof address === "string" && address.length > 0 && address.length <= MAX_ADDRESS_LEN) {
          setLocalAddress(address);
        }
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [localEngine]);

  async function onLocalConnect() {
    // A ref, not `busy`: two clicks in the same tick both still see busy === false.
    if (localInFlight.current || busy || !localEngine) return;
    localInFlight.current = true;
    setSaveError(null);
    setBusy(true);
    let saved: EngineSettings | null;
    try {
      await localEngine.connect();
      saved = await bridge.load();
      if (!saved) throw new Error(t("connect.screen.savedUnreadable"));
    } catch (err) {
      setSaveError(err instanceof Error && err.message ? err.message : t("connect.screen.localFailed"));
      return;
    } finally {
      localInFlight.current = false;
      setBusy(false);
    }
    onSaved(saved);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setSaveError(null);
    const v = validateNewEngineSettings({ url, key });
    if (!v.ok) {
      setErrors(v.errors);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await bridge.save(v.value);
    } catch (err) {
      setSaveError(err instanceof Error && err.message ? err.message : t("connect.screen.saveFailed"));
      setBusy(false);
      return;
    }
    setBusy(false);
    onSaved(v.value);
  }

  const urlId = `${id}-url`;
  const keyId = `${id}-key`;

  const Wrapper = embedded ? "div" : "main";
  return (
    <Wrapper style={embedded ? styles.embedded : styles.page}>
      <form style={styles.card} onSubmit={onSubmit} noValidate aria-labelledby={`${id}-title`}>
        <h1 id={`${id}-title`} style={styles.title}>
          {t("connect.screen.title")}
        </h1>
        <p style={styles.hint}>{t("connect.screen.hint")}</p>

        {notice && (
          <p role="status" style={styles.notice}>
            {notice}
          </p>
        )}

        {localAddress && (
          <div style={styles.local}>
            <button
              type="button"
              onClick={() => void onLocalConnect()}
              disabled={busy}
              style={{ ...styles.button, ...styles.localButton, ...(busy ? styles.buttonBusy : null) }}
            >
              {t("connect.screen.local")}
            </button>
            <span style={styles.localHint}>{localAddress}</span>
            <span style={styles.divider}>{t("connect.screen.orManual")}</span>
          </div>
        )}

        <label htmlFor={urlId} style={styles.label}>
          {t("connect.screen.url")}
        </label>
        <input
          id={urlId}
          name="url"
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="ws://100.x.y.z:port"
          maxLength={SETTINGS_LIMITS.maxUrlLength}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          aria-invalid={errors.url ? true : undefined}
          aria-describedby={errors.url ? `${urlId}-err` : undefined}
          style={{ ...styles.input, ...(errors.url ? styles.inputInvalid : null) }}
        />
        {errors.url && (
          <span id={`${urlId}-err`} style={styles.fieldError}>
            {errors.url}
          </span>
        )}

        <label htmlFor={keyId} style={styles.label}>
          {t("connect.screen.key")}
        </label>
        <input
          id={keyId}
          name="key"
          type="password"
          autoComplete="off"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          aria-invalid={errors.key ? true : undefined}
          aria-describedby={errors.key ? `${keyId}-err` : undefined}
          style={{ ...styles.input, ...(errors.key ? styles.inputInvalid : null) }}
        />
        {errors.key && (
          <span id={`${keyId}-err`} style={styles.fieldError}>
            {errors.key}
          </span>
        )}

        {saveError && (
          <p role="alert" style={styles.saveError}>
            {saveError}
          </p>
        )}

        <button type="submit" disabled={busy} style={{ ...styles.button, ...(busy ? styles.buttonBusy : null) }}>
          {t("connect.screen.submit")}
        </button>
      </form>
    </Wrapper>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    boxSizing: "border-box",
    background: "var(--bg)",
    color: "var(--text)",
    fontFamily: "var(--font-ui)",
  },
  embedded: { display: "flex", color: "var(--text)", fontFamily: "var(--font-ui)" },
  card: {
    width: "100%",
    maxWidth: 380,
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: 24,
    background: "var(--panel)",
    border: "1px solid var(--border)",
    borderRadius: 10,
  },
  title: { margin: 0, fontSize: "1.25em", fontWeight: 600 },
  hint: { margin: "0 0 10px", color: "var(--muted)", fontSize: "0.9em" },
  notice: {
    margin: "0 0 8px",
    padding: "8px 10px",
    borderRadius: 6,
    border: "1px solid var(--warn)",
    color: "var(--warn)",
  },
  label: { marginTop: 8, fontSize: "0.85em", color: "var(--muted)" },
  input: {
    padding: "8px 10px",
    borderRadius: 6,
    border: "1px solid var(--border-strong)",
    background: "var(--term-bg)",
    color: "var(--text)",
    fontFamily: "var(--font-mono)",
    fontSize: "0.95em",
    outlineColor: "var(--accent)",
  },
  inputInvalid: { borderColor: "var(--danger)" },
  fieldError: { color: "var(--danger)", fontSize: "0.82em" },
  saveError: { margin: "8px 0 0", color: "var(--danger)", fontSize: "0.9em" },
  button: {
    marginTop: 16,
    padding: "9px 12px",
    borderRadius: 6,
    border: "1px solid var(--accent)",
    background: "var(--accent)",
    color: "var(--accent-text)",
    fontFamily: "var(--font-ui)",
    fontWeight: 600,
    cursor: "pointer",
  },
  buttonBusy: { opacity: 0.6, cursor: "progress" },
  local: { display: "flex", flexDirection: "column", gap: 4, marginBottom: 4 },
  localButton: { marginTop: 0 },
  localHint: { alignSelf: "center", color: "var(--muted)", fontFamily: "var(--font-mono)", fontSize: "0.8em" },
  divider: { marginTop: 10, alignSelf: "center", color: "var(--muted)", fontSize: "0.8em" },
} satisfies Record<string, CSSProperties>;
