import { afterEach, describe, expect, it, vi } from "vitest";
import { clipboardConfig } from "../engine/clipboard-ipc.ts";
import { COPY_ATTR, copyValue, installCopyMenu } from "./copy-menu.ts";

const offs: (() => void)[] = [];
function install(maxChars = clipboardConfig.copyValueMaxChars) {
  const copyMenu = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
  offs.push(installCopyMenu(document, { copyMenu }, { ...clipboardConfig, copyValueMaxChars: maxChars }));
  return copyMenu;
}
function rightClick(el: Element): MouseEvent {
  const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
  el.dispatchEvent(e);
  return e;
}
function html(markup: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = markup;
  document.body.append(host);
  return host;
}

afterEach(() => {
  for (const off of offs.splice(0)) off();
  document.body.replaceChildren();
  getSelection()?.removeAllRanges();
});

describe("copyValue", () => {
  it("is the attribute a row carries; nothing for an empty value", () => {
    expect(copyValue("src/a.ts")).toEqual({ [COPY_ATTR]: "src/a.ts" });
    expect(copyValue("")).toEqual({});
    expect(copyValue(undefined)).toEqual({});
  });
});

describe("installCopyMenu", () => {
  it("right click on a row (or anything inside it) asks main for the Kopyala menu with the row's value", () => {
    const copyMenu = install();
    const host = html(`<button ${COPY_ATTR}="src/lib/util.ts"><span id="name">util.ts</span></button>`);
    const e = rightClick(host.querySelector("#name")!);
    expect(copyMenu).toHaveBeenCalledExactlyOnceWith("src/lib/util.ts");
    expect(e.defaultPrevented).toBe(true);
  });

  it("the nearest value wins", () => {
    const copyMenu = install();
    const host = html(`<ul ${COPY_ATTR}="outer"><li ${COPY_ATTR}="inner"><span id="x">x</span></li></ul>`);
    rightClick(host.querySelector("#x")!);
    expect(copyMenu).toHaveBeenCalledExactlyOnceWith("inner");
  });

  it("leaves places without a value alone", () => {
    const copyMenu = install();
    const host = html(`<p id="p">metin</p>`);
    expect(rightClick(host.querySelector("#p")!).defaultPrevented).toBe(false);
    expect(copyMenu).not.toHaveBeenCalled();
  });

  it("selected text keeps the native menu (Kopyala copies the selection)", () => {
    const copyMenu = install();
    const host = html(`<li ${COPY_ATTR}="deger"><span id="t">seçili metin</span></li>`);
    const range = document.createRange();
    range.selectNodeContents(host.querySelector("#t")!);
    getSelection()!.addRange(range);
    expect(rightClick(host.querySelector("#t")!).defaultPrevented).toBe(false);
    expect(copyMenu).not.toHaveBeenCalled();
  });

  it("inputs inside a row keep their own menu", () => {
    const copyMenu = install();
    const host = html(`<li ${COPY_ATTR}="deger"><input id="i"><textarea id="t"></textarea><div id="c" contenteditable="true">x</div></li>`);
    for (const id of ["i", "t", "c"]) expect(rightClick(host.querySelector(`#${id}`)!).defaultPrevented).toBe(false);
    expect(copyMenu).not.toHaveBeenCalled();
  });

  it("ignores empty and oversized values", () => {
    const copyMenu = install(5);
    const host = html(`<b id="a" ${COPY_ATTR}="">a</b><b id="b" ${COPY_ATTR}="123456">b</b><b id="c" ${COPY_ATTR}="12345">c</b>`);
    rightClick(host.querySelector("#a")!);
    rightClick(host.querySelector("#b")!);
    expect(copyMenu).not.toHaveBeenCalled();
    rightClick(host.querySelector("#c")!);
    expect(copyMenu).toHaveBeenCalledExactlyOnceWith("12345");
  });

  it("a failing bridge does not throw; without a bridge nothing is installed", () => {
    const copyMenu = install();
    copyMenu.mockRejectedValueOnce(new Error("no"));
    const host = html(`<b id="a" ${COPY_ATTR}="x">a</b>`);
    expect(() => rightClick(host.querySelector("#a")!)).not.toThrow();
    const off = installCopyMenu(document, undefined);
    off();
  });

  it("the returned function removes the listener", () => {
    const copyMenu = install();
    offs.splice(0).forEach((off) => off());
    const host = html(`<b id="a" ${COPY_ATTR}="x">a</b>`);
    rightClick(host.querySelector("#a")!);
    expect(copyMenu).not.toHaveBeenCalled();
  });
});
