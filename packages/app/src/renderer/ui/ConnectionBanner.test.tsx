import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionBanner } from "./ConnectionBanner.tsx";

afterEach(cleanup);

const URL_ = "ws://100.1.2.3:9999";

describe("ConnectionBanner", () => {
  it("renders nothing while open", () => {
    const { container } = render(<ConnectionBanner state="open" engineUrl={URL_} onOpenSettings={() => {}} />);
    expect(container.textContent).toBe("");
  });

  it("names the unreachable engine address while reconnecting", () => {
    render(<ConnectionBanner state="reconnecting" engineUrl={URL_} onOpenSettings={() => {}} />);
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("Motora ulaşılamıyor");
    expect(banner.textContent).toContain(URL_);
  });

  it("names the address while connecting", () => {
    render(<ConnectionBanner state="connecting" engineUrl={URL_} onOpenSettings={() => {}} />);
    expect(screen.getByRole("status").textContent).toContain(URL_);
  });

  it.each(["connecting", "reconnecting", "unauthorized"] as const)("offers connection settings when %s", (state) => {
    const onOpenSettings = vi.fn();
    render(<ConnectionBanner state={state} engineUrl={URL_} onOpenSettings={onOpenSettings} />);
    fireEvent.click(screen.getByRole("button", { name: "Bağlantı ayarları" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("works without a known address", () => {
    render(<ConnectionBanner state="reconnecting" onOpenSettings={() => {}} />);
    expect(screen.getByRole("status").textContent).toContain("Motora ulaşılamıyor");
  });

  it("an engine from before the handshake: says the engine must be updated, and that the key was not sent", () => {
    render(<ConnectionBanner state="outdated-engine" engineUrl={URL_} onOpenSettings={() => {}} />);
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("Motor eski sürüm; Mac mini'de güncelleyin");
    expect(text).toContain("Anahtar gönderilmedi");
    expect(text).toContain(URL_);
  });

  it("a server that could not prove it is the engine: says so, names the address, offers the settings", () => {
    const onOpenSettings = vi.fn();
    render(<ConnectionBanner state="engine-unverified" engineUrl={URL_} onOpenSettings={onOpenSettings} />);
    expect(screen.getByRole("status").textContent).toContain("motor olduğunu kanıtlayamadı");
    fireEvent.click(screen.getByRole("button", { name: "Bağlantı ayarları" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("an address that is not a protected transport: says so (the gate's reason when there is one) and leads to Ayarlar › Bağlantı", () => {
    const onOpenSettings = vi.fn();
    const { rerender } = render(<ConnectionBanner state="insecure-transport" engineUrl={URL_} onOpenSettings={onOpenSettings} />);
    expect(screen.getByRole("status").textContent).toContain("güvenli bir yol değil");
    rerender(<ConnectionBanner state="insecure-transport" engineUrl={URL_} onOpenSettings={onOpenSettings} transportMessage="Tailscale kapalı" />);
    expect(screen.getByRole("status").textContent).toContain("Tailscale kapalı");
    fireEvent.click(screen.getByRole("button", { name: "Bağlantı ayarları" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
