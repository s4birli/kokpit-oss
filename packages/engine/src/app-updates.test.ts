// Kendini güncelleme — publishing on disk: packed into Kokpit's own format, atomic, pruned, never half-written.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { makeBuildId, type BuildInfo, type BundleEntry } from "@kokpit/shared";
import { packBundle } from "@kokpit/shared/bundle-pack";
import { ensureSigningKey, entriesSha256, verifyManifest } from "@kokpit/shared/update-signing";
import {
  appUpdatesDir,
  bundleLimits,
  createAppUpdateService,
  listPublishedBuilds,
  loadAppUpdatesConfig,
  publishAppBuild,
  readCurrentBuild,
  readPublishedBuild,
} from "./app-updates.ts";
import { newestBundle, readBundleIdentity, realDeps, resolveTarget, runCli, type PublishDeps } from "../scripts/publish-app.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-updates-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const cfg = loadAppUpdatesConfig({ keep: 2 });
const id = (minute: number) => makeBuildId("0.1.0", "abc1234", new Date(Date.UTC(2026, 10, 18, 10, minute, 0)));
const at = (minute: number) => new Date(Date.UTC(2026, 10, 18, 12, minute, 0));
const engineBuild: BuildInfo = { buildId: id(30), version: "0.1.0", commit: "abc1234", builtAt: "2026-11-18T10:30:00.000Z" };
const logger = { debug() {}, info() {}, warn() {}, error() {} };
/** The publisher key, in a temp folder (never the real ~/.config/kokpit). */
const SIGNING_DIR = join(root, "signing");
const KEY = ensureSigningKey(SIGNING_DIR);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

let dir: string;
let n = 0;
/** A bundle folder: a plist, an executable, a data file marked with `mark`, and a framework-style link. */
function bundle(mark: string, plist: Record<string, string> = {}, name = "Kokpit.app"): string {
  const app = join(root, `src-${n++}`, name);
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(app, "Contents", "Resources"));
  const body = Object.entries(plist).map(([k, v]) => `<key>${k}</key><string>${v}</string>`).join("");
  writeFileSync(join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${body}</dict></plist>`);
  writeFileSync(join(app, "Contents", "MacOS", "Kokpit"), "#!/bin/sh\n");
  chmodSync(join(app, "Contents", "MacOS", "Kokpit"), 0o755);
  writeFileSync(join(app, "Contents", "Resources", "data.txt"), mark);
  symlinkSync("Resources/data.txt", join(app, "Contents", "alias"));
  return app;
}
beforeEach(() => {
  dir = join(root, `pub-${n++}`);
});

describe("packBundle", () => {
  it("lists every folder, file and link in a fixed order (parents first) and writes the files' bytes, in that order, gzip-compressed", async () => {
    const app = bundle("VERİ");
    const blobPath = join(root, `blob-${n++}`);
    const packed = await packBundle(app, blobPath, bundleLimits(cfg));
    expect(packed.entries.map((e) => `${e.type} ${e.path}`)).toEqual([
      "dir Contents",
      "file Contents/Info.plist",
      "dir Contents/MacOS",
      "file Contents/MacOS/Kokpit",
      "dir Contents/Resources",
      "file Contents/Resources/data.txt",
      "symlink Contents/alias",
    ]);
    const files = packed.entries.filter((e): e is Extract<BundleEntry, { type: "file" }> => e.type === "file");
    expect(files.map((f) => f.mode)).toEqual([0o644, 0o755, 0o644]);
    expect(files[2]).toMatchObject({ size: Buffer.byteLength("VERİ"), sha256: sha("VERİ") });
    expect(packed.entries.at(-1)).toEqual({ path: "Contents/alias", type: "symlink", target: "Resources/data.txt" });
    const content = gunzipSync(readFileSync(blobPath));
    expect(content.length).toBe(packed.unpackedSize);
    expect(content.subarray(content.length - Buffer.byteLength("VERİ")).toString()).toBe("VERİ");
    expect(packed.blob).toEqual({ size: readFileSync(blobPath).length, sha256: createHash("sha256").update(readFileSync(blobPath)).digest("hex") });
    // The same bundle packs to the same list (the order does not depend on the disk).
    expect((await packBundle(app, join(root, `blob-${n++}`), bundleLimits(cfg))).entries).toEqual(packed.entries);
  });

  it("refuses a bundle the apps would refuse: a name outside the plain alphabet, a link out of the bundle, a file over the cap", async () => {
    const odd = bundle("x");
    writeFileSync(join(odd, "Contents", "Resources", "İçerik.txt"), "x");
    await expect(packBundle(odd, join(root, `blob-${n++}`), bundleLimits(cfg))).rejects.toThrow("yol");
    const escaping = bundle("x");
    symlinkSync("../../../outside", join(escaping, "Contents", "out"));
    await expect(packBundle(escaping, join(root, `blob-${n++}`), bundleLimits(cfg))).rejects.toThrow("bağlantı");
    await expect(packBundle(bundle("12345"), join(root, `blob-${n++}`), { ...bundleLimits(cfg), maxFileBytes: 4 })).rejects.toThrow("dosya çok büyük");
  });
});

describe("publishAppBuild", () => {
  it("writes <buildId>/{blob,entries,manifest}, points current at it, and the manifest describes what was written", async () => {
    const { manifest } = await publishAppBuild(cfg, dir, { signingKey: KEY, appPath: bundle("A"), buildId: id(1), version: "0.1.0", now: at(1) });
    const blob = readFileSync(join(dir, id(1), cfg.blobFileName));
    expect(manifest).toEqual({
      buildId: id(1),
      version: "0.1.0",
      format: 1,
      bundleName: "Kokpit.app",
      sha256: createHash("sha256").update(blob).digest("hex"),
      size: blob.length,
      unpackedSize: gunzipSync(blob).length,
      entryCount: 7,
      createdAt: at(1).toISOString(),
      entriesSha256: entriesSha256(JSON.parse(readFileSync(join(dir, id(1), cfg.entriesFileName), "utf8"))),
      signingKeyId: KEY.keyId,
      signature: expect.any(String),
    });
    // Signed by the publisher key over exactly what the manifest says.
    const { signature, signingKeyId: _k, ...fields } = manifest;
    expect(verifyManifest(KEY.publicKey, fields, signature)).toBe(true);
    expect(verifyManifest(KEY.publicKey, { ...fields, sha256: "0".repeat(64) }, signature)).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, id(1), cfg.entriesFileName), "utf8"))).toHaveLength(7);
    expect(readCurrentBuild(cfg, dir)).toEqual(manifest);
    expect(readdirSync(dir).filter((x) => x.startsWith("."))).toEqual([]);
  });

  it("refuses a build stamped in the future (it would raise every app's rollback floor for good)", async () => {
    const future = makeBuildId("0.1.0", "abc1234", new Date(at(0).getTime() + cfg.maxFutureStampMs + 60_000));
    await expect(publishAppBuild(cfg, dir, { signingKey: KEY, appPath: bundle("A"), buildId: future, version: "0.1.0", now: at(0) })).rejects.toThrow(/gelecek|future/i);
    expect(existsSync(join(dir, future))).toBe(false);
    // A few seconds ahead (clocks differ a little) is fine.
    const soon = makeBuildId("0.1.0", "abc1234", new Date(at(0).getTime() + 5_000));
    await publishAppBuild(cfg, dir, { signingKey: KEY, appPath: bundle("A"), buildId: soon, version: "0.1.0", now: at(0) });
  });

  it("keeps the last `keep` builds and deletes older ones; the current build always stays", async () => {
    for (const m of [1, 2, 3]) await publishAppBuild(cfg, dir, { signingKey: KEY, appPath: bundle(`A${m}`), buildId: id(m), version: "0.1.0", now: at(m) });
    expect(listPublishedBuilds(cfg, dir).map((m) => m.buildId)).toEqual([id(3), id(2)]);
    expect(existsSync(join(dir, id(1)))).toBe(false);
    // Taking a release back: the older bundle is published again and becomes current.
    const back = await publishAppBuild(cfg, dir, { signingKey: KEY, appPath: bundle("A2"), buildId: id(2), version: "0.1.0", now: at(4) });
    expect(readCurrentBuild(cfg, dir)?.buildId).toBe(id(2));
    expect(back.pruned).toEqual([]);
    expect(listPublishedBuilds(cfg, dir).map((m) => m.buildId)).toEqual([id(2), id(3)]);
  });

  it("a half-written build is never the current one: leftovers of an interrupted publish are ignored and cleaned", async () => {
    await publishAppBuild(cfg, dir, { signingKey: KEY, appPath: bundle("GOOD"), buildId: id(1), version: "0.1.0", now: at(1) });
    mkdirSync(join(dir, `${cfg.incomingPrefix}dead`));
    writeFileSync(join(dir, `${cfg.incomingPrefix}dead`, cfg.blobFileName), "HALF");
    // A build folder whose blob is shorter than its manifest says, and one without its entry list.
    const good = readPublishedBuild(cfg, dir, id(1))!;
    for (const [m, withEntries] of [[5, true], [6, false]] as const) {
      mkdirSync(join(dir, id(m)));
      writeFileSync(join(dir, id(m), cfg.manifestFileName), JSON.stringify({ ...good, buildId: id(m), size: m === 5 ? 100 : 5 }));
      writeFileSync(join(dir, id(m), cfg.blobFileName), "SHORT");
      if (withEntries) writeFileSync(join(dir, id(m), cfg.entriesFileName), "[]");
      expect(readPublishedBuild(cfg, dir, id(m))).toBeUndefined();
    }
    writeFileSync(join(dir, cfg.currentFileName), JSON.stringify({ buildId: id(5) }));
    expect(readCurrentBuild(cfg, dir)).toBeUndefined();

    await publishAppBuild(cfg, dir, { signingKey: KEY, appPath: bundle("NEXT"), buildId: id(7), version: "0.1.0", now: at(7) });
    expect(readCurrentBuild(cfg, dir)?.buildId).toBe(id(7));
    expect(readdirSync(dir).sort()).toEqual([id(1), id(7), cfg.currentFileName].sort());
  });

  it.each(["../escape", "a/b", ".hidden", "1..2", "backup", "builds", "0.1.0-unbuilt"])("refuses %j as a build id (it becomes a folder name)", async (bad) => {
    await expect(publishAppBuild(cfg, dir, { signingKey: KEY, appPath: bundle("X"), buildId: bad, version: "0.1.0" })).rejects.toThrow();
    expect(existsSync(join(root, "escape"))).toBe(false);
  });

  it("refuses a folder that is not an .app with a plain name; nothing is announced", async () => {
    await expect(publishAppBuild(cfg, dir, { signingKey: KEY, appPath: bundle("X", {}, "Kökpit.app"), buildId: id(1), version: "0.1.0" })).rejects.toThrow("plain name");
    await expect(publishAppBuild(cfg, dir, { signingKey: KEY, appPath: join(root, "nowhere", "Kokpit.app"), buildId: id(1), version: "0.1.0" })).rejects.toThrow();
    expect(readCurrentBuild(cfg, dir)).toBeUndefined();
  });

  it("current.json naming a path is not followed", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, cfg.currentFileName), JSON.stringify({ buildId: "../../etc" }));
    expect(readCurrentBuild(cfg, dir)).toBeUndefined();
  });
});

describe("service", () => {
  it("announces the current build; a build that needs a newer engine is withheld", async () => {
    const service = createAppUpdateService({ config: cfg, dir, engineBuild, logger });
    expect(service.current()).toBeNull();
    await publishAppBuild(cfg, dir, { signingKey: KEY, appPath: bundle("OK"), buildId: id(1), version: "0.1.0", minEngineBuild: id(30), now: at(1) });
    expect(service.current()?.buildId).toBe(id(1));
    await publishAppBuild(cfg, dir, { signingKey: KEY, appPath: bundle("TOO-NEW"), buildId: id(2), version: "0.1.0", minEngineBuild: id(31), now: at(2) });
    expect(service.current()).toBeNull();
    expect(() => service.issue({}, id(2))).toThrow("yayında değil");
  });

  it("a URL is issued only for the current build, together with its entry list", async () => {
    const service = createAppUpdateService({ config: cfg, dir, engineBuild, logger });
    await publishAppBuild(cfg, dir, { signingKey: KEY, appPath: bundle("ONE"), buildId: id(1), version: "0.1.0", now: at(1) });
    await publishAppBuild(cfg, dir, { signingKey: KEY, appPath: bundle("TWO"), buildId: id(2), version: "0.1.0", now: at(2) });
    expect(() => service.issue({}, id(1))).toThrow("yayında değil");
    const d = service.issue({}, id(2));
    expect(d.path).toMatch(/^\/app-updates\/[A-Za-z0-9_-]{32,}$/);
    expect(d.entries.find((e) => e.path === "Contents/Resources/data.txt")).toMatchObject({ type: "file", sha256: sha("TWO") });
  });

  it("an entry list that was tampered with on disk (a path out of the bundle) is never handed out", async () => {
    const service = createAppUpdateService({ config: cfg, dir, engineBuild, logger });
    await publishAppBuild(cfg, dir, { signingKey: KEY, appPath: bundle("X"), buildId: id(1), version: "0.1.0", now: at(1) });
    const file = join(dir, id(1), cfg.entriesFileName);
    const entries = JSON.parse(readFileSync(file, "utf8")) as BundleEntry[];
    entries[1]!.path = "../../evil";
    writeFileSync(file, JSON.stringify(entries));
    expect(() => service.issue({}, id(1))).toThrow("yayında değil");
  });

  it("remembers what each app said it is, and what became of its update", () => {
    const t = 1_800_000_000_000;
    const service = createAppUpdateService({ config: cfg, dir, engineBuild, logger, now: () => t });
    service.seen({ clientId: "client-0001", buildId: id(1), version: "0.1.0" });
    service.report({ clientId: "client-0001", buildId: id(2), outcome: "rolledBack", detail: "açılmadı" });
    service.seen({ clientId: "client-0001", buildId: id(1), version: "0.1.0" });
    expect(service.clients()).toEqual([{ clientId: "client-0001", buildId: id(1), version: "0.1.0", seenAt: new Date(t).toISOString(), outcome: "rolledBack", outcomeBuildId: id(2) }]);
  });
});

describe("publish script", () => {
  const deps = (out: string[], err: string[]): PublishDeps => ({ ...realDeps(), cwd: root, stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), now: () => at(9) });

  it("reads build id, version and publisher key id from the bundle's Info.plist and publishes it, signed", async () => {
    const app = bundle("P", { KokpitBuildId: id(7), CFBundleShortVersionString: "0.1.0", KokpitUpdateKeyId: KEY.keyId });
    expect(readBundleIdentity(cfg, app, realDeps())).toEqual({ buildId: id(7), version: "0.1.0", updateKeyId: KEY.keyId });
    const out: string[] = [];
    const err: string[] = [];
    expect(await runCli(["--dir", dir, "--app", app, "--signing-dir", SIGNING_DIR], deps(out, err))).toBe(0);
    expect(err).toEqual([]);
    expect(out.join("")).toContain(`published ${id(7)}`);
    expect(readCurrentBuild(cfg, dir)).toMatchObject({ buildId: id(7), version: "0.1.0", entryCount: 7, signingKeyId: KEY.keyId });
    const listed: string[] = [];
    expect(await runCli(["list", "--dir", dir], deps(listed, err))).toBe(0);
    expect(listed.join("")).toContain(`* ${id(7)}`);
  });

  it("a bundle without a build id (an app from before self-update) is refused, nothing is published", async () => {
    const err: string[] = [];
    expect(await runCli(["--dir", dir, "--app", bundle("old", { CFBundleShortVersionString: "0.1.0" }), "--signing-dir", SIGNING_DIR], deps([], err))).toBe(1);
    expect(err.join("")).toContain("KokpitBuildId");
    expect(existsSync(join(dir, cfg.currentFileName))).toBe(false);
  });

  it("a bundle built without the publisher key, or for another key, is refused: it could never verify a later update", async () => {
    for (const keyId of [undefined, "0123456789abcdef"]) {
      const err: string[] = [];
      const plist = { KokpitBuildId: id(8), CFBundleShortVersionString: "0.1.0", ...(keyId ? { KokpitUpdateKeyId: keyId } : {}) };
      expect(await runCli(["--dir", dir, "--app", bundle("K", plist), "--signing-dir", SIGNING_DIR], deps([], err))).toBe(1);
      expect(err.join("")).toContain("publisher key");
      expect(existsSync(join(dir, cfg.currentFileName))).toBe(false);
    }
  });

  it("publish never creates a key (that is keygen, before the build); keygen creates it once", async () => {
    const fresh = join(root, `signing-${Date.now()}`);
    const err: string[] = [];
    const plist = { KokpitBuildId: id(9), CFBundleShortVersionString: "0.1.0", KokpitUpdateKeyId: KEY.keyId };
    expect(await runCli(["--dir", dir, "--app", bundle("N", plist), "--signing-dir", fresh], deps([], err))).toBe(1);
    expect(err.join("")).toContain("keygen");
    expect(existsSync(fresh)).toBe(false);
    const out: string[] = [];
    expect(await runCli(["keygen", "--signing-dir", fresh], deps(out, []))).toBe(0);
    expect(out.join("")).toMatch(/publisher key [0-9a-f]{16}/);
    expect(existsSync(join(fresh, "private.pem"))).toBe(true);
  });

  it("the target folder comes from engine.json: dataDir, or appUpdates.dir when set", () => {
    const d = deps([], []);
    const config = join(root, "engine.json");
    writeFileSync(config, JSON.stringify({ dataDir: join(root, "data") }));
    expect(resolveTarget(d, { config }).dir).toBe(appUpdatesDir(cfg, join(root, "data")));
    writeFileSync(config, JSON.stringify({ dataDir: join(root, "data"), appUpdates: { dir: join(root, "elsewhere"), keep: 9 } }));
    const t = resolveTarget(d, { config });
    expect(t.dir).toBe(join(root, "elsewhere"));
    expect(t.cfg.keep).toBe(9);
    expect(() => resolveTarget(d, {})).toThrow("--config");
  });

  it("without --app the bundle of the dist folder is taken", () => {
    const engineDir = join(root, "engine-pkg");
    const dist = join(root, "app", "dist", "mac-arm64");
    mkdirSync(engineDir, { recursive: true });
    mkdirSync(join(dist, "Kokpit.app"), { recursive: true });
    writeFileSync(join(dist, "notes.app"), "a file, not a bundle");
    expect(newestBundle(cfg, engineDir)).toBe(join(dist, "Kokpit.app"));
    expect(() => newestBundle(cfg, join(root, "nowhere", "x"))).toThrow("pnpm --filter @kokpit/app dist");
  });
});
