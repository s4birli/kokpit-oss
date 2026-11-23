// Girişler: calls one function in an ISOLATED WORLD of a tab's main frame over CDP.
//
// An isolated world (the mechanism extension content scripts use) sees the page's DOM but has its own JavaScript
// globals: the page's scripts cannot redefine what the function calls and cannot read its arguments off a
// prototype they patched. The world is created for the frame's CURRENT document; a navigation destroys it, so a
// call that raced a navigation fails ("Cannot find context…") instead of running in another page.
//
// Arguments travel as CDP call arguments (`Runtime.callFunctionOn` → `arguments`), never as script text, and the
// answer comes back by value. A failure is reported without Chrome's or the page's own message: either could quote
// an argument.
import { engineError } from "./contracts.ts";

/** One CDP command on the tab's session. */
export type CdpSend = <T = Record<string, unknown>>(method: string, params?: Record<string, unknown>) => Promise<T>;

export interface IsolatedCall {
  /** Name of the world (shown in DevTools' context picker). */
  worldName: string;
  /** Source of ONE function; called with `args`. Static text — nothing from a request is ever written into it. */
  functionDeclaration: string;
  /** JSON-serializable arguments. */
  args: readonly unknown[];
}


/** The function's return value (by value; untrusted). INVALID when the page is gone, navigating, or the call threw. */
export async function callInIsolatedWorld(send: CdpSend, call: IsolatedCall): Promise<unknown> {
  try {
    const tree = await send<{ frameTree?: { frame?: { id?: unknown } } }>("Page.getFrameTree");
    const frameId = tree.frameTree?.frame?.id;
    if (typeof frameId !== "string") throw new Error("no main frame");
    const world = await send<{ executionContextId?: unknown }>("Page.createIsolatedWorld", { frameId, worldName: call.worldName });
    if (typeof world.executionContextId !== "number") throw new Error("no isolated world");
    const r = await send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>("Runtime.callFunctionOn", {
      functionDeclaration: call.functionDeclaration,
      executionContextId: world.executionContextId,
      arguments: call.args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: false,
      userGesture: true,
    });
    if (r.exceptionDetails !== undefined) throw new Error("page exception");
    return r.result?.value;
  } catch {
    throw engineError("INVALID", "engine.browserIsolated.failed");
  }
}
