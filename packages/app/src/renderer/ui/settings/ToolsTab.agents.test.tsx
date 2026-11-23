// İş A — "Bekleme kalıpları" in the tool form.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultUiConfig } from "../config.ts";
import { FakeEngineClient, makeTool } from "../test-utils/fake-client.ts";
import { ToolsTab } from "./ToolsTab.tsx";
import { parsePatterns } from "./validation.ts";

const flush = () => act(async () => {});

function seed() {
  return new FakeEngineClient({
    tools: [makeTool("claude", "Claude", { waitingPatterns: ["Do you want to proceed\\?", "❯ *1\\. *Yes"] }), makeTool("t2", "İkinci")],
  });
}

async function setup(client = seed()) {
  render(<ToolsTab client={client} config={defaultUiConfig} onInstalled={vi.fn()} />);
  await flush();
  return client;
}

const form = () => screen.getByRole("form");
const patterns = () => within(form()).getByLabelText("Bekleme kalıpları") as HTMLTextAreaElement;
async function press(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
  await flush();
}

afterEach(cleanup);

describe("parsePatterns", () => {
  it("one regex per line; blank lines and surrounding spaces dropped", () => {
    expect(parsePatterns("  a\\?  \n\n b \r\n")).toEqual({ ok: true, patterns: ["a\\?", "b"] });
    expect(parsePatterns("")).toEqual({ ok: true, patterns: [] });
  });
  it("names the first invalid line", () => {
    expect(parsePatterns("ok\n(broken")).toEqual({ ok: false, error: "Satır 2: geçersiz düzenli ifade." });
  });
  it("bounds count and length", () => {
    expect(parsePatterns(Array.from({ length: 51 }, (_, i) => `p${i}`).join("\n")).ok).toBe(false);
    expect(parsePatterns("a".repeat(501)).ok).toBe(false);
  });
});

describe("ToolsTab: Bekleme kalıpları", () => {
  it("edit shows the tool's patterns one per line, with a hint", async () => {
    await setup();
    await press("Düzenle: Claude");
    expect(patterns().value).toBe("Do you want to proceed\\?\n❯ *1\\. *Yes");
    expect(within(form()).getByText(/Her satıra bir düzenli ifade/)).toBeTruthy();
  });

  it("saving changed patterns sends them; unchanged patterns are not sent", async () => {
    const client = await setup();
    await press("Düzenle: Claude");
    await press("Kaydet");
    expect(client.callsOf("tools.update")[0]).not.toHaveProperty("waitingPatterns");
    await press("Düzenle: Claude");
    fireEvent.change(patterns(), { target: { value: "Allow\\?\n\n  Proceed  " } });
    await press("Kaydet");
    expect(client.callsOf("tools.update")[1]).toMatchObject({ toolId: "claude", waitingPatterns: ["Allow\\?", "Proceed"] });
  });

  it("emptying the patterns sends null (back to the generic list)", async () => {
    const client = await setup();
    await press("Düzenle: Claude");
    fireEvent.change(patterns(), { target: { value: "  \n" } });
    await press("Kaydet");
    expect(client.callsOf("tools.update")[0]).toMatchObject({ waitingPatterns: null });
  });

  it("an invalid regex is shown on the field and nothing is sent", async () => {
    const client = await setup();
    await press("Düzenle: İkinci");
    fireEvent.change(patterns(), { target: { value: "[unclosed" } });
    await press("Kaydet");
    expect(within(form()).getByText("Satır 1: geçersiz düzenli ifade.")).toBeTruthy();
    expect(client.callsOf("tools.update")).toEqual([]);
  });

  it("create sends patterns only when given", async () => {
    const client = await setup();
    await press("Araç ekle");
    fireEvent.change(within(form()).getByLabelText("Ad"), { target: { value: "Aider" } });
    fireEvent.change(within(form()).getByLabelText("Komut"), { target: { value: "aider" } });
    await press("Kaydet");
    await press("Araç ekle");
    fireEvent.change(within(form()).getByLabelText("Ad"), { target: { value: "Aider 2" } });
    fireEvent.change(within(form()).getByLabelText("Komut"), { target: { value: "aider" } });
    fireEvent.change(patterns(), { target: { value: "\\(Y\\)es" } });
    await press("Kaydet");
    expect(client.callsOf("tools.create")).toEqual([
      { name: "Aider", command: "aider" },
      { name: "Aider 2", command: "aider", waitingPatterns: ["\\(Y\\)es"] },
    ]);
  });
});
