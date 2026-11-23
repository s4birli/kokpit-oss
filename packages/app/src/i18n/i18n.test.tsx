import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogProblems, getLocale, leafAt, leafKeys, setLocale } from "@kokpit/shared/i18n";
import { appEn, appTr } from "./catalog.ts";
import { formatDateTime, formatNumber, installLanguageBridge, intlLocale, setLanguage, t, translateErrorText, useLocale, useT } from "./index.ts";

afterEach(() => {
  installLanguageBridge(undefined);
  setLocale("tr");
});

describe("app catalogs", () => {
  it("tr has exactly the keys and placeholders of en", () => {
    expect(catalogProblems(appEn, appTr)).toEqual([]);
  });

  it("no text is empty, and every English text is free of Turkish-only letters", () => {
    for (const k of leafKeys(appEn)) {
      expect(leafAt(appEn, k), k).not.toBe("");
      expect(leafAt(appTr, k), k).not.toBe("");
      expect(leafAt(appEn, k), k).not.toMatch(/[çğıöşüÇĞİÖŞÜ]/);
    }
  });
});

describe("typed keys (enforced by `tsc`)", () => {
  it("an unknown key does not typecheck, and shows itself at runtime", () => {
    // @ts-expect-error — not a catalog key
    expect(t("no.such.key")).toBe("no.such.key");
  });

  it("a Turkish catalog missing an English key does not typecheck", () => {
    // @ts-expect-error — `common.language.name` missing
    const broken: typeof appEn = { ...appTr, common: { language: {} } };
    expect(broken).toBeDefined();
  });
});

describe("t", () => {
  it("follows the process locale", () => {
    setLocale("en");
    expect(t("common.language.name")).toBe("English");
    setLocale("tr");
    expect(t("common.language.name")).toBe("Türkçe");
  });

  it("translates an engine error's key when known, else keeps its message", () => {
    setLocale("en");
    expect(translateErrorText({ key: "common.language.name", message: "eski" })).toBe("English");
    expect(translateErrorText({ key: "engine.does.not.exist", message: "eski metin" })).toBe("eski metin");
    expect(translateErrorText({ message: "yalnız mesaj" })).toBe("yalnız mesaj");
    // A key that names a branch, not a text, is no text.
    expect(translateErrorText({ key: "common", message: "m" })).toBe("m");
  });
});

describe("formatting follows the locale", () => {
  it("numbers and dates", () => {
    setLocale("tr");
    expect(intlLocale()).toMatch(/^tr/);
    expect(formatNumber(1234.5)).toBe("1.234,5");
    setLocale("en");
    expect(formatNumber(1234.5)).toBe("1,234.5");
    const d = new Date(2026, 0, 2, 3, 4);
    expect(formatDateTime(d, { month: "long" })).toBe("January");
    setLocale("tr");
    expect(formatDateTime(d, { month: "long" })).toBe("Ocak");
  });
});

function Probe() {
  const tr = useT();
  const locale = useLocale();
  return (
    <p>
      {locale}:{tr("common.language.name")}
    </p>
  );
}

describe("switching at runtime", () => {
  it("re-renders components that use useT", () => {
    setLocale("tr");
    render(<Probe />);
    expect(screen.getByText("tr:Türkçe")).toBeTruthy();
    act(() => setLocale("en"));
    expect(screen.getByText("en:English")).toBeTruthy();
  });

  it("setLanguage applies at once and asks main to store it", async () => {
    const set = vi.fn(async () => {});
    installLanguageBridge({ initial: "tr", set, onChanged: () => () => {} });
    await setLanguage("en");
    expect(getLocale()).toBe("en");
    expect(set).toHaveBeenCalledWith("en");
  });

  it("a change announced by main (another window, the menu) applies here", () => {
    let announce: (l: "en" | "tr") => void = () => {};
    installLanguageBridge({ initial: "en", set: async () => {}, onChanged: (l) => ((announce = l), () => {}) });
    expect(getLocale()).toBe("en");
    announce("tr");
    expect(getLocale()).toBe("tr");
  });

  it("refuses an unsupported language without touching the current one", async () => {
    setLocale("tr");
    await expect(setLanguage("xx" as never)).rejects.toThrow();
    expect(getLocale()).toBe("tr");
  });
});
