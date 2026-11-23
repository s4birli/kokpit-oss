// Real TerminalView: xterm.js + FitAddon. Font and colours come from theme.css variables; İş Z's font size
// (setFontSize) overrides the CSS one.
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITerminalOptions, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { clipboardConfig } from "../engine/clipboard-ipc.ts";
import { linksConfig } from "../engine/links-ipc.ts";
import type { TerminalLinkHost } from "./link-opener.ts";
import { attachTerminalClipboard } from "./terminal-clipboard.ts";
import { attachTerminalKeys, terminalKeysConfig } from "./terminal-keys.ts";
import { attachTerminalLinks } from "./terminal-links.ts";
import type { TerminalDims, TerminalView, TerminalViewFactory, TerminalViewOptions } from "./terminal-view.ts";

/** As xterm decides it (selection modifiers differ on macOS). */
const isMac = (): boolean => /Mac/i.test(navigator.platform);

function cssVar(style: CSSStyleDeclaration, name: string): string | undefined {
  const v = style.getPropertyValue(name).trim();
  return v === "" ? undefined : v;
}

function optionsFromTheme(): ITerminalOptions {
  const style = getComputedStyle(document.documentElement);
  const theme: ITheme = {};
  const background = cssVar(style, "--term-bg");
  const foreground = cssVar(style, "--text");
  const cursor = cssVar(style, "--accent");
  const selection = cssVar(style, "--border-strong");
  if (background) theme.background = background;
  if (foreground) theme.foreground = foreground;
  if (cursor) theme.cursor = cursor;
  if (selection) theme.selectionBackground = selection;

  const options: ITerminalOptions = {
    theme,
    allowProposedApi: false,
    // Kopyalama: Option-drag selects even while a program (Claude Code) tracks the mouse.
    macOptionClickForcesSelection: clipboardConfig.macOptionClickForcesSelection,
  };
  const fontFamily = cssVar(style, "--font-mono");
  if (fontFamily) options.fontFamily = fontFamily;
  const fontSize = Number.parseFloat(cssVar(style, "--term-font-size") ?? "");
  if (Number.isFinite(fontSize) && fontSize > 0) options.fontSize = fontSize;
  return options;
}

class XtermView implements TerminalView {
  private readonly term: Terminal;
  private readonly fitAddon = new FitAddon();
  private clipboard: { dispose(): void } | undefined;
  private links: { dispose(): void } | undefined;
  private readonly linkHost: TerminalLinkHost | undefined;
  /** Replays (buffered history) written but not parsed yet. */
  private replays = 0;

  constructor(options: TerminalViewOptions = {}) {
    this.term = new Terminal(optionsFromTheme());
    this.term.loadAddon(this.fitAddon);
    // Tuşlar: Shift+Enter sends its own sequence (xterm sends Enter's bare CR); every other key stays xterm's.
    attachTerminalKeys(this.term, terminalKeysConfig);
    this.linkHost = options.links;
  }

  open(container: HTMLElement): void {
    this.term.open(container);
    // Bağlantılar: before the clipboard's listeners — a ⌘ click on a link is taken here and goes no further.
    if (this.linkHost) this.links = attachTerminalLinks(this.term, container, { host: this.linkHost, config: linksConfig, isMac: isMac() });
    this.clipboard = attachTerminalClipboard(this.term, container, {
      config: clipboardConfig,
      isMac: isMac(),
      writeText: (text) => window.kokpit?.clipboard?.writeText(text) ?? Promise.resolve(),
      hasFocus: () => container.contains(container.ownerDocument.activeElement),
      replaying: () => this.replays > 0,
    });
  }

  fit(): TerminalDims | null {
    const d = this.fitAddon.proposeDimensions();
    if (!d || !Number.isFinite(d.cols) || !Number.isFinite(d.rows) || d.cols < 1 || d.rows < 1) return null;
    if (d.cols !== this.term.cols || d.rows !== this.term.rows) this.term.resize(d.cols, d.rows);
    return { cols: d.cols, rows: d.rows };
  }

  setFontSize(px: number): void {
    if (Number.isFinite(px) && px > 0 && this.term.options.fontSize !== px) this.term.options.fontSize = px;
  }

  write(data: string, replay = false): void {
    if (!replay) {
      this.term.write(data);
      return;
    }
    // xterm parses asynchronously, in order: the flag covers exactly this chunk.
    this.replays++;
    this.term.write(data, () => {
      this.replays--;
    });
  }

  reset(): void {
    this.term.reset();
  }

  onData(cb: (data: string) => void): () => void {
    const sub = this.term.onData(cb);
    return () => sub.dispose();
  }

  focus(): void {
    this.term.focus();
  }

  dispose(): void {
    this.links?.dispose();
    this.clipboard?.dispose();
    this.term.dispose();
  }
}

export const createXtermView: TerminalViewFactory = (options) => new XtermView(options);
