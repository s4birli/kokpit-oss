// Kendini güncelleme: the file system WITHOUT Electron's asar layer.
//
// In Electron's main process `fs` treats every path that runs through a `*.asar` file as an archive to look into:
// opening `…/Contents/Resources/app.asar` for writing fails ("Invalid package"), `lstat` may describe the archive's
// inside, a recursive `rm` may descend into it. The updater handles app bundles as plain files — writing, comparing
// and deleting them — so it uses Electron's `original-fs` (the unpatched Node module). Outside Electron (tests, the
// engine) that is simply `node:fs`.
import * as nodeFs from "node:fs";
import { createRequire } from "node:module";

type Fs = typeof nodeFs;

const inElectron = typeof process.versions.electron === "string";

export const rawFs: Fs = inElectron ? (createRequire(import.meta.url)("original-fs") as Fs) : nodeFs;
export const rawFsp: Fs["promises"] = rawFs.promises;
