// A native view (a WebContentsView main lays over a panel's rectangle): where it is, and its life cycle. Shared by
// every panel whose content is drawn by Electron main rather than the renderer.

/** In CSS pixels of the app window (= Electron DIPs at zoom 1). */
export interface SurfaceBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** connecting → ready | failed; closed after the user disconnects (the partition, and so the login, stays). */
export type SurfaceStatus = "connecting" | "ready" | "failed" | "closed";
