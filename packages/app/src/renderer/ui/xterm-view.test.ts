import { afterEach, describe, expect, it, vi } from "vitest";

const created: Array<Record<string, unknown>> = [];

vi.mock("@xterm/xterm", () => {
  class Terminal {
    options: Record<string, unknown>;
    cols = 0;
    rows = 0;
    open = vi.fn();
    write = vi.fn();
    reset = vi.fn();
    focus = vi.fn();
    dispose = vi.fn();
    loadAddon = vi.fn();
    oscDispose = vi.fn();
    osc: ((data: string) => boolean) | undefined;
    parser = {
      registerOscHandler: vi.fn((_id: number, cb: (data: string) => boolean) => {
        this.osc = cb;
        return { dispose: this.oscDispose };
      }),
    };
    modes = { mouseTrackingMode: "none" };
    resize = vi.fn((c: number, r: number) => {
      this.cols = c;
      this.rows = r;
    });
    dataDispose = vi.fn();
    onData = vi.fn(() => ({ dispose: this.dataDispose }));
    keyHandler: ((e: KeyboardEvent) => boolean) | undefined;
    attachCustomKeyEventHandler = vi.fn((h: (e: KeyboardEvent) => boolean) => {
      this.keyHandler = h;
    });
    input = vi.fn();
    constructor(options: Record<string, unknown>) {
      this.options = options;
      created.push(this as unknown as Record<string, unknown>);
    }
  }
  return { Terminal };
});

const proposed: { value: { cols: number; rows: number } | undefined } = { value: { cols: 90, rows: 25 } };
vi.mock("@xterm/addon-fit", () => {
  class FitAddon {
    proposeDimensions = vi.fn(() => proposed.value);
    fit = vi.fn();
  }
  return { FitAddon };
});
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const { createXtermView } = await import("./xterm-view.ts");
const { clipboardConfig } = await import("../engine/clipboard-ipc.ts");
const { terminalKeysConfig } = await import("./terminal-keys.ts");

afterEach(() => {
  created.length = 0;
  document.documentElement.removeAttribute("style");
});

describe("createXtermView", () => {
  it("takes font and colours from theme CSS variables", () => {
    const root = document.documentElement.style;
    root.setProperty("--term-bg", "#000001");
    root.setProperty("--text", "#000002");
    root.setProperty("--font-mono", "Mono Test");
    root.setProperty("--term-font-size", "15px");
    createXtermView().open(document.createElement("div"));
    const opts = created[0]!.options as { fontFamily: string; fontSize: number; theme: { background: string; foreground: string } };
    expect(opts.fontFamily).toBe("Mono Test");
    expect(opts.fontSize).toBe(15);
    expect(opts.theme.background).toBe("#000001");
    expect(opts.theme.foreground).toBe("#000002");
  });

  it("fit resizes to proposed dimensions and returns them; null when unmeasurable", () => {
    const v = createXtermView();
    v.open(document.createElement("div"));
    expect(v.fit()).toEqual({ cols: 90, rows: 25 });
    proposed.value = undefined;
    expect(v.fit()).toBeNull();
    proposed.value = { cols: Number.NaN, rows: 3 };
    expect(v.fit()).toBeNull();
    proposed.value = { cols: 90, rows: 25 };
  });

  it("Tuşlar: Shift+Enter sends the setting's sequence as typed input; Enter and the arrows stay xterm's", () => {
    createXtermView().open(document.createElement("div"));
    const t = created[0] as unknown as { keyHandler: (e: KeyboardEvent) => boolean; input: ReturnType<typeof vi.fn> };
    expect(t.keyHandler(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true }))).toBe(false);
    expect(t.input).toHaveBeenCalledWith(terminalKeysConfig.shiftEnter, true);
    expect(t.keyHandler(new KeyboardEvent("keydown", { key: "Enter" }))).toBe(true);
    expect(t.keyHandler(new KeyboardEvent("keydown", { key: "ArrowUp" }))).toBe(true);
    expect(t.input).toHaveBeenCalledTimes(1);
  });

  it("forwards write/reset/onData/dispose", () => {
    const v = createXtermView();
    v.open(document.createElement("div"));
    const t = created[0] as unknown as {
      write: ReturnType<typeof vi.fn>;
      reset: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
      dataDispose: ReturnType<typeof vi.fn>;
    };
    v.write("x");
    v.reset();
    const off = v.onData(() => {});
    off();
    v.dispose();
    expect(t.write).toHaveBeenCalledWith("x");
    expect(t.reset).toHaveBeenCalled();
    expect(t.dataDispose).toHaveBeenCalled();
    expect(t.dispose).toHaveBeenCalled();
  });

  it("Kopyalama: Option-drag forces selection; OSC 52 writes go to the bridge, but not from a replay", () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("kokpit", { clipboard: { writeText } });
    const host = document.createElement("div");
    host.tabIndex = 0;
    document.body.append(host);
    const v = createXtermView();
    v.open(host);
    host.focus();
    const t = created[0] as unknown as {
      options: { macOptionClickForcesSelection: boolean };
      write: ReturnType<typeof vi.fn>;
      osc: (data: string) => boolean;
      oscDispose: ReturnType<typeof vi.fn>;
    };
    expect(t.options.macOptionClickForcesSelection).toBe(clipboardConfig.macOptionClickForcesSelection);
    const payload = `c;${Buffer.from("kopya").toString("base64")}`;

    // A replay: its OSC 52 is parsed before xterm reports the chunk done.
    v.write("history", true);
    const done = t.write.mock.calls[0]![1] as () => void;
    t.osc(payload);
    expect(writeText).not.toHaveBeenCalled();
    done();
    // Live output afterwards.
    v.write("live");
    expect(t.write.mock.calls[1]).toEqual(["live"]);
    t.osc(payload);
    expect(writeText).toHaveBeenCalledExactlyOnceWith("kopya");

    // Focus elsewhere: not this terminal's clipboard to write.
    host.blur();
    t.osc(payload);
    expect(writeText).toHaveBeenCalledOnce();

    v.dispose();
    expect(t.oscDispose).toHaveBeenCalled();
    host.remove();
    vi.unstubAllGlobals();
  });
});
