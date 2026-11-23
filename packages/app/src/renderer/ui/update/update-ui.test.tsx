// Kendini güncelleme — what the user sees: the strip in the connection banner's place and Ayarlar › Bağlantı.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateBridge, UpdateStatus } from "../../engine/update-ipc.ts";
import { parseUpdateStatus } from "../../engine/update-ipc.ts";
import { ConnectionBanner } from "../ConnectionBanner.tsx";
import { AboutSection } from "./AboutSection.tsx";
import { UpdateNotice } from "./UpdateNotice.tsx";
import { updateNotice } from "./update-text.ts";

afterEach(cleanup);

const APP = { buildId: "0.1.0+20261118100000.aaa", version: "0.1.0", commit: "aaa", builtAt: "2026-11-18T10:00:00.000Z" };
const ENGINE = { buildId: "0.1.0+20261118090000.eng", version: "0.1.0", commit: "eng", builtAt: "2026-11-18T09:00:00.000Z" };
const status = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({ phase: "idle", app: APP, engine: { version: "0.1.0", build: ENGINE, protocol: 1 }, compat: "ok", auto: true, ...over });

function fakeBridge(initial: UpdateStatus) {
  let listener: ((s: UpdateStatus) => void) | undefined;
  const bridge: UpdateBridge = {
    status: vi.fn(async () => initial),
    onStatus: (l) => {
      listener = l;
      return () => (listener = undefined);
    },
    check: vi.fn(async () => {}),
    download: vi.fn(async () => {}),
    apply: vi.fn(async () => {}),
    setAuto: vi.fn(async () => {}),
    rendererReady: vi.fn(async () => {}),
    moveToApplications: vi.fn(async () => {}),
    dismiss: vi.fn(async () => {}),
    confirmDowngrade: vi.fn(async () => {}),
    resetFloor: vi.fn(async () => {}),
  };
  return { bridge, push: (s: UpdateStatus) => act(() => listener?.(s)) };
}
const flush = () => act(async () => {});

describe("updateNotice", () => {
  it("says nothing while all is well, while checking, and while a compatible update downloads in the background", () => {
    expect(updateNotice(null)).toBeNull();
    expect(updateNotice(status())).toBeNull();
    expect(updateNotice(status({ phase: "checking" }))).toBeNull();
    expect(updateNotice(status({ phase: "downloading", progress: { received: 1, total: 2 } }))).toBeNull();
    expect(updateNotice(status({ phase: "verifying" }))).toBeNull();
    expect(updateNotice(status({ phase: "disabled", message: "kaynaktan" }))).toBeNull();
    expect(updateNotice(status({ last: { outcome: "updated", buildId: APP.buildId } }))).toBeNull();
  });

  it("ready → 'Güncelleme hazır — yeniden başlat' with the restart button", () => {
    expect(updateNotice(status({ phase: "ready" }))).toEqual({ text: "Güncelleme hazır — yeniden başlat", tone: "info", action: { kind: "apply", label: "Yeniden başlat" } });
  });

  it("the app is behind the engine and its update is on the way → 'Kokpit güncelleniyor…'", () => {
    for (const phase of ["checking", "downloading", "verifying", "applying"] as const) {
      expect(updateNotice(status({ phase, compat: "app-older" }))?.text).toBe("Kokpit güncelleniyor…");
    }
    expect(updateNotice(status({ phase: "applying" }))?.text).toBe("Kokpit güncelleniyor…");
  });

  it("the engine is older → says so, with the engine's build and what to do", () => {
    const n = updateNotice(status({ compat: "engine-older" }));
    expect(n?.text).toContain("Motor daha eski: 0.1.0+20261118090000.eng");
    expect(n?.text).toContain("pnpm deploy:local");
    expect(updateNotice(status({ compat: "engine-older", engine: { version: "0.1.0" } }))?.text).toContain("derleme kimliği yok");
  });

  it("automatic updates off → 'Güncelleme var' with a download button", () => {
    expect(updateNotice(status({ phase: "available", auto: false, target: { buildId: "b", version: "0.2.0" } }))).toMatchObject({ text: "Güncelleme var (0.2.0)", action: { kind: "download" } });
  });

  it("cannot install here → the reason, and an offer to move when that would help", () => {
    expect(updateNotice(status({ phase: "blocked", blocked: "translocated", message: "geçici kopya" }))).toMatchObject({ text: "geçici kopya", tone: "warn", action: { kind: "move" } });
    expect(updateNotice(status({ phase: "blocked", blocked: "read-only", message: "salt okunur" }))?.action?.kind).toBe("move");
    expect(updateNotice(status({ phase: "blocked", blocked: "disk-space", message: "yer yok" }))?.action).toBeUndefined();
  });

  it("a rolled-back update is told once, until dismissed", () => {
    const n = updateNotice(status({ last: { outcome: "rolledBack", buildId: "b", detail: "Yeni derleme açılmadı" } }));
    expect(n).toMatchObject({ text: "Güncelleme geri alındı: Yeni derleme açılmadı", tone: "warn", action: { kind: "dismiss" } });
  });
});

describe("UpdateNotice", () => {
  it("renders nothing without a bridge (outside Electron) and nothing while idle", async () => {
    const { container } = render(<UpdateNotice bridge={undefined} />);
    expect(container.textContent).toBe("");
    cleanup();
    const idle = render(<UpdateNotice bridge={fakeBridge(status()).bridge} />);
    await flush();
    expect(idle.container.textContent).toBe("");
  });

  it("shows 'Güncelleme hazır' when main says so, and the button restarts", async () => {
    const f = fakeBridge(status());
    render(<UpdateNotice bridge={f.bridge} />);
    await flush();
    f.push(status({ phase: "ready", target: { buildId: "b", version: "0.1.0" } }));
    expect(screen.getByRole("status").textContent).toContain("Güncelleme hazır — yeniden başlat");
    fireEvent.click(screen.getByRole("button", { name: "Yeniden başlat" }));
    expect(f.bridge.apply).toHaveBeenCalledTimes(1);
  });

  it("each action goes to its own call", async () => {
    const f = fakeBridge(status({ phase: "available", auto: false, target: { buildId: "b", version: "0.2.0" } }));
    render(<UpdateNotice bridge={f.bridge} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "İndir" }));
    expect(f.bridge.download).toHaveBeenCalledTimes(1);
    f.push(status({ phase: "blocked", blocked: "translocated", message: "x" }));
    fireEvent.click(screen.getByRole("button", { name: "Uygulamalar'a taşı" }));
    expect(f.bridge.moveToApplications).toHaveBeenCalledTimes(1);
    f.push(status({ last: { outcome: "rolledBack", buildId: "b" } }));
    fireEvent.click(screen.getByRole("button", { name: "Tamam" }));
    expect(f.bridge.dismiss).toHaveBeenCalledTimes(1);
  });

  it("sits in the connection banner's place: the banner renders it, and stays empty when there is nothing to say", () => {
    const { container } = render(<ConnectionBanner state="open" onOpenSettings={() => {}} />);
    expect(container.textContent).toBe("");
  });
});

describe("an older build on offer (below the floor)", () => {
  const offered = status({ phase: "available", target: { buildId: "0.1.0+20261117100000.old", version: "0.1.0", downgrade: true, builtAt: "2026-11-17 10:00" } });

  it("the strip says it is older and does not install by itself; its one button is 'Eski sürüme dön' for that build", async () => {
    const f = fakeBridge(offered);
    render(<UpdateNotice bridge={f.bridge} />);
    await flush();
    expect(screen.getByRole("status").textContent).toContain("Kendiliğinden kurulmaz");
    expect(screen.queryByRole("button", { name: "İndir" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Eski sürüme dön: 0.1.0 (2026-11-17 10:00)" }));
    expect(f.bridge.confirmDowngrade).toHaveBeenCalledWith("0.1.0+20261117100000.old");
    expect(f.bridge.download).not.toHaveBeenCalled();
  });

  it("Ayarlar shows the same dedicated action, separate from 'Şimdi denetle'", async () => {
    const f = fakeBridge(offered);
    render(<AboutSection bridge={f.bridge} />);
    await flush();
    expect(screen.queryByRole("button", { name: "İndir" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Şimdi denetle" }));
    expect(f.bridge.confirmDowngrade).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Eski sürüme dön/ }));
    expect(f.bridge.confirmDowngrade).toHaveBeenCalledWith("0.1.0+20261117100000.old");
  });
});

describe("AboutSection (Ayarlar › Bağlantı)", () => {
  it("resetting the rollback floor takes two clicks: the first only asks, 'Vazgeç' backs out", async () => {
    const f = fakeBridge(status());
    render(<AboutSection bridge={f.bridge} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Sürüm tabanını sıfırla…" }));
    expect(f.bridge.resetFloor).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Vazgeç" }));
    expect(screen.queryByRole("button", { name: "Evet, tabanı sıfırla" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sürüm tabanını sıfırla…" }));
    fireEvent.click(screen.getByRole("button", { name: "Evet, tabanı sıfırla" }));
    expect(f.bridge.resetFloor).toHaveBeenCalledTimes(1);
  });

  it("shows both build ids, the compatibility and the state", async () => {
    render(<AboutSection bridge={fakeBridge(status()).bridge} />);
    await flush();
    const section = screen.getByRole("region", { name: "Sürüm ve güncelleme" });
    expect(section.textContent).toContain(APP.buildId);
    expect(section.textContent).toContain(ENGINE.buildId);
    expect(section.textContent).toContain("uyumlu");
    expect(section.textContent).toContain("Güncel");
  });

  it("an engine without a build id is named as such", async () => {
    render(<AboutSection bridge={fakeBridge(status({ compat: "engine-older", engine: { version: "0.1.0" } })).bridge} />);
    await flush();
    expect(screen.getByRole("region").textContent).toContain("derleme kimliği yok");
    expect(screen.getByRole("region").textContent).toContain("motor daha eski");
  });

  it("the switch turns automatic updates off and on; 'Şimdi denetle' asks the engine", async () => {
    const f = fakeBridge(status());
    render(<AboutSection bridge={f.bridge} />);
    await flush();
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(f.bridge.setAuto).toHaveBeenCalledWith(false);
    f.push(status({ auto: false }));
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Şimdi denetle" }));
    expect(f.bridge.check).toHaveBeenCalledTimes(1);
  });

  it("download progress and the ready build are shown; the ready build can be installed from here", async () => {
    const f = fakeBridge(status({ phase: "downloading", progress: { received: 50, total: 200 }, target: { buildId: "b", version: "0.1.0" } }));
    render(<AboutSection bridge={f.bridge} />);
    await flush();
    expect(screen.getByRole("status").textContent).toBe("İndiriliyor… %25");
    f.push(status({ phase: "ready", target: { buildId: "0.1.0+x.b", version: "0.1.0" } }));
    expect(screen.getByRole("status").textContent).toContain("0.1.0+x.b");
    fireEvent.click(screen.getByRole("button", { name: "Yeniden başlat ve kur" }));
    expect(f.bridge.apply).toHaveBeenCalledTimes(1);
  });

  it("in an app run from source everything is off and says why", async () => {
    render(<AboutSection bridge={fakeBridge(status({ phase: "disabled", engine: null, compat: "unknown", message: "Bu uygulama kaynaktan çalışıyor; kendini güncellemez." })).bridge} />);
    await flush();
    expect(screen.getByRole("status").textContent).toContain("kaynaktan");
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Şimdi denetle" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("parseUpdateStatus", () => {
  it("accepts a status and refuses anything else", () => {
    expect(parseUpdateStatus(status())).toEqual(status());
    for (const bad of [null, "x", [], { phase: "idle" }, { phase: "nope", app: APP }, { phase: "idle", app: {} }]) expect(parseUpdateStatus(bad)).toBeNull();
  });
});
