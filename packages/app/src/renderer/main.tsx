import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./ui/theme.css";
import { App } from "./App.tsx";
import { installCopyMenu } from "./ui/copy-menu.ts";
import { getLocale, installLanguageBridge, intlLocale, onLocaleChange } from "../i18n/index.ts";

// i18n: the window's language before the first paint; <html lang> follows it (screen readers, hyphenation, CSS).
installLanguageBridge(window.kokpit?.i18n);
const syncLang = (): void => void (document.documentElement.lang = intlLocale(getLocale()));
syncLang();
onLocaleChange(syncLang);

// Kopyalama: right click on a row that carries a value (path, command, id) → native "Kopyala".
installCopyMenu(document, window.kokpit?.clipboard);

const root = document.getElementById("root");
if (!root) throw new Error("#root missing from index.html");

createRoot(root).render(
  <StrictMode>
    <App bridge={window.kokpit} />
  </StrictMode>,
);
