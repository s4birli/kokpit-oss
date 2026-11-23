// Small building blocks shared by the settings tabs.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { Method, ParamsOf } from "@kokpit/shared";
import { useT } from "../../../i18n/index.ts";
import { errorMessage } from "../errors.ts";
import type { Checked, FieldErrors } from "./validation.ts";

/** Runs one async action at a time; keeps the engine's error message verbatim. */
export function useAction(): {
  busy: boolean;
  error: string | null;
  setError(e: string | null): void;
  run(fn: () => Promise<void>): Promise<boolean>;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const running = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = useCallback(async (fn: () => Promise<void>): Promise<boolean> => {
    if (running.current) return false;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (err) {
      if (alive.current) setError(errorMessage(err));
      return false;
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }, []);
  return { busy, error, setError, run };
}

/**
 * Form submission: shows field errors from a client-side check, otherwise sends the
 * checked params and calls `onDone`. Engine errors land in `action.error` verbatim.
 */
export function useFormSubmit<K extends string>(onDone: () => Promise<void>) {
  const action = useAction();
  const [errors, setErrors] = useState<FieldErrors<K>>({});
  const submit = <M extends Method>(checked: Checked<M, K>, send: (params: ParamsOf<M>) => Promise<unknown>): void => {
    if (!checked.ok) {
      setErrors(checked.errors);
      action.setError(checked.message ?? null);
      return;
    }
    setErrors({});
    void action.run(async () => {
      await send(checked.params);
      await onDone();
    });
  };
  return { action, errors, submit };
}

export function ErrorText({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return (
    <p role="alert" className="kp-error">
      {error}
    </p>
  );
}

interface FieldShell {
  label: string;
  error?: string;
  hint?: string;
}

export function TextField(
  p: FieldShell & {
    value: string;
    onChange(v: string): void;
    mono?: boolean;
    placeholder?: string;
    inputMode?: "text" | "numeric" | "url";
  },
) {
  const id = useId();
  const describedBy = [p.error ? `${id}-err` : null, p.hint ? `${id}-hint` : null].filter(Boolean).join(" ");
  return (
    <div className="kp-field">
      <label htmlFor={id} className="kp-field__label">
        {p.label}
      </label>
      <input
        id={id}
        className={p.mono ? "kp-input kp-input--mono" : "kp-input"}
        value={p.value}
        placeholder={p.placeholder}
        inputMode={p.inputMode}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        aria-invalid={p.error ? true : undefined}
        aria-describedby={describedBy || undefined}
        onChange={(e) => p.onChange(e.target.value)}
      />
      {p.hint && (
        <span id={`${id}-hint`} className="kp-field__hint">
          {p.hint}
        </span>
      )}
      {p.error && (
        <span id={`${id}-err`} className="kp-field__error">
          {p.error}
        </span>
      )}
    </div>
  );
}

/** İş A: multi-line text (e.g. one regex per line). */
export function TextAreaField(p: FieldShell & { value: string; onChange(v: string): void; rows: number; placeholder?: string }) {
  const id = useId();
  const describedBy = [p.error ? `${id}-err` : null, p.hint ? `${id}-hint` : null].filter(Boolean).join(" ");
  return (
    <div className="kp-field">
      <label htmlFor={id} className="kp-field__label">
        {p.label}
      </label>
      <textarea
        id={id}
        className="kp-input kp-input--mono kp-input--area"
        rows={p.rows}
        value={p.value}
        placeholder={p.placeholder}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        aria-invalid={p.error ? true : undefined}
        aria-describedby={describedBy || undefined}
        onChange={(e) => p.onChange(e.target.value)}
      />
      {p.hint && (
        <span id={`${id}-hint`} className="kp-field__hint">
          {p.hint}
        </span>
      )}
      {p.error && (
        <span id={`${id}-err`} className="kp-field__error">
          {p.error}
        </span>
      )}
    </div>
  );
}

export interface Option {
  value: string;
  label: string;
}

export function SelectField(p: FieldShell & { value: string; onChange(v: string): void; options: readonly Option[] }) {
  const id = useId();
  return (
    <div className="kp-field">
      <label htmlFor={id} className="kp-field__label">
        {p.label}
      </label>
      <select
        id={id}
        className="kp-input"
        value={p.value}
        aria-invalid={p.error ? true : undefined}
        aria-describedby={[p.error ? `${id}-err` : null, p.hint ? `${id}-hint` : null].filter(Boolean).join(" ") || undefined}
        onChange={(e) => p.onChange(e.target.value)}
      >
        {p.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {p.hint && (
        <span id={`${id}-hint`} className="kp-field__hint">
          {p.hint}
        </span>
      )}
      {p.error && (
        <span id={`${id}-err`} className="kp-field__error">
          {p.error}
        </span>
      )}
    </div>
  );
}

/** A titled form with Kaydet / Vazgeç. `message` is a form-level (e.g. engine) error. */
export function SettingsForm(p: {
  title: string;
  busy: boolean;
  message: string | null;
  status?: string | null;
  onSubmit(): void;
  onCancel(): void;
  children: ReactNode;
}) {
  const t = useT();
  const titleId = useId();
  return (
    <form
      className="kp-form kp-settings__form"
      aria-labelledby={titleId}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        p.onSubmit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !p.busy) p.onCancel();
      }}
    >
      <h3 id={titleId} className="kp-settings__form-title">
        {p.title}
      </h3>
      {p.children}
      <div className="kp-form__actions">
        <button type="submit" className="kp-btn kp-btn--primary" disabled={p.busy}>
          {t("settings.common.save")}
        </button>
        <button type="button" className="kp-btn" disabled={p.busy} onClick={p.onCancel}>
          {t("settings.common.cancel")}
        </button>
      </div>
      {p.status && (
        <p role="status" className="kp-settings__status">
          {p.status}
        </p>
      )}
      <ErrorText error={p.message} />
    </form>
  );
}

/** "Sil" → "Silmeyi onayla" / "Vazgeç". Engine reasons are shown verbatim. */
export function DeleteControl({ name, onDelete }: { name: string; onDelete(): Promise<void> }) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const action = useAction();
  return (
    <>
      {confirming ? (
        <span className="kp-form__actions">
          <button
            type="button"
            className="kp-btn kp-btn--danger"
            disabled={action.busy}
            onClick={() => void action.run(onDelete).then(() => setConfirming(false))}
          >
            {t("settings.common.confirmDelete")}
          </button>
          <button type="button" className="kp-btn" disabled={action.busy} onClick={() => setConfirming(false)}>
            {t("settings.common.cancel")}
          </button>
        </span>
      ) : (
        <button type="button" className="kp-btn" aria-label={t("settings.common.deleteAria", { name })} onClick={() => setConfirming(true)}>
          {t("settings.common.delete")}
        </button>
      )}
      <ErrorText error={action.error} />
    </>
  );
}

export function EditButton({ name, onClick }: { name: string; onClick(): void }) {
  const t = useT();
  return (
    <button type="button" className="kp-btn" aria-label={t("settings.common.editAria", { name })} onClick={onClick}>
      {t("settings.common.edit")}
    </button>
  );
}
