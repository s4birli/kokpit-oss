// Performans: a streamed surface (e.g. Tarayıcı) streams only while someone can see it.
import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStreamVisible } from "./stream-visibility.ts";

const GRACE_MS = 1000;

/** IntersectionObserver the test drives: `set(false)` = the element left the screen (hidden dock tab, other view). */
class FakeIO {
  static all: FakeIO[] = [];
  readonly targets: Element[] = [];
  private readonly cb: IntersectionObserverCallback;
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
    FakeIO.all.push(this);
  }
  observe(el: Element): void {
    this.targets.push(el);
  }
  disconnect(): void {
    this.targets.length = 0;
  }
  set(isIntersecting: boolean): void {
    this.cb(this.targets.map((target) => ({ target, isIntersecting }) as IntersectionObserverEntry), this as unknown as IntersectionObserver);
  }
}

let hidden = false;

function setVisibility(h: boolean): void {
  hidden = h;
  document.dispatchEvent(new Event("visibilitychange"));
}

function Probe({ active = true, log }: { active?: boolean; log: boolean[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const visible = useStreamVisible(ref, active, GRACE_MS);
  log.push(visible);
  return <div ref={ref} data-visible={String(visible)} />;
}

const last = (log: boolean[]) => log[log.length - 1];

beforeEach(() => {
  vi.useFakeTimers();
  FakeIO.all = [];
  hidden = false;
  vi.stubGlobal("IntersectionObserver", FakeIO);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => (hidden ? "hidden" : "visible"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useStreamVisible", () => {
  it("visible at once; hidden only after the grace (a quick tab flip does not stop the stream)", () => {
    const log: boolean[] = [];
    render(<Probe log={log} />);
    expect(last(log)).toBe(true);
    act(() => FakeIO.all[0]!.set(false));
    act(() => vi.advanceTimersByTime(GRACE_MS - 1));
    expect(last(log)).toBe(true);
    act(() => FakeIO.all[0]!.set(true));
    act(() => vi.advanceTimersByTime(GRACE_MS * 2));
    expect(last(log)).toBe(true);
    act(() => FakeIO.all[0]!.set(false));
    act(() => vi.advanceTimersByTime(GRACE_MS));
    expect(last(log)).toBe(false);
    act(() => FakeIO.all[0]!.set(true));
    expect(last(log)).toBe(true);
  });

  it("the window minimized / hidden (document hidden) counts as not visible, even with the panel in view", () => {
    const log: boolean[] = [];
    render(<Probe log={log} />);
    act(() => FakeIO.all[0]!.set(true));
    act(() => setVisibility(true));
    act(() => vi.advanceTimersByTime(GRACE_MS));
    expect(last(log)).toBe(false);
    act(() => setVisibility(false));
    expect(last(log)).toBe(true);
  });

  it("the main process says the window is hidden / minimized: not visible, even when the page still says visible", () => {
    let send: ((shown: boolean) => void) | undefined;
    const off = vi.fn();
    vi.stubGlobal("kokpit", {
      window: {
        onShownChanged: (l: (shown: boolean) => void) => {
          send = l;
          return off;
        },
      },
    });
    const log: boolean[] = [];
    const { unmount } = render(<Probe log={log} />);
    expect(last(log)).toBe(true);
    act(() => send!(false));
    act(() => vi.advanceTimersByTime(GRACE_MS));
    expect(last(log)).toBe(false);
    act(() => send!(true));
    expect(last(log)).toBe(true);
    unmount();
    expect(off).toHaveBeenCalled();
  });

  it("mounted in a hidden window: not visible from the start (no stream starts and stops)", () => {
    hidden = true;
    const log: boolean[] = [];
    render(<Probe log={log} />);
    expect(log.every((v) => v === false)).toBe(true);
  });

  it("without IntersectionObserver (old engine for tests) only the window's visibility counts", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const log: boolean[] = [];
    render(<Probe log={log} />);
    expect(last(log)).toBe(true);
    act(() => setVisibility(true));
    act(() => vi.advanceTimersByTime(GRACE_MS));
    expect(last(log)).toBe(false);
  });

  it("monkey: unmounting with a hide pending leaves no timer behind", () => {
    const log: boolean[] = [];
    const { unmount } = render(<Probe log={log} />);
    act(() => FakeIO.all[0]!.set(false));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
