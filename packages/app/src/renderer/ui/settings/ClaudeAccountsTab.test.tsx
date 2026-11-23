// İş H — Ayarlar › Claude hesapları.
import type { TerminalInfo } from "@kokpit/shared";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeEngineClient, makeProject, makeSshProject } from "../test-utils/fake-client.ts";
import { FAKE_HOME } from "../test-utils/fake-claude-accounts.ts";
import { Settings } from "./Settings.tsx";

const flush = () => act(async () => {});
const WORK = { id: "work", name: "Work", configDir: `${FAKE_HOME}/.claude-work` };

function seed() {
  return new FakeEngineClient({
    projects: [
      makeProject("home", "Mac mini", { builtin: true, location: { kind: "local", path: FAKE_HOME } }),
      makeProject("p1", "Alfa", { claudeAccountId: "work" }),
      makeProject("p2", "Beta"),
      makeSshProject("p3", "Uzak", "h1"),
    ],
    claudeAccounts: [{ id: "benim", name: "Benim", configDir: `${FAKE_HOME}/.claude`, isDefault: true }, WORK],
  });
}

async function setup(tab: "claude" | "projects" = "claude", client = seed()) {
  const onInstalled = vi.fn<(t: TerminalInfo) => void>();
  render(
    <Settings client={client} tab={tab} onTabChange={() => {}} onBack={() => {}} onInstalled={onInstalled} connection={<p>x</p>} />,
  );
  await flush();
  return { client, onInstalled };
}

const panel = () => screen.getByRole("tabpanel");
const item = (name: string) => within(panel()).getByRole("heading", { name }).closest("li") as HTMLElement;
async function click(el: HTMLElement) {
  fireEvent.click(el);
  await flush();
}

afterEach(cleanup);


const usageWindow = (messages: number, cacheRead: number) => ({ totals: { messages, input: 0, output: 0, cacheWrite: 0, cacheRead }, byModel: [], topProjects: [] });
const usageAccount = (accountId: string, name: string, session: number) => ({
  accountId,
  name,
  windows: { session: usageWindow(3, session), today: usageWindow(5, 3_400_000), week: usageWindow(9, 30_000_000) },
  updatedAt: "2026-11-18T12:00:00.000Z",
  indexing: false,
});
const USAGE = {
  accounts: [usageAccount("benim", "Benim", 500), usageAccount("work", "Work", 1_200_000)],
  sessionWindowHours: 5,
  longWindowDays: 7,
  refreshIntervalMs: 60_000,
  probeAvailable: false,
};

describe("Claude hesapları tab — kullanım", () => {
  it("each account shows its own usage block", async () => {
    const client = seed();
    client.respond("claudeUsage.get", () => USAGE);
    await setup("claude", client);
    const work = within(item("Work")).getByRole("group", { name: "Claude kullanımı: Work" });
    expect(within(work).getByRole("row", { name: /^Son 5 saat/ }).textContent).toContain("1,2 Mn");
    const benim = within(item("Benim")).getByRole("group", { name: "Claude kullanımı: Benim" });
    expect(within(benim).getByRole("row", { name: /^Son 5 saat/ }).textContent).toContain("500");
    expect(within(work).getByText(/Claude'un kendi kota yüzdesi değildir/)).toBeTruthy();
  });

  it("an account the engine has no numbers for shows no block; a failed read does not hide the accounts", async () => {
    const client = seed();
    client.respond("claudeUsage.get", () => ({ ...USAGE, accounts: [USAGE.accounts[0]!] }));
    await setup("claude", client);
    expect(within(item("Work")).queryByRole("group", { name: /Claude kullanımı/ })).toBeNull();
    expect(within(item("Benim")).getByRole("group", { name: "Claude kullanımı: Benim" })).toBeTruthy();
    cleanup();
    const broken = seed();
    broken.fail("claudeUsage.get", "INVALID", "Claude kullanımı bu motorda etkin değil");
    await setup("claude", broken);
    expect(item("Work")).toBeTruthy();
    expect(within(panel()).getByText(/Kullanım yüklenemedi: Claude kullanımı bu motorda etkin değil/)).toBeTruthy();
  });
});

describe("Claude hesapları tab", () => {
  it("is a settings tab and lists accounts with their folders; the default has no Sil", async () => {
    await setup();
    expect(screen.getByRole("tab", { name: "Claude hesapları" }).getAttribute("aria-selected")).toBe("true");
    const benim = item("Benim");
    expect(within(benim).getByText(`${FAKE_HOME}/.claude`)).toBeTruthy();
    expect(within(benim).getByText("Varsayılan")).toBeTruthy();
    expect(within(benim).queryByRole("button", { name: /^Sil/ })).toBeNull();
    expect(within(benim).queryByRole("button", { name: /Skill'leri paylaş/ })).toBeNull();
    const work = item("Work");
    expect(within(work).getByText(WORK.configDir)).toBeTruthy();
    expect(within(work).getByText("1 proje")).toBeTruthy();
    expect(within(work).getByRole("button", { name: "Sil: Work" })).toBeTruthy();
  });

  it("adds an account; checks the folder before sending", async () => {
    const { client } = await setup();
    await click(within(panel()).getByRole("button", { name: "Hesap ekle" }));
    fireEvent.change(within(panel()).getByLabelText("Ad"), { target: { value: "İş" } });
    fireEvent.change(within(panel()).getByLabelText("Ayar klasörü"), { target: { value: "relative" } });
    await click(within(panel()).getByRole("button", { name: "Kaydet" }));
    expect(client.callsOf("claudeAccounts.create")).toEqual([]);
    expect(within(panel()).getByText("Ayar klasörü / ya da ~/ ile başlamalı.")).toBeTruthy();
    fireEvent.change(within(panel()).getByLabelText("Ayar klasörü"), { target: { value: "~/.claude-is" } });
    await click(within(panel()).getByRole("button", { name: "Kaydet" }));
    expect(client.callsOf("claudeAccounts.create")).toEqual([{ name: "İş", configDir: "~/.claude-is" }]);
    expect(within(panel()).getByText(`${FAKE_HOME}/.claude-is`)).toBeTruthy();
  });

  it("shows the engine's refusal verbatim", async () => {
    const { client } = await setup();
    await click(within(panel()).getByRole("button", { name: "Hesap ekle" }));
    fireEvent.change(within(panel()).getByLabelText("Ad"), { target: { value: "X" } });
    fireEvent.change(within(panel()).getByLabelText("Ayar klasörü"), { target: { value: "/etc/x" } });
    await click(within(panel()).getByRole("button", { name: "Kaydet" }));
    expect(client.callsOf("claudeAccounts.create")).toHaveLength(1);
    expect(within(panel()).getByRole("alert").textContent).toContain(`ana klasörün (${FAKE_HOME}) içinde olmalı`);
  });

  it("edits the name; the default account's folder is read-only", async () => {
    const { client } = await setup();
    await click(within(item("Benim")).getByRole("button", { name: "Düzenle: Benim" }));
    expect(within(panel()).queryByLabelText("Ayar klasörü")).toBeNull();
    fireEvent.change(within(panel()).getByLabelText("Ad"), { target: { value: "Alex" } });
    await click(within(panel()).getByRole("button", { name: "Kaydet" }));
    expect(client.callsOf("claudeAccounts.update")).toEqual([{ id: "benim", name: "Alex" }]);
  });

  it("Giriş yap opens the login terminal and hands it to the caller", async () => {
    const { client, onInstalled } = await setup();
    await click(within(item("Work")).getByRole("button", { name: "Giriş yap: Work" }));
    expect(client.callsOf("claudeAccounts.login")).toMatchObject([{ id: "work" }]);
    expect(onInstalled).toHaveBeenCalledWith(expect.objectContaining({ projectId: "home", command: "claude /login" }));
  });

  it("Skill'leri paylaş asks first, then reports what was linked and skipped", async () => {
    const { client } = await setup();
    await click(within(item("Work")).getByRole("button", { name: "Skill'leri paylaş: Work" }));
    expect(client.callsOf("claudeAccounts.shareSkills")).toEqual([]);
    expect(within(item("Work")).getByText(/var olanlara dokunulmaz/)).toBeTruthy();
    await click(within(item("Work")).getByRole("button", { name: "Paylaşmayı onayla" }));
    expect(client.callsOf("claudeAccounts.shareSkills")).toEqual([{ id: "work", confirm: true }]);
    expect(within(item("Work")).getByRole("status").textContent).toMatch(/Bağlandı: skills.*Atlandı: agents/);
  });

  it("delete is refused by the engine while projects use it; reason shown", async () => {
    const { client } = await setup();
    client.fail("claudeAccounts.delete", "INVALID", "1 proje bu hesabı kullanıyor: Alfa");
    await click(within(item("Work")).getByRole("button", { name: "Sil: Work" }));
    await click(within(item("Work")).getByRole("button", { name: "Silmeyi onayla" }));
    expect(within(item("Work")).getByRole("alert").textContent).toBe("1 proje bu hesabı kullanıyor: Alfa");
  });
});

describe("project form: Claude hesabı (İş H)", () => {
  it("lists the account in the project list and lets the form change / clear it", async () => {
    const { client } = await setup("projects");
    const alfa = item("Alfa");
    expect(within(alfa).getByText("Claude hesabı: Work")).toBeTruthy();
    expect(within(item("Beta")).queryByText(/Claude hesabı/)).toBeNull();
    await click(within(alfa).getByRole("button", { name: "Düzenle: Alfa" }));
    const select = within(panel()).getByLabelText("Claude hesabı") as HTMLSelectElement;
    expect(select.value).toBe("work");
    expect([...select.options].map((o) => o.textContent)).toEqual(["Benim (varsayılan)", "Work"]);
    fireEvent.change(select, { target: { value: "" } });
    await click(within(panel()).getByRole("button", { name: "Kaydet" }));
    expect(client.callsOf("projects.update").at(-1)).toMatchObject({ projectId: "p1", claudeAccountId: null });
  });

  it("new projects can pick an account; ssh projects say it is ignored", async () => {
    const { client } = await setup("projects");
    await click(within(panel()).getByRole("button", { name: "Proje ekle" }));
    fireEvent.change(within(panel()).getByLabelText("Ad"), { target: { value: "Yeni" } });
    fireEvent.change(within(panel()).getByLabelText("Klasör yolu"), { target: { value: "/tmp/yeni" } });
    fireEvent.change(within(panel()).getByLabelText("Claude hesabı"), { target: { value: "work" } });
    await click(within(panel()).getByRole("button", { name: "Kaydet" }));
    expect(client.callsOf("projects.create").at(-1)).toMatchObject({ name: "Yeni", claudeAccountId: "work" });
    await click(within(item("Uzak")).getByRole("button", { name: "Düzenle: Uzak" }));
    expect(within(panel()).getByText(/SSH projelerinde yok sayılır/)).toBeTruthy();
  });
});
