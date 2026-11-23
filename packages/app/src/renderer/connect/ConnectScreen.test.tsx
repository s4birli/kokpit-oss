import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConnectScreen } from "./ConnectScreen.tsx";
import type { EngineSettings, SettingsBridge } from "../engine/types.ts";
import type { LocalEngineBridge } from "../engine/local-engine-ipc.ts";

afterEach(cleanup);

function fakeBridge(save: SettingsBridge["save"] = async () => {}): SettingsBridge {
  return { load: async () => null, save: vi.fn(save), clear: vi.fn(async () => {}) };
}

const STRONG = "S3Ryb25nLWtleS0wMTIzNDU2Nzg5YWJjZGVmLTAxMjM0NTY3ODk";

function fill(url: string, key: string) {
  fireEvent.change(screen.getByLabelText("Motor adresi"), { target: { value: url } });
  fireEvent.change(screen.getByLabelText("Anahtar"), { target: { value: key } });
}

async function submit() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Bağlan" }));
  });
}

describe("ConnectScreen", () => {
  it("renders labelled fields; key is a password input", () => {
    render(<ConnectScreen bridge={fakeBridge()} onSaved={() => {}} />);
    const url = screen.getByLabelText("Motor adresi") as HTMLInputElement;
    const key = screen.getByLabelText("Anahtar") as HTMLInputElement;
    expect(url.placeholder).toMatch(/^ws:\/\//);
    expect(key.type).toBe("password");
  });

  it("shows inline errors and does not save invalid input", async () => {
    const bridge = fakeBridge();
    const onSaved = vi.fn();
    render(<ConnectScreen bridge={bridge} onSaved={onSaved} />);
    fill("http://host:1", "");
    await submit();
    expect(screen.getByText(/ws:\/\/ ya da wss:\/\//)).toBeTruthy();
    expect(screen.getByText("Anahtar gerekli.")).toBeTruthy();
    expect((screen.getByLabelText("Motor adresi") as HTMLInputElement).getAttribute("aria-invalid")).toBe("true");
    expect(bridge.save).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("refuses a weak key (not 32 random bytes) before saving, and says how to make one", async () => {
    const bridge = fakeBridge();
    render(<ConnectScreen bridge={bridge} onSaved={vi.fn()} />);
    fill("ws://127.0.0.1:7420", "kokpit-mac-mini-2026");
    await submit();
    expect(screen.getByText(/32/)).toBeTruthy();
    expect(bridge.save).not.toHaveBeenCalled();
  });

  it("saves via the bridge, then calls onSaved", async () => {
    const order: string[] = [];
    const bridge = fakeBridge(async () => {
      order.push("save");
    });
    const onSaved = vi.fn((_s: EngineSettings) => order.push("onSaved"));
    render(<ConnectScreen bridge={bridge} onSaved={onSaved} />);
    fill("  wss://mini.example.ts.net:7  ", STRONG);
    await submit();
    const expected = { url: "wss://mini.example.ts.net:7", key: STRONG };
    expect(bridge.save).toHaveBeenCalledWith(expected);
    expect(onSaved).toHaveBeenCalledWith(expected);
    expect(order).toEqual(["save", "onSaved"]);
  });

  it("shows the bridge error and does not call onSaved when saving fails", async () => {
    const bridge = fakeBridge(async () => {
      throw new Error("Şifreli saklama kullanılamıyor");
    });
    const onSaved = vi.fn();
    render(<ConnectScreen bridge={bridge} onSaved={onSaved} />);
    fill("ws://h:1", STRONG);
    await submit();
    expect(screen.getByRole("alert").textContent).toContain("Şifreli saklama kullanılamıyor");
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("prefills the url and shows a notice (e.g. rejected key)", () => {
    render(
      <ConnectScreen bridge={fakeBridge()} onSaved={() => {}} initialUrl="ws://saved:9" notice="Anahtar reddedildi" />,
    );
    expect((screen.getByLabelText("Motor adresi") as HTMLInputElement).value).toBe("ws://saved:9");
    expect((screen.getByLabelText("Anahtar") as HTMLInputElement).value).toBe("");
    expect(screen.getByText("Anahtar reddedildi")).toBeTruthy();
  });

  it("monkey: survives odd input without saving", async () => {
    const bridge = fakeBridge();
    render(<ConnectScreen bridge={bridge} onSaved={() => {}} />);
    for (const [u, k] of [
      ["ws://", "k"],
      ["javascript:alert(1)", "k"],
      ["ws://h:1", "   "],
      ["ws://h:1", "k".repeat(5000)],
      ["\u0000￿", "\uD800"],
    ] as const) {
      fill(u, k);
      await submit();
    }
    expect(bridge.save).not.toHaveBeenCalled();
  });
});

// Yerel bağlantı: one click to the engine on this Mac.
describe("ConnectScreen — Bu Mac'teki motor", () => {
  const LOCAL_BUTTON = "Bu Mac'teki motora bağlan";
  const SAVED = { url: "ws://127.0.0.1:7420", key: "from-main" };

  function fakeLocal(over: Partial<LocalEngineBridge> = {}): LocalEngineBridge {
    return { detect: vi.fn(async () => ({ address: "127.0.0.1:7420" })), connect: vi.fn(async () => {}), ...over };
  }

  it("shows the one-click button with the address hint when an engine is detected; the manual form stays", async () => {
    render(<ConnectScreen bridge={fakeBridge()} onSaved={() => {}} localEngine={fakeLocal()} />);
    expect(await screen.findByRole("button", { name: LOCAL_BUTTON })).toBeTruthy();
    expect(screen.getByText("127.0.0.1:7420")).toBeTruthy();
    expect(screen.getByLabelText("Motor adresi")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Bağlan" })).toBeTruthy();
  });

  it("click: main connects (saves), then the saved settings are loaded and passed to onSaved", async () => {
    const order: string[] = [];
    const bridge = { ...fakeBridge(), load: vi.fn(async () => (order.push("load"), SAVED)) };
    const local = fakeLocal({ connect: vi.fn(async () => void order.push("connect")) });
    const onSaved = vi.fn((_s: EngineSettings) => order.push("onSaved"));
    render(<ConnectScreen bridge={bridge} onSaved={onSaved} localEngine={local} />);
    const btn = await screen.findByRole("button", { name: LOCAL_BUTTON });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(order).toEqual(["connect", "load", "onSaved"]);
    expect(onSaved).toHaveBeenCalledWith(SAVED);
    expect(bridge.save).not.toHaveBeenCalled();
  });

  it("no button when nothing is detected, detection fails, or there is no bridge", async () => {
    const detect = vi.fn(async () => null);
    const r1 = render(<ConnectScreen bridge={fakeBridge()} onSaved={() => {}} localEngine={fakeLocal({ detect })} />);
    await act(async () => {});
    expect(detect).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: LOCAL_BUTTON })).toBeNull();
    r1.unmount();

    const failing = vi.fn(async () => {
      throw new Error("boom");
    });
    const r2 = render(<ConnectScreen bridge={fakeBridge()} onSaved={() => {}} localEngine={fakeLocal({ detect: failing })} />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: LOCAL_BUTTON })).toBeNull();
    r2.unmount();

    render(<ConnectScreen bridge={fakeBridge()} onSaved={() => {}} />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: LOCAL_BUTTON })).toBeNull();
  });

  it("shows main's error and does not call onSaved when connecting fails", async () => {
    const onSaved = vi.fn();
    const local = fakeLocal({
      connect: vi.fn(async () => {
        throw new Error("Bu Mac'te çalışan bir motor bulunamadı.");
      }),
    });
    render(<ConnectScreen bridge={fakeBridge()} onSaved={onSaved} localEngine={local} />);
    const btn = await screen.findByRole("button", { name: LOCAL_BUTTON });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(screen.getByRole("alert").textContent).toContain("motor bulunamadı");
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("error when the settings cannot be read back after connecting", async () => {
    const onSaved = vi.fn();
    render(<ConnectScreen bridge={fakeBridge()} onSaved={onSaved} localEngine={fakeLocal()} />);
    const btn = await screen.findByRole("button", { name: LOCAL_BUTTON });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("monkey: double click connects once; ignores a malformed detect reply", async () => {
    let release!: () => void;
    const connect = vi.fn(() => new Promise<void>((r) => (release = r)));
    const bridge = { ...fakeBridge(), load: vi.fn(async () => SAVED) };
    render(<ConnectScreen bridge={bridge} onSaved={() => {}} localEngine={fakeLocal({ connect })} />);
    const btn = await screen.findByRole("button", { name: LOCAL_BUTTON });
    await act(async () => {
      fireEvent.click(btn);
      fireEvent.click(btn);
    });
    expect(connect).toHaveBeenCalledTimes(1);
    await act(async () => release());
    cleanup();

    const weird = vi.fn(async () => ({ address: 42 }) as unknown as { address: string });
    render(<ConnectScreen bridge={fakeBridge()} onSaved={() => {}} localEngine={fakeLocal({ detect: weird })} />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: LOCAL_BUTTON })).toBeNull();
  });
});
