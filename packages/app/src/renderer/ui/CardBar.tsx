import type { Card } from "@kokpit/shared";
import { useState } from "react";
import { errorMessage } from "./errors.ts";
import { t, useT } from "../../i18n/index.ts";

export interface CardBarText {
  /** Accessible name of the group. */
  label: string;
  remove: string;
  confirm: string;
  cancel: string;
}

/** i18n: getters, read at render in the current language. */
export const defaultCardBarText: CardBarText = {
  get label() {
    return t("workbench.cardBar.label");
  },
  get remove() {
    return t("workbench.cardBar.remove");
  },
  get confirm() {
    return t("workbench.cardBar.confirm");
  },
  get cancel() {
    return t("workbench.common.cancel");
  },
};

export interface CardBarProps {
  card: Card;
  projectName: string;
  /** Deletes the card; rejects with the engine error (e.g. uncommitted changes). */
  onDelete(): Promise<void>;
  text?: CardBarText;
}

/**
 * The selected card on one line, at the right end of the project tab strip: name, "project / branch" and
 * "Kartı sil" (confirmed). It spends no row of its own; only an engine refusal adds a line under the strip.
 * Terminals are opened from the Terminal panel.
 */
export function CardBar({ card, projectName, onDelete, text = defaultCardBarText }: CardBarProps) {
  useT(); // re-render on a language switch (the default texts are read at render)
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async (): Promise<void> => {
    setDeleting(true);
    setError(null);
    try {
      await onDelete();
    } catch (err) {
      // Engine reasons are shown as-is.
      setError(errorMessage(err));
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const branch = `${projectName} / ${card.branch}`;
  return (
    <>
      <div className="kp-cardbar" role="group" aria-label={text.label}>
        <h2 className="kp-header__title kp-cardbar__name" title={card.name}>
          {card.name}
        </h2>
        <p className="kp-cardbar__branch" title={branch}>
          {branch}
        </p>
        {confirmDelete ? (
          <>
            <button type="button" className="kp-btn kp-btn--danger" disabled={deleting} onClick={() => void remove()}>
              {text.confirm}
            </button>
            <button type="button" className="kp-btn" disabled={deleting} onClick={() => setConfirmDelete(false)}>
              {text.cancel}
            </button>
          </>
        ) : (
          <button type="button" className="kp-btn" onClick={() => setConfirmDelete(true)}>
            {text.remove}
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="kp-error kp-cardbar__error">
          {error}
        </p>
      )}
    </>
  );
}
