// İş B: pure parts of the browser module (argv, profile paths, input mapping, frame backpressure).
import { describe, expect, it } from "vitest";
import { BrowserInputEventSchema, type BrowserInputEvent } from "@kokpit/shared";
import { chromeArgs, FrameGate, modifierBits, parseDevToolsActivePort, profileDir, toCdpInput } from "./browser.ts";

describe("chromeArgs", () => {
  const base = { profileDir: "/data/browser-profiles/p", port: 9333, headless: false, testMode: false, windowWidth: 1280, windowHeight: 800 };

  it("test mode never touches the macOS keychain (no system dialog); production uses the real one", () => {
    const test = chromeArgs({ ...base, testMode: true });
    expect(test).toContain("--use-mock-keychain");
    expect(test).toContain("--password-store=basic");
    // Headless (test-only) implies the mock keychain even if testMode was forgotten.
    const headless = chromeArgs({ ...base, headless: true });
    expect(headless).toContain("--use-mock-keychain");
    expect(headless).toContain("--password-store=basic");
    const prod = chromeArgs(base);
    expect(prod).not.toContain("--use-mock-keychain");
    expect(prod.some((a) => a.startsWith("--password-store"))).toBe(false);
  });

  it("pins the profile, binds DevTools to loopback on the given port and skips first-run UI", () => {
    const args = chromeArgs(base);
    expect(args).toContain("--user-data-dir=/data/browser-profiles/p");
    expect(args).toContain("--remote-debugging-address=127.0.0.1");
    expect(args).toContain("--remote-debugging-port=9333");
    expect(args).toContain("--no-first-run");
    expect(args).toContain("--no-default-browser-check");
    expect(args).toContain("--window-size=1280,800");
    expect(args.some((a) => a.startsWith("--headless"))).toBe(false);
    expect(args.at(-1)).toBe("about:blank");
  });

  it("is headless only when asked (tests)", () => {
    expect(chromeArgs({ ...base, headless: true })).toContain("--headless=new");
  });

  it("hidden window: Chrome's headless mode (no window, no Dock icon, never in front) with the REAL keychain", () => {
    const ua = "Mozilla/5.0 (Macintosh) Chrome/157.0.0.0 Safari/537.36";
    const hidden = chromeArgs({ ...base, window: "hidden", userAgent: ua });
    expect(hidden).toContain("--headless=new");
    // The profile's cookies, saved passwords and sign-in are encrypted with the keychain key: a hidden production
    // browser must keep using it, or every login of the profile would be lost.
    expect(hidden).not.toContain("--use-mock-keychain");
    expect(hidden.some((a) => a.startsWith("--password-store"))).toBe(false);
    // Headless Chrome says "HeadlessChrome" in its User-Agent; the hidden browser presents the normal one.
    expect(hidden).toContain(`--user-agent=${ua}`);
    expect(hidden.filter((a) => a.startsWith("--headless"))).toHaveLength(1);
    // The window size is still the page's size when no panel reported one; the anti-throttling flags stay.
    expect(hidden).toContain("--window-size=1280,800");
    expect(hidden).toContain("--disable-renderer-backgrounding");
    expect(chromeArgs({ ...base, window: "hidden" }).some((a) => a.startsWith("--user-agent"))).toBe(false);
  });

  it("visible window: a real Chrome window, Chrome's own User-Agent", () => {
    const visible = chromeArgs({ ...base, window: "visible", userAgent: "x" });
    expect(visible.some((a) => a.startsWith("--headless"))).toBe(false);
    expect(visible.some((a) => a.startsWith("--user-agent"))).toBe(false);
  });

  it("test headless stays headless with the mock keychain whatever the project's window", () => {
    for (const window of ["hidden", "visible"] as const) {
      const args = chromeArgs({ ...base, headless: true, window });
      expect(args.filter((a) => a.startsWith("--headless"))).toEqual(["--headless=new"]);
      expect(args).toContain("--use-mock-keychain");
    }
  });

  it("never binds DevTools beyond loopback and has exactly one debugging address/port", () => {
    const args = chromeArgs(base);
    expect(args.filter((a) => a.startsWith("--remote-debugging-address"))).toEqual(["--remote-debugging-address=127.0.0.1"]);
    expect(args.filter((a) => a.startsWith("--remote-debugging-port"))).toHaveLength(1);
    expect(args.join(" ")).not.toMatch(/0\.0\.0\.0|remote-allow-origins=\*/);
  });

  it("rejects ports outside 1..65535 and relative profile dirs", () => {
    expect(() => chromeArgs({ ...base, port: 0 })).toThrow();
    expect(() => chromeArgs({ ...base, port: 70000 })).toThrow();
    expect(() => chromeArgs({ ...base, profileDir: "rel/p" })).toThrow();
  });
});

describe("profileDir", () => {
  it("is <root>/<projectId>", () => {
    expect(profileDir("/data/browser-profiles", "Acme")).toBe("/data/browser-profiles/Acme");
    expect(profileDir("/data/browser-profiles", "a.b_c-1")).toBe("/data/browser-profiles/a.b_c-1");
  });

  it.each(["", ".", "..", "../x", "a/b", "/abs", "a\\b", "x\0y", ".hidden", "-flag", "a b", "ş"])(
    "refuses unsafe project id %j",
    (id) => {
      expect(() => profileDir("/data/browser-profiles", id)).toThrow();
    },
  );

  it("monkey: whatever comes out stays directly inside the root", () => {
    const chars = "ab./\\-_ \0..~$`'\"";
    let seed = 7;
    const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
    for (let i = 0; i < 500; i++) {
      let id = "";
      for (let j = 0, n = 1 + rnd(8); j < n; j++) id += chars[rnd(chars.length)];
      try {
        const dir = profileDir("/root/profiles", id);
        expect(dir.startsWith("/root/profiles/")).toBe(true);
        expect(dir.slice("/root/profiles/".length)).not.toMatch(/[/\\]|^\.\.?$/);
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
      }
    }
  });
});

describe("parseDevToolsActivePort", () => {
  it("reads the port from the first line", () => {
    expect(parseDevToolsActivePort("9333\n/devtools/browser/abc\n")).toBe(9333);
  });
  it.each(["", "abc\n", "0\n", "70000\n", "12.5\n", "-1"])("rejects %j", (s) => {
    expect(parseDevToolsActivePort(s)).toBeNull();
  });
});

describe("toCdpInput", () => {
  const parse = (e: unknown) => BrowserInputEventSchema.parse(e) as BrowserInputEvent;

  it("modifiers map to the CDP bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8)", () => {
    expect(modifierBits(undefined)).toBe(0);
    expect(modifierBits({ alt: true })).toBe(1);
    expect(modifierBits({ ctrl: true, shift: true })).toBe(10);
    expect(modifierBits({ alt: true, ctrl: true, meta: true, shift: true })).toBe(15);
  });

  it("mouse down/up/move", () => {
    expect(toCdpInput(parse({ type: "mouse", action: "down", x: 10.5, y: 20, button: "left", clickCount: 1 }))).toEqual([
      { method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 10.5, y: 20, button: "left", clickCount: 1, modifiers: 0 } },
    ]);
    expect(toCdpInput(parse({ type: "mouse", action: "up", x: 1, y: 2, button: "right", clickCount: 1, modifiers: { shift: true } }))[0]).toEqual({
      method: "Input.dispatchMouseEvent",
      params: { type: "mouseReleased", x: 1, y: 2, button: "right", clickCount: 1, modifiers: 8 },
    });
    expect(toCdpInput(parse({ type: "mouse", action: "move", x: 3, y: 4 }))[0]!.params).toMatchObject({
      type: "mouseMoved",
      button: "none",
      clickCount: 0,
    });
  });

  it("wheel", () => {
    expect(toCdpInput(parse({ type: "wheel", x: 5, y: 6, deltaX: 0, deltaY: 120 }))).toEqual([
      { method: "Input.dispatchMouseEvent", params: { type: "mouseWheel", x: 5, y: 6, deltaX: 0, deltaY: 120, modifiers: 0 } },
    ]);
  });

  it("printable key down carries text; with ctrl/meta it does not (shortcut)", () => {
    const [down] = toCdpInput(parse({ type: "key", action: "down", key: "a", code: "KeyA", keyCode: 65 }));
    expect(down).toEqual({
      method: "Input.dispatchKeyEvent",
      params: { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 0, text: "a", unmodifiedText: "a" },
    });
    const [cmd] = toCdpInput(parse({ type: "key", action: "down", key: "a", code: "KeyA", keyCode: 65, modifiers: { meta: true } }));
    expect(cmd!.params).toMatchObject({ type: "rawKeyDown", modifiers: 4 });
    expect(cmd!.params).not.toHaveProperty("text");
  });

  it("Enter sends \\r as text (forms submit); arrows and Backspace are raw key downs", () => {
    expect(toCdpInput(parse({ type: "key", action: "down", key: "Enter", code: "Enter", keyCode: 13 }))[0]!.params).toMatchObject({
      type: "keyDown",
      text: "\r",
    });
    for (const [key, keyCode] of [["ArrowLeft", 37], ["Backspace", 8], ["Tab", 9]] as const) {
      const p = toCdpInput(parse({ type: "key", action: "down", key, code: key, keyCode }))[0]!.params;
      expect(p).toMatchObject({ type: "rawKeyDown", key, windowsVirtualKeyCode: keyCode });
      expect(p).not.toHaveProperty("text");
    }
  });

  it("key up and char", () => {
    expect(toCdpInput(parse({ type: "key", action: "up", key: "a", code: "KeyA", keyCode: 65 }))[0]!.params).toMatchObject({ type: "keyUp" });
    expect(toCdpInput(parse({ type: "key", action: "char", key: "ş", code: "" }))[0]!.params).toMatchObject({ type: "char", text: "ş" });
  });

  it("text inserts without key events", () => {
    expect(toCdpInput(parse({ type: "text", text: "merhaba" }))).toEqual([{ method: "Input.insertText", params: { text: "merhaba" } }]);
  });
});

describe("FrameGate (per-client in-flight window)", () => {
  const A = { name: "A" };
  const B = { name: "B" };

  it("acks Chrome at once while every client has room", () => {
    const g = new FrameGate(2);
    g.add(A);
    expect(g.onFrame(1)).toEqual({ deliverTo: [A], ackNow: true });
    expect(g.onFrame(2)).toEqual({ deliverTo: [A], ackNow: false });
    // Window full: Chrome is not acked, so it stops producing frames.
    expect(g.pendingAck).toBe(true);
    // The client's ack frees room and releases the held Chrome ack exactly once.
    expect(g.onAck(A, 1)).toEqual({ ackChrome: true, resend: undefined });
    expect(g.pendingAck).toBe(false);
    expect(g.onAck(A, 2)).toEqual({ ackChrome: false, resend: undefined });
  });

  it("a frame skipped for a full client is resent once its ack makes room (the page may go idle)", () => {
    // Chrome may send another frame before the held ack (e.g. while a second CDP client attaches); if that
    // frame is the last one before the page goes idle, dropping it leaves the viewer on a stale picture.
    const g = new FrameGate(2);
    g.add(A);
    g.onFrame(3);
    g.onFrame(4);
    expect(g.onFrame(5)).toEqual({ deliverTo: [], ackNow: false });
    expect(g.onAck(A, 4)).toEqual({ ackChrome: true, resend: 5 });
    expect(g.inFlight(A)).toBe(1);
    // Resent once only.
    expect(g.onAck(A, 4)).toEqual({ ackChrome: false, resend: undefined });
    expect(g.onAck(A, 5)).toEqual({ ackChrome: false, resend: undefined });
  });

  it("only the newest skipped frame is resent, and only to the client that skipped it", () => {
    const g = new FrameGate(1);
    g.add(A);
    g.add(B);
    g.onFrame(1);
    g.onAck(A, 1);
    expect(g.onFrame(2)).toEqual({ deliverTo: [A], ackNow: false });
    g.onAck(A, 2);
    expect(g.onFrame(3)).toEqual({ deliverTo: [A], ackNow: false });
    expect(g.onAck(B, 1)).toEqual({ ackChrome: false, resend: 3 });
    expect(g.onAck(A, 3).resend).toBeUndefined();
  });

  it("reset and remove forget skipped frames", () => {
    const g = new FrameGate(1);
    g.add(A);
    g.onFrame(1);
    g.onFrame(2);
    g.reset();
    expect(g.onAck(A, 1).resend).toBeUndefined();
    g.onFrame(3);
    g.onFrame(4);
    g.remove(A);
    g.add(A);
    expect(g.onAck(A, 3).resend).toBeUndefined();
  });

  it("acks Chrome when no client is subscribed (nothing to wait for)", () => {
    const g = new FrameGate(2);
    expect(g.onFrame(1)).toEqual({ deliverTo: [], ackNow: true });
  });

  it("a slow client skips frames but never blocks a fast one", () => {
    const g = new FrameGate(1);
    g.add(A);
    g.add(B);
    expect(g.onFrame(1)).toEqual({ deliverTo: [A, B], ackNow: false });
    expect(g.onAck(A, 1).ackChrome).toBe(true);
    // B still has frame 1 in flight: frame 2 goes to A only.
    expect(g.onFrame(2)).toEqual({ deliverTo: [A], ackNow: false });
    expect(g.onAck(A, 2).ackChrome).toBe(true);
  });

  it("an ack covers every earlier frame; unknown/old acks are harmless", () => {
    const g = new FrameGate(3);
    g.add(A);
    g.onFrame(1);
    g.onFrame(2);
    g.onFrame(3);
    expect(g.inFlight(A)).toBe(3);
    g.onAck(A, 2);
    expect(g.inFlight(A)).toBe(1);
    g.onAck(A, 1);
    g.onAck(A, 999);
    expect(g.inFlight(A)).toBe(0);
    expect(g.onAck({ name: "stranger" }, 1)).toEqual({ ackChrome: false, resend: undefined });
  });

  it("removing the last blocking client releases the held Chrome ack", () => {
    const g = new FrameGate(1);
    g.add(A);
    g.onFrame(1);
    expect(g.pendingAck).toBe(true);
    expect(g.remove(A)).toBe(true);
    expect(g.pendingAck).toBe(false);
    expect(g.size).toBe(0);
  });

  it("reset forgets in-flight frames (tab switch / restart)", () => {
    const g = new FrameGate(1);
    g.add(A);
    g.onFrame(1);
    g.reset();
    expect(g.pendingAck).toBe(false);
    expect(g.onFrame(2)).toEqual({ deliverTo: [A], ackNow: false });
  });

  it("monkey: in-flight never exceeds the window and Chrome is never acked twice for one frame", () => {
    const g = new FrameGate(2);
    const clients = [A, B, { name: "C" }];
    let seed = 3;
    const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
    let frame = 0;
    let unacked = 0; // Chrome frames not yet acked (0 or 1: Chrome waits for the ack)
    const sent = new Map<object, number[]>();
    const newest = new Map<object, number>(); // newest frame each client has been sent
    const joined = new Map<object, number>(); // last frame before the client (re)joined
    for (const c of clients) {
      g.add(c);
      sent.set(c, []);
      joined.set(c, 0);
    }
    for (let i = 0; i < 2000; i++) {
      const op = rnd(4);
      const c = clients[rnd(clients.length)]!;
      if (op === 0 && unacked === 0) {
        frame++;
        const r = g.onFrame(frame);
        for (const d of r.deliverTo) {
          sent.get(d)!.push(frame);
          newest.set(d, frame);
        }
        if (!r.ackNow) unacked = 1;
      } else if (op === 1 && sent.get(c)!.length > 0) {
        const list = sent.get(c)!;
        const id = list[rnd(list.length)]!;
        sent.set(c, list.filter((f) => f > id));
        const r = g.onAck(c, id);
        if (r.resend !== undefined) {
          expect(r.resend).toBe(frame);
          sent.get(c)!.push(r.resend);
          newest.set(c, r.resend);
        }
        if (r.ackChrome) {
          expect(unacked).toBe(1);
          unacked = 0;
        }
      } else if (op === 2 && !g.has(c)) {
        g.add(c);
        sent.set(c, []);
        joined.set(c, frame);
      } else if (op === 3 && rnd(10) === 0) {
        if (g.remove(c)) {
          expect(unacked).toBe(1);
          unacked = 0;
        }
        sent.set(c, []);
      }
      for (const x of clients) {
        if (!g.has(x)) continue;
        expect(g.inFlight(x)).toBeLessThanOrEqual(2);
        // A client with room is never left behind the newest frame produced since it joined.
        if (g.inFlight(x) < 2 && frame > joined.get(x)!) expect(newest.get(x)).toBe(frame);
      }
    }
  });
});
