// Gizli tarayıcı: the words for the project's browser window setting (project form and Tarayıcı panel toggle).
import { t } from "../../i18n/index.ts";

/** Why one would show the engine's Chrome on its own screen (the toggle's tooltip, the form's hint). */
export const browserWindowHint = (): string => t("browser.window.hint");

export const browserWindowLabel = (machineName: string): string => t("browser.window.label", { machine: machineName });
