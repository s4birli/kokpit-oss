// Bağlantılar: a link from a terminal always lands in a new tab of the project's Chrome. In a Chrome this very
// request started, the single blank tab — nobody's yet — is closed afterwards instead of being left behind.
import type { BrowserTab } from "@kokpit/shared";
import { describe, expect, it } from "vitest";
import { linkOrigin, openUrlPlan } from "./browser.ts";

const tab = (id: string, url: string): BrowserTab => ({ id, title: "", url });
const BLANK = "about:blank";

describe("openUrlPlan", () => {
  it("a Chrome started for this link has its one blank tab replaced", () => {
    expect(openUrlPlan({ started: true, tabs: [tab("A", BLANK)], activeTabId: "A" })).toEqual({ kind: "replace", tabId: "A" });
  });

  it("a Chrome that was already running keeps every tab — even when it shows only a blank one", () => {
    // An agent may have just opened that blank tab and be about to use it.
    expect(openUrlPlan({ started: false, tabs: [tab("A", BLANK)], activeTabId: "A" })).toEqual({ kind: "new" });
    expect(openUrlPlan({ started: false, tabs: [tab("A", "https://ornek.test/")], activeTabId: "A" })).toEqual({ kind: "new" });
  });

  it("a started Chrome that restored tabs, or whose only tab is not blank or not active, keeps every tab", () => {
    expect(openUrlPlan({ started: true, tabs: [tab("A", BLANK), tab("B", BLANK)], activeTabId: "A" })).toEqual({ kind: "new" });
    expect(openUrlPlan({ started: true, tabs: [tab("A", "https://ornek.test/")], activeTabId: "A" })).toEqual({ kind: "new" });
    expect(openUrlPlan({ started: true, tabs: [tab("A", BLANK)], activeTabId: undefined })).toEqual({ kind: "new" });
    expect(openUrlPlan({ started: true, tabs: [tab("A", BLANK)], activeTabId: "B" })).toEqual({ kind: "new" });
    expect(openUrlPlan({ started: true, tabs: [], activeTabId: undefined })).toEqual({ kind: "new" });
  });
});

describe("linkOrigin (what the log may say about an opened link)", () => {
  it("is the scheme, host and port — never the path, the query or the fragment", () => {
    expect(linkOrigin("https://ornek.test:8443/gizli/yol?token=abc#parca")).toBe("https://ornek.test:8443");
    expect(linkOrigin("http://localhost:3000/a?b=1")).toBe("http://localhost:3000");
  });

  it("says nothing for something that is not an address", () => {
    expect(linkOrigin("değil")).toBe("");
    expect(linkOrigin("")).toBe("");
  });
});
