import { useId } from "react";
import { useT } from "../../i18n/index.ts";

export function Placeholder({ title, className }: { title: string; className?: string }) {
  const t = useT();
  const id = useId();
  return (
    <section className={`kp-panel kp-placeholder${className ? ` ${className}` : ""}`} aria-labelledby={id}>
      <header className="kp-panel__head">
        <h3 id={id} className="kp-panel__title">
          {title}
        </h3>
      </header>
      <p className="kp-placeholder__body">{t("workbench.placeholder.body")}</p>
    </section>
  );
}
