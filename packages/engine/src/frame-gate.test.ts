// FrameGate.join: a late viewer is handed the newest frame right away (the rest of the gate is covered in browser.test.ts).
import { describe, expect, it } from "vitest";
import { FrameGate } from "./frame-gate.ts";

describe("FrameGate.join", () => {
  it("counts the handed frame as in flight", () => {
    const gate = new FrameGate(2);
    const a = {};
    expect(gate.join(a, 5)).toBe(false);
    expect(gate.inFlight(a)).toBe(1);
    expect(gate.onFrame(6)).toEqual({ deliverTo: [a], ackNow: false });
  });

  it("releases a held source ack when the joiner has room", () => {
    const gate = new FrameGate(2);
    const slow = {};
    gate.add(slow);
    gate.onFrame(1);
    expect(gate.onFrame(2).ackNow).toBe(false);
    expect(gate.pendingAck).toBe(true);
    const late = {};
    expect(gate.join(late, 2)).toBe(true);
    expect(gate.pendingAck).toBe(false);
    // The slow viewer skips the next frame, the joiner gets it.
    expect(gate.onFrame(3).deliverTo).toEqual([late]);
  });

  it("with a window of one, the handed frame fills the joiner: nothing is released", () => {
    const gate = new FrameGate(1);
    const slow = {};
    gate.add(slow);
    expect(gate.onFrame(1).ackNow).toBe(false);
    expect(gate.join({}, 1)).toBe(false);
    expect(gate.pendingAck).toBe(true);
  });

  it("joining twice does not reset what is in flight", () => {
    const gate = new FrameGate(3);
    const a = {};
    gate.join(a, 1);
    gate.onFrame(2);
    gate.join(a, 9);
    expect(gate.inFlight(a)).toBe(2);
  });
});
