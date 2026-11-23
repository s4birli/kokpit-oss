import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionBridge } from "../engine/types.ts";
import { INSECURE_OPT_IN_LABEL as LABEL_KEY, INSECURE_OPT_IN_WARNING as WARNING_KEY, InsecureTransportOptIn } from "./InsecureTransportOptIn.tsx";
import { t } from "../../i18n/index.ts";

const INSECURE_OPT_IN_LABEL = t(LABEL_KEY);
const INSECURE_OPT_IN_WARNING = t(WARNING_KEY);

const LAN = "ws://192.168.1.5:7420";

function bridge(over: Partial<{ ok: boolean; on: boolean }> = {}) {
  let on = over.on ?? false;
  const b: ConnectionBridge = {
    check: vi.fn(async () => (over.ok === true || on ? { ok: true as const } : { ok: false as const, message: "güvenli değil" })),
    insecureAllowed: vi.fn(async () => on),
    setInsecure: vi.fn(async (_u: string, v: boolean) => {
      on = v;
    }),
  };
  return b;
}

const flush = () => act(async () => {});

afterEach(cleanup);

describe("Ayarlar › Bağlantı: 'güvenli olmayan ağda yine de bağlan'", () => {
  it("for a refused address: off by default, with a warning that names the risk", async () => {
    render(<InsecureTransportOptIn connection={bridge()} url={LAN} />);
    await flush();
    const box = screen.getByRole("checkbox", { name: INSECURE_OPT_IN_LABEL }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByRole("note").textContent).toBe(INSECURE_OPT_IN_WARNING);
    expect(INSECURE_OPT_IN_WARNING).toMatch(/kod çalıştırabilir/);
  });

  it("turning it on stores it for exactly this address and asks the connection to retry", async () => {
    const b = bridge();
    const onChanged = vi.fn();
    render(<InsecureTransportOptIn connection={b} url={LAN} onChanged={onChanged} />);
    await flush();
    fireEvent.click(screen.getByRole("checkbox", { name: INSECURE_OPT_IN_LABEL }));
    await flush();
    expect(b.setInsecure).toHaveBeenCalledWith(LAN, true);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  });

  it("is not shown at all for an address that needs no opt-in (this Mac, Tailscale up, wss://)", async () => {
    render(<InsecureTransportOptIn connection={bridge({ ok: true })} url="ws://127.0.0.1:7420" />);
    await flush();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
