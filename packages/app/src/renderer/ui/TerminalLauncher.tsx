import type { Tool } from "@kokpit/shared";
import { useId, useState, type FormEvent } from "react";
import { useT } from "../../i18n/index.ts";
import { errorMessage } from "./errors.ts";
import { SHELL_ONLY, shellOnlyLabel } from "./tool-choice.ts";

/** What a new terminal starts with. A typed command wins over the tool; `toolId: null` = plain shell on purpose. */
export type Launch = { toolId?: string | null; command?: string };

export interface TerminalLauncherProps {
  tools: readonly Tool[];
  /** Preselected tool (the project's default, else the global default), if it still exists. */
  defaultToolId?: string;
  /** Opens a terminal; rejects with the engine error. */
  onOpen(launch: Launch): Promise<void>;
}

/** "Araç" picker + optional start command + "Yeni terminal". */
export function TerminalLauncher({ tools, defaultToolId, onOpen }: TerminalLauncherProps) {
  const translate = useT();
  const id = useId();
  /** null = follow the default (tools may load after mount). */
  const [choice, setChoice] = useState<string | null>(null);
  const [command, setCommand] = useState("");
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const known = (toolId: string | undefined): toolId is string =>
    toolId !== undefined && tools.some((t) => t.id === toolId);
  const fallback = known(defaultToolId) ? defaultToolId : SHELL_ONLY;
  const value = choice === null || (choice !== SHELL_ONLY && !known(choice)) ? fallback : choice;

  const open = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (opening) return;
    setOpening(true);
    setError(null);
    const trimmed = command.trim();
    const launch: Launch = trimmed !== "" ? { command: trimmed } : { toolId: value !== SHELL_ONLY ? value : null };
    try {
      await onOpen(launch);
      setCommand("");
    } catch (err) {
      setError(translate("terminal.launcher.openFailed", { error: errorMessage(err) }));
    } finally {
      setOpening(false);
    }
  };

  return (
    <>
      <form className="kp-form kp-form--inline" onSubmit={(e) => void open(e)}>
        <label className="kp-field" htmlFor={`${id}-tool`}>
          <span className="kp-field__label">{translate("terminal.launcher.tool")}</span>
          <select id={`${id}-tool`} className="kp-input" value={value} onChange={(e) => setChoice(e.target.value)}>
            <option value={SHELL_ONLY}>{shellOnlyLabel()}</option>
            {tools.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="kp-field">
          <span className="kp-field__label">{translate("terminal.launcher.startCommand")}</span>
          <input
            className="kp-input kp-input--mono"
            value={command}
            placeholder={translate("terminal.launcher.optional")}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => setCommand(e.target.value)}
          />
        </label>
        <button type="submit" className="kp-btn kp-btn--primary" disabled={opening}>
          {translate("terminal.launcher.newTerminal")}
        </button>
      </form>
      {error && (
        <p role="alert" className="kp-error">
          {error}
        </p>
      )}
    </>
  );
}
