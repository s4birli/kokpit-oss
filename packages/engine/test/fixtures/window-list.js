// Test helper — osascript -l JavaScript window-list.js <pid>: the windows of one process as the window server lists
// them (bounds, on screen, layer — never titles or content), its app's activation policy (0 regular, 1 accessory,
// 2 prohibited = no Dock icon / menu bar), and the frontmost app's pid. JXA, because Swift scripts do not build
// with this Mac's command line tools.
ObjC.import("CoreGraphics");
ObjC.import("AppKit");
function run(argv) {
  const pid = Number(argv[0]);
  const raw = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, $.kCGNullWindowID);
  const list = ObjC.deepUnwrap(ObjC.castRefToObject(raw)) || [];
  const windows = list
    .filter((w) => w.kCGWindowOwnerPID === pid)
    .map((w) => ({
      x: w.kCGWindowBounds.X,
      y: w.kCGWindowBounds.Y,
      w: w.kCGWindowBounds.Width,
      h: w.kCGWindowBounds.Height,
      onscreen: !!w.kCGWindowIsOnscreen,
      layer: w.kCGWindowLayer,
    }));
  const a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  const app = a.isNil() ? null : { policy: Number(a.activationPolicy), hidden: !!a.isHidden, active: !!a.isActive };
  const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  return JSON.stringify({ windows, app, frontPid: front.isNil() ? -1 : Number(front.processIdentifier) });
}
