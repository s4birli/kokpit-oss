import type { ReactNode } from "react";

/**
 * A dock panel's name, for assistive tech only: the dock tab already shows it, so repeating it in a title row
 * would only take room from the panel's content. Name the panel's region with it (`aria-labelledby`).
 */
export function PanelTitle({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h3 id={id} className="kp-panel__title kp-visually-hidden">
      {children}
    </h3>
  );
}
