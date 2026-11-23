// Girişler: the key button of the Tarayıcı toolbar and its popover — this project's saved logins for the open site
// first (one-click "Doldur"), the others greyed with their site, "Bu site için kaydet", delete with confirm.
// The password is write-only: typed into a password field, sent once, cleared, never shown.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserLogins } from "./BrowserLogins.tsx";
import { BrowserPanel, type FrameDrawer } from "./BrowserPanel.tsx";
import { defaultUiConfig } from "./config.ts";
import { FakeEngineClient, makeProject } from "./test-utils/fake-client.ts";
import { makeLogin } from "./test-utils/fake-logins.ts";
import { FakeResizeObserver } from "./test-utils/fake-view.ts";

const flush = () => act(async () => {});
const SITE = "https://ornek.example";
const PAGE = `${SITE}/giris?x=1`;
const SECRET = "gizli-parola-Zx9!";

function setup(pageUrl = PAGE, projectId = "p1") {
  const client = new FakeEngineClient({ projects: [makeProject("p1", "Alfa"), makeProject("p2", "Beta")] });
  client.logins.pageOrigin = SITE;
  // The user already accepted the agent risk in this project (the tests about that risk take it back).
  client.logins.accepted.add("p1");
  client.logins.items = [
    makeLogin("a", "p1", "https://baska.example", "başka-site"),
    makeLogin("b", "p1", SITE, "ayşe@ornek.example", { label: "İş hesabı" }),
    makeLogin("c", "p1", SITE, "ikinci"),
    makeLogin("z", "p2", SITE, "başka-projenin-girişi"),
  ];
  const view = render(<BrowserLogins client={client} projectId={projectId} pageUrl={pageUrl} />);
  return { client, view };
}

const toggle = () => screen.getByRole("button", { name: "Girişler" });
async function openPopover() {
  fireEvent.click(toggle());
  await flush();
  return screen.getByRole("dialog", { name: "Girişler" });
}
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

afterEach(() => cleanup());

describe("BrowserLogins", () => {
  it("is one small button with a name and a tooltip; closed until clicked, and asks the engine nothing before", async () => {
    const { client } = setup();
    await flush();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().getAttribute("title")).toMatch(/Girişler/);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(client.callsOf("logins.list")).toEqual([]);
  });

  it("lists this project's logins: the open site's first with 'Doldur', the others greyed with their site", async () => {
    const { client } = setup();
    const pop = await openPopover();
    expect(client.callsOf("logins.list")).toEqual([{ projectId: "p1" }]);
    const here = within(within(pop).getByRole("list", { name: "Bu site" })).getAllByRole("listitem");
    expect(here.map((li) => li.textContent)).toEqual([expect.stringContaining("ayşe@ornek.example"), expect.stringContaining("ikinci")]);
    expect(here[0]!.textContent).toContain("İş hesabı");
    expect(within(here[0]!).getByRole("button", { name: "Doldur: ayşe@ornek.example" })).toBeTruthy();
    const others = within(within(pop).getByRole("list", { name: "Diğer siteler" })).getAllByRole("listitem");
    expect(others).toHaveLength(1);
    expect(others[0]!.textContent).toContain("başka-site");
    expect(others[0]!.textContent).toContain("https://baska.example");
    expect(within(others[0]!).queryByRole("button", { name: /Doldur/ })).toBeNull();
    // Another project's login is never offered.
    expect(pop.textContent).not.toContain("başka-projenin-girişi");
  });

  it("'Doldur' asks the engine with ids only and closes the popover", async () => {
    const { client } = setup();
    const pop = await openPopover();
    fireEvent.click(within(pop).getByRole("button", { name: "Doldur: ayşe@ornek.example" }));
    await flush();
    expect(client.callsOf("logins.fill")).toEqual([{ projectId: "p1", id: "b" }]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("first fill in a project: asks, naming the agent risk in one sentence; 'Vazgeç' fills nothing", async () => {
    const { client } = setup();
    client.logins.accepted.clear();
    const pop = await openPopover();
    fireEvent.click(within(pop).getByRole("button", { name: "Doldur: ikinci" }));
    await flush();
    expect(client.callsOf("logins.fill")).toEqual([]);
    const ask = within(pop).getByRole("alertdialog", { name: "Ajan riski" });
    expect(ask.textContent).toContain("Bu tarayıcıyı ajanlar da sürebiliyor; doldurulan şifreyi okuyabilirler");
    fireEvent.click(within(ask).getByRole("button", { name: "Vazgeç" }));
    await flush();
    expect(within(pop).queryByRole("alertdialog")).toBeNull();
    expect(client.callsOf("logins.fill")).toEqual([]);
    expect(client.callsOf("logins.risk.set")).toEqual([]);
  });

  it("'Yine de doldur' records the acceptance in the engine, then fills; the next fill does not ask again", async () => {
    const { client } = setup();
    client.logins.accepted.clear();
    let pop = await openPopover();
    fireEvent.click(within(pop).getByRole("button", { name: "Doldur: ikinci" }));
    await flush();
    fireEvent.click(within(pop).getByRole("button", { name: "Yine de doldur" }));
    await flush();
    expect(client.callsOf("logins.risk.set")).toEqual([{ projectId: "p1", accepted: true }]);
    expect(client.callsOf("logins.fill")).toEqual([{ projectId: "p1", id: "c", confirmAgentRisk: true }]);
    pop = await openPopover();
    fireEvent.click(within(pop).getByRole("button", { name: "Doldur: ikinci" }));
    await flush();
    expect(client.callsOf("logins.fill")).toHaveLength(2);
    expect(client.callsOf("logins.fill")[1]).toEqual({ projectId: "p1", id: "c" });
  });

  it("while an agent-capable terminal runs it asks on EVERY fill, even after the project's acceptance", async () => {
    const { client } = setup();
    client.logins.agentsPresent = true;
    for (let i = 1; i <= 2; i++) {
      const pop = await openPopover();
      fireEvent.click(within(pop).getByRole("button", { name: "Doldur: ikinci" }));
      await flush();
      expect(client.callsOf("logins.fill")).toHaveLength(i - 1);
      expect(within(pop).getByRole("alertdialog").textContent).toMatch(/Şu an bu projede çalışan ajan var/);
      fireEvent.click(within(pop).getByRole("button", { name: "Yine de doldur" }));
      await flush();
      expect(client.callsOf("logins.fill")).toHaveLength(i);
    }
    expect(client.callsOf("logins.risk.set")).toEqual([]); // already accepted: only the per-fill confirmation
    expect(client.callsOf("logins.fill")[0]).toEqual({ projectId: "p1", id: "c", confirmAgentRisk: true });
  });

  it("the acceptance can be taken back in the popover", async () => {
    const { client } = setup();
    const pop = await openPopover();
    fireEvent.click(within(pop).getByRole("button", { name: "Ajan riski onayını geri al" }));
    await flush();
    expect(client.callsOf("logins.risk.set")).toEqual([{ projectId: "p1", accepted: false }]);
    expect(within(pop).queryByRole("button", { name: "Ajan riski onayını geri al" })).toBeNull();
    fireEvent.click(within(pop).getByRole("button", { name: "Doldur: ikinci" }));
    await flush();
    expect(within(pop).getByRole("alertdialog")).toBeTruthy();
    expect(client.callsOf("logins.fill")).toEqual([]);
  });

  it("the engine holds the line even if the app's idea of the policy is stale", async () => {
    const { client } = setup();
    const pop = await openPopover();
    client.logins.accepted.clear(); // taken back from another window
    fireEvent.click(within(pop).getByRole("button", { name: "Doldur: ikinci" }));
    await flush();
    expect(client.logins.filled).toEqual([]);
    expect(within(pop).getByRole("alert").textContent).toMatch(/ajanlar da sürebiliyor/);
  });

  it("confirm mode: while the fill waits, it says an approval is awaited on the engine Mac's screen", async () => {
    const { client } = setup();
    const pop = await openPopover();
    const release = client.hold(["logins.fill"]);
    fireEvent.click(within(pop).getByRole("button", { name: "Doldur: ikinci" }));
    await flush();
    expect(within(pop).getByRole("status").textContent).toMatch(/Anahtar Zinciri onayı bekleniyor/);
    release();
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("silent mode: no waiting text, and the small print says what each mode protects against", async () => {
    const { client } = setup();
    client.logins.keychainAccess = "silent";
    let pop = await openPopover();
    expect(pop.textContent).toMatch(/onay sormaz/);
    expect(pop.textContent).toMatch(/her program \(ajanlar dahil\)/);
    const release = client.hold(["logins.fill"]);
    fireEvent.click(within(pop).getByRole("button", { name: "Doldur: ikinci" }));
    await flush();
    expect(within(pop).queryByRole("status")).toBeNull();
    release();
    await flush();
    cleanup();
    setup();
    pop = await openPopover();
    expect(pop.textContent).toMatch(/Her doldurmada.*onay/);
    expect(pop.textContent).toMatch(/tıklamanız olmadan okuyamaz/);
  });

  it("a refused fill keeps the popover open and shows the engine's message", async () => {
    const { client } = setup();
    client.logins.pageOrigin = "https://kotu.example"; // the page changed under the panel
    const pop = await openPopover();
    fireEvent.click(within(pop).getByRole("button", { name: "Doldur: ikinci" }));
    await flush();
    expect(within(pop).getByRole("alert").textContent).toMatch(/https:\/\/ornek\.example için kayıtlı; açık sayfa https:\/\/kotu\.example/);
  });

  it("a partial fill says which field was filled", async () => {
    const { client } = setup();
    client.logins.fields = ["username"];
    const pop = await openPopover();
    fireEvent.click(within(pop).getByRole("button", { name: "Doldur: ikinci" }));
    await flush();
    expect(within(screen.getByRole("dialog")).getByRole("status").textContent).toMatch(/Yalnız kullanıcı adı dolduruldu/);
  });

  it("'Bu site için kaydet': the site is the open page's origin, the password field is a password field, and the password is sent once and cleared", async () => {
    const { client } = setup();
    const pop = await openPopover();
    fireEvent.click(within(pop).getByRole("button", { name: "Bu site için kaydet" }));
    const form = within(pop).getByRole("form", { name: "Bu site için kaydet" });
    expect(form.textContent).toContain(SITE);
    const user = within(form).getByLabelText("Kullanıcı adı") as HTMLInputElement;
    const pw = within(form).getByLabelText("Parola") as HTMLInputElement;
    expect(pw.type).toBe("password");
    expect(pw.getAttribute("autocomplete")).toBe("new-password");
    type(user, "yeni@ornek.example");
    type(pw, SECRET);
    fireEvent.submit(form);
    await flush();
    expect(client.logins.saved).toEqual([{ projectId: "p1", origin: SITE, username: "yeni@ornek.example", password: SECRET }]);
    // The list is re-read and shows the new login; the password is nowhere in the document any more.
    expect(within(screen.getByRole("list", { name: "Bu site" })).getAllByRole("listitem")).toHaveLength(3);
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect([...document.querySelectorAll("input")].every((i) => i.value !== SECRET)).toBe(true);
    expect(screen.queryByRole("form")).toBeNull();
  });

  it("the page changes while the save form is open: the form is cancelled, naming both sites — never rebound", async () => {
    const { client, view } = setup();
    const pop = await openPopover();
    fireEvent.click(within(pop).getByRole("button", { name: "Bu site için kaydet" }));
    const form = within(pop).getByRole("form", { name: "Bu site için kaydet" });
    type(within(form).getByLabelText("Kullanıcı adı"), "yeni");
    type(within(form).getByLabelText("Parola"), SECRET);
    // A redirect, an agent or another tab: the panel now shows another site.
    view.rerender(<BrowserLogins client={client} projectId="p1" pageUrl="https://kotu.example/giris" />);
    await flush();
    expect(screen.queryByRole("form")).toBeNull();
    const alert = within(screen.getByRole("dialog")).getByRole("alert").textContent ?? "";
    expect(alert).toContain(SITE);
    expect(alert).toContain("https://kotu.example");
    expect(alert).toMatch(/iptal/);
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(client.logins.saved).toEqual([]);
    // Opening the form again is a new decision, for the site that is open now.
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Bu site için kaydet" }));
    const again = screen.getByRole("form", { name: "Bu site için kaydet" });
    expect(again.textContent).toContain("https://kotu.example");
    expect((within(again).getByLabelText("Parola") as HTMLInputElement).value).toBe("");
  });

  it("a navigation within the same site keeps the form; leaving to a page that is not a site cancels it", async () => {
    const { client, view } = setup();
    const pop = await openPopover();
    fireEvent.click(within(pop).getByRole("button", { name: "Bu site için kaydet" }));
    type(within(pop).getByLabelText("Parola"), SECRET);
    view.rerender(<BrowserLogins client={client} projectId="p1" pageUrl={`${SITE}/baska-yol#x`} />);
    await flush();
    expect((screen.getByLabelText("Parola") as HTMLInputElement).value).toBe(SECRET);
    view.rerender(<BrowserLogins client={client} projectId="p1" pageUrl="about:blank" />);
    await flush();
    expect(screen.queryByRole("form")).toBeNull();
    expect(within(screen.getByRole("dialog")).getByRole("alert").textContent).toContain(SITE);
    expect(client.logins.saved).toEqual([]);
  });

  it("the list follows the open page: after a navigation the old site's logins lose 'Doldur'", async () => {
    const { client, view } = setup();
    const pop = await openPopover();
    expect(within(pop).getAllByRole("button", { name: /^Doldur/ })).toHaveLength(2);
    view.rerender(<BrowserLogins client={client} projectId="p1" pageUrl="https://kotu.example/" />);
    await flush();
    expect(within(screen.getByRole("dialog")).queryByRole("button", { name: /^Doldur/ })).toBeNull();
    expect(client.callsOf("logins.fill")).toEqual([]);
  });

  it("there is no way to show a saved password: no reveal control, no password in what the list holds", async () => {
    setup();
    const pop = await openPopover();
    expect(within(pop).queryByRole("button", { name: /göster|kopyala/i })).toBeNull();
    expect(pop.querySelectorAll("input")).toHaveLength(0);
  });

  it("refuses to save without a username or a password, and on a page that is not a site", async () => {
    const { client } = setup();
    const pop = await openPopover();
    fireEvent.click(within(pop).getByRole("button", { name: "Bu site için kaydet" }));
    const form = within(pop).getByRole("form", { name: "Bu site için kaydet" });
    fireEvent.submit(form);
    await flush();
    expect(within(pop).getByRole("alert").textContent).toMatch(/Kullanıcı adı ve parola/);
    type(within(form).getByLabelText("Kullanıcı adı"), "   ");
    type(within(form).getByLabelText("Parola"), SECRET);
    fireEvent.submit(form);
    await flush();
    expect(client.logins.saved).toEqual([]);
    cleanup();
    setup("about:blank");
    const blank = await openPopover();
    expect((within(blank).getByRole("button", { name: "Bu site için kaydet" }) as HTMLButtonElement).disabled).toBe(true);
    expect(blank.textContent).toMatch(/http\(s\) sayfası değil/);
    // Without a site nothing matches: every login is listed under "Diğer siteler".
    expect(within(blank).queryByRole("list", { name: "Bu site" })).toBeNull();
  });

  it("an engine error on save is shown and the typed password stays in the (password) field for a retry", async () => {
    const { client } = setup();
    client.fail("logins.save", "KEYCHAIN_FAILED", "Anahtar zinciri kilitli ya da onay bekliyor.");
    const pop = await openPopover();
    fireEvent.click(within(pop).getByRole("button", { name: "Bu site için kaydet" }));
    const form = within(pop).getByRole("form", { name: "Bu site için kaydet" });
    type(within(form).getByLabelText("Kullanıcı adı"), "yeni");
    type(within(form).getByLabelText("Parola"), SECRET);
    fireEvent.submit(form);
    await flush();
    expect(within(pop).getByRole("alert").textContent).toBe("Anahtar zinciri kilitli ya da onay bekliyor.");
    expect((within(form).getByLabelText("Parola") as HTMLInputElement).value).toBe(SECRET);
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("delete asks first; 'Vazgeç' keeps the login, 'Sil' deletes it", async () => {
    const { client } = setup();
    const pop = await openPopover();
    fireEvent.click(within(pop).getByRole("button", { name: "Sil: ikinci" }));
    expect(client.callsOf("logins.delete")).toEqual([]);
    fireEvent.click(within(pop).getByRole("button", { name: "Vazgeç" }));
    expect(within(pop).queryByRole("button", { name: "Vazgeç" })).toBeNull();
    fireEvent.click(within(pop).getByRole("button", { name: "Sil: ikinci" }));
    fireEvent.click(within(pop).getByRole("button", { name: "Silmeyi onayla: ikinci" }));
    await flush();
    expect(client.callsOf("logins.delete")).toEqual([{ id: "c" }]);
    expect(within(screen.getByRole("list", { name: "Bu site" })).getAllByRole("listitem")).toHaveLength(1);
  });

  it("an empty project shows a short empty state", async () => {
    const { client } = setup();
    client.logins.items = [];
    const pop = await openPopover();
    expect(pop.textContent).toContain("Kayıtlı giriş yok.");
    expect(within(pop).queryByRole("list")).toBeNull();
  });

  it("says where passwords live and that an agent on the same browser can read a filled one", async () => {
    setup();
    const pop = await openPopover();
    expect(pop.textContent).toMatch(/Anahtar Zinciri/);
    expect(pop.textContent).toMatch(/ajan.*okuyabilir/);
  });

  it("Escape, the button again and a click outside close it; a typed password does not survive closing", async () => {
    setup();
    let pop = await openPopover();
    fireEvent.click(within(pop).getByRole("button", { name: "Bu site için kaydet" }));
    type(within(pop).getByLabelText("Parola"), SECRET);
    fireEvent.keyDown(pop, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    pop = await openPopover();
    expect(within(pop).queryByRole("form")).toBeNull();
    expect(document.body.innerHTML).not.toContain(SECRET);
    fireEvent.click(toggle());
    expect(screen.queryByRole("dialog")).toBeNull();
    await openPopover();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a list error is shown; a disconnected engine is not an error", async () => {
    const { client } = setup();
    client.fail("logins.list", "INTERNAL", "internal error");
    const pop = await openPopover();
    expect(within(pop).getByRole("alert").textContent).toBe("internal error");
    cleanup();
    const again = setup();
    again.client.fail("logins.list", "DISCONNECTED", "bağlantı yok");
    const pop2 = await openPopover();
    expect(within(pop2).queryByRole("alert")).toBeNull();
  });

  it("monkey: odd usernames and labels render as text", async () => {
    const { client } = setup();
    client.logins.items = [makeLogin("x", "p1", SITE, "<img src=x onerror=alert(1)>", { label: "‮RTL‬ 😀 " + "u".repeat(100) })];
    const pop = await openPopover();
    expect(pop.querySelector("img")).toBeNull();
    expect(pop.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("BrowserPanel: Girişler button", () => {
  const draw: FrameDrawer = async () => ({ width: 1280, height: 800 });
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number);
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sits in the toolbar of a running browser — no new row — and knows the open page's site", async () => {
    const project = makeProject("p1", "Alfa");
    const client = new FakeEngineClient({ projects: [project] });
    client.browser.handlers["browser.open"]({ projectId: "p1" });
    client.browser.handlers["browser.navigate"]({ projectId: "p1", url: PAGE });
    client.logins.items = [makeLogin("b", "p1", SITE, "ayşe")];
    client.logins.pageOrigin = SITE;
    client.logins.accepted.add("p1");
    render(<BrowserPanel client={client} project={project} config={defaultUiConfig} drawFrame={draw} />);
    await flush();
    const button = toggle();
    expect(button.closest(".kp-browser__toolbar")).not.toBeNull();
    fireEvent.click(button);
    await flush();
    fireEvent.click(within(screen.getByRole("dialog", { name: "Girişler" })).getByRole("button", { name: "Doldur: ayşe" }));
    await flush();
    expect(client.callsOf("logins.fill")).toEqual([{ projectId: "p1", id: "b" }]);
  });

  it("a closed browser has no Girişler button (nothing to fill)", async () => {
    const project = makeProject("p1", "Alfa");
    render(<BrowserPanel client={new FakeEngineClient({ projects: [project] })} project={project} config={defaultUiConfig} drawFrame={draw} />);
    await flush();
    expect(screen.queryByRole("button", { name: "Girişler" })).toBeNull();
  });
});
