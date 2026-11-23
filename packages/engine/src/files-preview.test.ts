// Yollar — önizleme: a local page and the files next to it behind a token address. Real files in a temp HOME, a
// real HTTP server on loopback in front of `handleHttp`, a fake clock for expiry. Every guard has its case here.
import { execFileSync } from "node:child_process";
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FILES_PREVIEW_HTTP_PREFIX, parseFilesPreviewPath } from "@kokpit/shared";
import { EngineError } from "./contracts.ts";
import { loadFilesConfig, type FilesConfig } from "./files.ts";
import { createPreviewService, type PreviewService } from "./files-preview.ts";
import { FakeLogger } from "../test/fakes/server-fakes.ts";

const SECRET = "KOKPIT-ONIZLEME-GIZLI";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const P1 = "proje-1";
const P2 = "proje-2";

let base: string;
let home: string;
let project: string;
let outside: string;
let report: string;
let cfg: FilesConfig["preview"];
let clock = 1_000_000;
let logger: FakeLogger;
let preview: PreviewService;
let server: http.Server;
let port: number;

function build(overrides: Partial<FilesConfig["preview"]> = {}): void {
  preview?.stop();
  cfg = loadFilesConfig({ preview: overrides }).preview;
  logger = new FakeLogger();
  preview = createPreviewService({ config: cfg, homeDir: home, logger, now: () => clock });
}

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}
function request(method: string, path: string, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}
const get = (path: string, headers: Record<string, string> = {}) => request("GET", path, headers);

function refusal(fn: () => unknown): { code: string; message: string } | "ok" {
  try {
    fn();
  } catch (e) {
    if (e instanceof EngineError) return { code: e.code, message: e.message };
    throw e;
  }
  return "ok";
}
const refused = (file: string, roots: string[] = []) => refusal(() => preview.issue(P1, file, roots));
/** The address prefix of a preview: `/files/preview/<token>`. */
const siteOf = (path: string): string => `${FILES_PREVIEW_HTTP_PREFIX}${parseFilesPreviewPath(path)!.token}`;
const write = (path: string, content: string | Buffer = "x"): string => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
};

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-preview-")));
  home = join(base, "home");
  project = join(base, "proje");
  outside = join(base, "disarisi");
  report = join(home, "Documents", "rapor");
  write(join(report, "index.html"), `<!doctype html><link rel="stylesheet" href="style.css"><script src="app.js"></script><img src="img/a.png">`);
  write(join(report, "style.css"), "body { color: rgb(1, 2, 3); }");
  write(join(report, "app.js"), "document.title = 'tamam';");
  write(join(report, "img", "a.png"), PNG);
  write(join(report, "alt", "index.html"), "<!doctype html><title>alt</title>");
  write(join(report, "bos", "not.txt"), "klasörün index dosyası yok");
  write(join(report, "veri.json"), `{"a":1}`);
  write(join(report, "notlar.md"), "# başlık");
  write(join(report, "betik.sh"), "#!/bin/sh\necho hayır");
  write(join(report, "program"), "uzantısız");
  write(join(report, ".env"), SECRET);
  write(join(report, ".git", "config.txt"), SECRET);
  write(join(report, "a b", "çğ ş.html"), "<!doctype html><title>boşluklu</title>");
  write(join(home, "Documents", "tek.html"), "<!doctype html><title>tek</title>");
  write(join(home, "Documents", "komsu.txt"), SECRET);
  write(join(home, "ev.html"), "<!doctype html>");
  write(join(home, ".ssh", "sayfa.html"), SECRET);
  write(join(home, ".config", "arac", "rapor", "index.html"), SECRET);
  write(join(home, "Library", "Uygulama", "index.html"), SECRET);
  write(join(home, "belge", ".gizli", "index.html"), SECRET);
  write(join(project, "dist", "index.html"), "<!doctype html><title>proje</title>");
  write(join(project, "kok.html"), "<!doctype html><title>kök</title>");
  write(join(outside, "index.html"), SECRET);
  write(join(outside, "gizli.txt"), SECRET);
  server = http.createServer((req, res) => {
    if (!preview.handleHttp(req, res)) {
      res.writeHead(418);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
});

beforeEach(() => {
  clock = 1_000_000;
  build();
});
afterEach(() => preview.stop());
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(base, { recursive: true, force: true });
});

describe("önizleme: bir sayfa ve yanındaki dosyalar", () => {
  it("serves the entry file and its relative assets, each with its own type", async () => {
    const url = preview.issue(P1, join(report, "index.html"), []);
    expect(url.single).toBe(false);
    expect(url.path).toMatch(new RegExp(`^${FILES_PREVIEW_HTTP_PREFIX}[A-Za-z0-9_-]{43}/index\\.html$`));
    const site = siteOf(url.path);

    const page = await get(url.path);
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.body.toString()).toContain("style.css");
    for (const [path, type] of [
      ["/style.css", "text/css; charset=utf-8"],
      ["/app.js", "text/javascript; charset=utf-8"],
      ["/img/a.png", "image/png"],
      ["/veri.json", "application/json; charset=utf-8"],
      ["/notlar.md", "text/plain; charset=utf-8"],
      ["/bos/not.txt", "text/plain; charset=utf-8"],
      ["/alt/index.html", "text/html; charset=utf-8"],
      ["/a%20b/%C3%A7%C4%9F%20%C5%9F.html", "text/html; charset=utf-8"],
    ] as const) {
      const r = await get(`${site}${path}`);
      expect(r.status, path).toBe(200);
      expect(r.headers["content-type"], path).toBe(type);
    }
    // A query is the page's own business (cache busters, `page.html?id=3`).
    expect((await get(`${site}/style.css?v=3`)).status).toBe(200);
  });

  it("every answer carries the protective headers and no CORS header; the policy names only this preview", async () => {
    const url = preview.issue(P1, join(report, "index.html"), []);
    const site = siteOf(url.path);
    for (const r of [await get(url.path), await get(`${site}/img/a.png`), await get(`${site}/yok.css`), await get(`${FILES_PREVIEW_HTTP_PREFIX}${"x".repeat(43)}/a.html`)]) {
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["cache-control"]).toBe("no-store");
      expect(r.headers["referrer-policy"]).toBe("no-referrer");
      expect(r.headers["cross-origin-resource-policy"]).toBe("same-origin");
      expect(r.headers["access-control-allow-origin"]).toBeUndefined();
      expect(r.headers["set-cookie"]).toBeUndefined();
      expect(r.headers["content-security-policy"]).toBeTruthy();
    }
    const csp = String((await get(url.path)).headers["content-security-policy"]);
    const self = `http://127.0.0.1:${port}${site}/`;
    expect(csp).toContain(`connect-src ${self};`);
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain(`script-src ${self} 'unsafe-inline' 'unsafe-eval' https: blob:`);
    expect(csp).not.toContain("{self}");
    // Not the whole origin: the engine's other routes and other previews are not the page's to fetch.
    expect(csp).not.toMatch(/connect-src[^;]*'self'/);
    expect(csp).not.toMatch(/connect-src[^;]*https:/);
    // A Host header that cannot be written into a policy gives the page no source of its own at all.
    const odd = String((await get(url.path, { host: "evil.example;script-src *" })).headers["content-security-policy"]);
    expect(odd).toContain("connect-src 'none';");
    expect(odd).not.toContain("evil.example");
  });

  it("the site's own address shows the entry file; the address without a slash redirects below the token", async () => {
    const url = preview.issue(P1, join(report, "index.html"), []);
    const site = siteOf(url.path);
    const root = await get(`${site}/`);
    expect(root.status).toBe(200);
    expect(root.body.toString()).toContain("style.css");
    const bare = await get(site);
    expect(bare.status).toBe(302);
    expect(bare.headers.location).toBe(`${site}/index.html`);
  });

  it("never lists a folder: its index file or nothing", async () => {
    const site = siteOf(preview.issue(P1, join(report, "index.html"), []).path);
    const sub = await get(`${site}/alt/`);
    expect(sub.status).toBe(200);
    expect(sub.body.toString()).toContain("<title>alt</title>");
    const noSlash = await get(`${site}/alt`);
    expect(noSlash.status).toBe(302);
    expect(noSlash.headers.location).toBe(`${site}/alt/`);
    for (const path of ["/bos/", "/bos", "/img/", "/img"]) {
      const r = await get(`${site}${path}`);
      expect(r.status, path).toBe(404);
      expect(r.body.toString(), path).not.toMatch(/not\.txt|a\.png/);
    }
  });

  it("serves byte ranges and HEAD; other methods are refused", async () => {
    const site = siteOf(preview.issue(P1, join(report, "index.html"), []).path);
    const part = await get(`${site}/style.css`, { range: "bytes=0-3" });
    expect(part.status).toBe(206);
    expect(part.body.toString()).toBe("body");
    expect(part.headers["content-range"]).toBe("bytes 0-3/29");
    expect((await get(`${site}/style.css`, { range: "bytes=99-" })).status).toBe(416);
    expect((await get(`${site}/style.css`, { range: "bytes=0-1,3-4" })).status).toBe(416);
    const head = await request("HEAD", `${site}/style.css`);
    expect(head.status).toBe(200);
    expect(head.headers["content-length"]).toBe("29");
    expect(head.body.length).toBe(0);
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const r = await request(method, `${site}/style.css`);
      expect(r.status, method).toBe(405);
      expect(r.headers.allow).toBe("GET, HEAD");
    }
  });

  it("leaves other paths to the caller", async () => {
    expect((await get("/health")).status).toBe(418);
    expect((await get("/files/media/abc")).status).toBe(418);
    expect((await get("/files/previewx")).status).toBe(418);
  });
});

describe("önizleme: hangi klasörler açılır", () => {
  it("a folder inside HOME, inside the project, or a configured root — nothing else", () => {
    expect(refused(join(report, "index.html"))).toBe("ok");
    expect(refused(join(project, "dist", "index.html"), [project])).toBe("ok");
    expect(refused(join(project, "kok.html"), [project])).toBe("ok");
    // Not the project of this request, not in HOME.
    expect(refused(join(project, "dist", "index.html"))).toMatchObject({ code: "INVALID", message: expect.stringContaining("önizlemeye açık değil") });
    expect(refused(join(outside, "index.html"), [project])).toMatchObject({ code: "INVALID" });
    build({ extraRoots: [outside] });
    expect(refused(join(outside, "index.html"))).toBe("ok");
  });

  it("refuses HOME itself, / and the denied top-level folders", () => {
    expect(refused(join(home, "ev.html"))).toMatchObject({ code: "INVALID", message: expect.stringContaining("Ev klasörünün kendisi") });
    // Also when HOME is the project's folder (the built-in "Mac mini" project).
    expect(refused(join(home, "ev.html"), [home])).toMatchObject({ code: "INVALID" });
    expect(refused(join(home, "Library", "Uygulama", "index.html"))).toMatchObject({ code: "INVALID", message: expect.stringContaining("kapalı") });
    expect(refused(join(home, "Library", "Uygulama", "index.html"), [home])).toMatchObject({ code: "INVALID" });
    expect(refused("/etc/hosts.html")).toMatchObject({ code: "NOT_FOUND" });
    // The file system root can never be a configured root.
    expect(() => loadFilesConfig({ preview: { extraRoots: ["/"] } })).toThrow(/preview\.extraRoots/);
    expect(() => loadFilesConfig({ preview: { extraRoots: ["göreli/yol"] } })).toThrow(/preview\.extraRoots/);
  });

  it("refuses every path with a dot-directory or dot-file in it", () => {
    for (const file of [
      join(home, ".ssh", "sayfa.html"),
      join(home, ".config", "arac", "rapor", "index.html"),
      join(home, "belge", ".gizli", "index.html"),
    ]) {
      expect(refused(file), file).toMatchObject({ code: "INVALID", message: expect.stringContaining("Gizli") });
      expect(refused(file, [home]), file).toMatchObject({ code: "INVALID" });
    }
    write(join(report, ".taslak.html"), "<!doctype html>");
    expect(refused(join(report, ".taslak.html"))).toMatchObject({ code: "INVALID" });
    // A project the user made of such a folder is the user's choice: below it the rule starts anew.
    const dotProject = join(home, ".config", "arac");
    expect(refused(join(dotProject, "rapor", "index.html"), [dotProject])).toBe("ok");
    write(join(dotProject, ".ic", "index.html"), "<!doctype html>");
    expect(refused(join(dotProject, ".ic", "index.html"), [dotProject])).toMatchObject({ code: "INVALID" });
  });

  it("only regular files of the web types; the name asked for must be that type too", () => {
    expect(refused(join(report, "betik.sh"))).toMatchObject({ code: "INVALID", message: expect.stringContaining("tür") });
    expect(refused(join(report, "program"))).toMatchObject({ code: "INVALID" });
    expect(refused(join(report, "alt"))).toMatchObject({ code: "INVALID", message: expect.stringContaining("Yalnız dosyalar") });
    expect(refused(join(report, "yok.html"))).toMatchObject({ code: "NOT_FOUND" });
    symlinkSync(join(report, "betik.sh"), join(report, "sahte.html"));
    expect(refused(join(report, "sahte.html"))).toMatchObject({ code: "INVALID" });
    execFileSync("mkfifo", [join(report, "boru.html")]);
    expect(refused(join(report, "boru.html"))).toMatchObject({ code: "INVALID" });
    expect(refused("/dev/null")).toMatchObject({ code: "INVALID" });
  });

  it("refuses files over the size cap, at issue time and when one grows later", async () => {
    build({ maxBytes: 64 });
    const big = write(join(report, "buyuk.html"), "x".repeat(65));
    expect(refused(big)).toMatchObject({ code: "INVALID", message: expect.stringContaining("büyük") });
    const site = siteOf(preview.issue(P1, join(report, "alt", "index.html"), []).path);
    expect((await get(`${site}/index.html`)).status).toBe(200);
    const fd = openSync(join(report, "alt", "sismis.css"), "w");
    ftruncateSync(fd, 1024 * 1024);
    closeSync(fd);
    expect((await get(`${site}/sismis.css`)).status).toBe(404);
  });

  it("a file directly in a wide folder (Documents, Downloads…) is served alone", async () => {
    const url = preview.issue(P1, join(home, "Documents", "tek.html"), []);
    expect(url.single).toBe(true);
    const site = siteOf(url.path);
    expect((await get(url.path)).status).toBe(200);
    expect((await get(`${site}/`)).status).toBe(200);
    for (const path of ["/komsu.txt", "/rapor/index.html", "/rapor/", "/rapor/style.css"]) {
      const r = await get(`${site}${path}`);
      expect(r.status, path).toBe(404);
      expect(r.body.toString()).not.toContain(SECRET);
    }
  });

  it("the log names the folder's base name only — never the token, the path or the home directory", () => {
    const url = preview.issue(P1, join(report, "index.html"), []);
    const lines = JSON.stringify(logger.entries);
    expect(lines).toContain('"rapor"');
    expect(lines).not.toContain(parseFilesPreviewPath(url.path)!.token);
    expect(lines).not.toContain(home);
    expect(lines).not.toContain("Documents");
  });
});

describe("önizleme: istek yolları kökün dışına çıkamaz", () => {
  let site: string;
  beforeEach(() => {
    site = siteOf(preview.issue(P1, join(report, "index.html"), []).path);
  });

  it.each([
    "/../tek.html",
    "/%2e%2e/tek.html",
    "/..%2ftek.html",
    "/%2e%2e%2f%2e%2e%2f.ssh/sayfa.html",
    "/alt/../../tek.html",
    "/alt/%2e%2e/%2e%2e/komsu.txt",
    "/img\\..\\..\\tek.html",
    "/img%5c..%5c..%5ctek.html",
    "/.env",
    "/%2eenv",
    "/.git/config.txt",
    "/alt/.env",
    "//etc/hosts",
    "/%00",
    "/style.css%00.html",
    "/%zz",
    "/betik.sh",
    "/program",
  ])("%s → 404, no content", async (path) => {
    const r = await get(`${site}${path}`);
    expect(r.status).toBe(404);
    expect(r.body.toString()).not.toContain(SECRET);
    expect(r.body.toString()).not.toContain("hayır");
  });

  it("a symlink that leaves the root is not followed — also when it appears after the preview was opened", async () => {
    symlinkSync(join(outside, "gizli.txt"), join(report, "kacak.txt"));
    symlinkSync(outside, join(report, "kacak-klasor"));
    symlinkSync(join(home, ".ssh"), join(report, "anahtarlar"));
    symlinkSync(join(report, ".env"), join(report, "ortam.txt"));
    symlinkSync(join(report, "style.css"), join(report, "ic.css"));
    for (const path of ["/kacak.txt", "/kacak-klasor/gizli.txt", "/kacak-klasor/index.html", "/kacak-klasor/", "/anahtarlar/sayfa.html", "/ortam.txt"]) {
      const r = await get(`${site}${path}`);
      expect(r.status, path).toBe(404);
      expect(r.body.toString(), path).not.toContain(SECRET);
    }
    // A link that stays inside the root is an ordinary file.
    expect((await get(`${site}/ic.css`)).status).toBe(200);
  });

  it("a root that was swapped for a link ends the preview's reach", async () => {
    const moved = join(home, "Documents", "tasinan");
    write(join(moved, "index.html"), "<!doctype html>");
    const own = siteOf(preview.issue(P1, join(moved, "index.html"), []).path);
    expect((await get(`${own}/index.html`)).status).toBe(200);
    renameSync(moved, `${moved}-eski`);
    symlinkSync(outside, moved);
    const r = await get(`${own}/index.html`);
    expect(r.status).toBe(404);
    expect(r.body.toString()).not.toContain(SECRET);
    expect((await get(`${own}/gizli.txt`)).status).toBe(404);
  });

  it("a FIFO or a device swapped in for a file is never opened", async () => {
    const victim = write(join(report, "degisen.css"), "a{}");
    expect((await get(`${site}/degisen.css`)).status).toBe(200);
    rmSync(victim);
    execFileSync("mkfifo", [victim]);
    expect((await get(`${site}/degisen.css`)).status).toBe(404);
    rmSync(victim);
    symlinkSync("/dev/zero", victim);
    expect((await get(`${site}/degisen.css`)).status).toBe(404);
  });
});

describe("önizleme: adresin ömrü ve yalıtımı", () => {
  it("expires when idle; every use renews it", async () => {
    build({ tokenTtlMs: 1000 });
    const url = preview.issue(P1, join(report, "index.html"), []);
    clock += 900;
    expect((await get(url.path)).status).toBe(200);
    clock += 900;
    expect((await get(url.path)).status).toBe(200);
    clock += 1001;
    const gone = await get(url.path);
    expect(gone.status).toBe(404);
    expect(gone.body.toString()).toContain("süresi doldu");
    expect(preview.stats().tokens).toBe(0);
  });

  it("is revoked by its address, with its project, and when the service stops — not by another project's end", async () => {
    const a = preview.issue(P1, join(report, "index.html"), []);
    const b = preview.issue(P2, join(report, "alt", "index.html"), []);
    preview.revokeProject("baska-proje");
    expect((await get(a.path)).status).toBe(200);
    preview.revoke(`${siteOf(a.path)}/herhangi.css`);
    expect((await get(a.path)).status).toBe(404);
    expect((await get(b.path)).status).toBe(200);
    preview.revokeProject(P2);
    expect((await get(b.path)).status).toBe(404);
    const c = preview.issue(P1, join(report, "index.html"), []);
    preview.stop();
    expect((await get(c.path)).status).toBe(404);
  });

  it("two previews are two sites: neither address reaches the other's files", async () => {
    const one = siteOf(preview.issue(P1, join(report, "alt", "index.html"), []).path);
    const two = siteOf(preview.issue(P1, join(report, "bos", "not.txt"), []).path);
    expect(one).not.toBe(two);
    expect((await get(`${one}/index.html`)).status).toBe(200);
    expect((await get(`${two}/not.txt`)).status).toBe(200);
    expect((await get(`${one}/not.txt`)).status).toBe(404);
    expect((await get(`${two}/index.html`)).status).toBe(404);
    expect((await get(`${one}/../bos/not.txt`)).status).toBe(404);
    // Tokens are long random strings; a near miss is nothing.
    expect((await get(`${one.slice(0, -1)}${one.endsWith("A") ? "B" : "A"}/index.html`)).status).toBe(404);
  });

  it("the same folder of the same project keeps its address; another project gets its own", () => {
    const first = preview.issue(P1, join(report, "index.html"), []);
    const again = preview.issue(P1, join(report, "veri.json"), []);
    const other = preview.issue(P2, join(report, "index.html"), []);
    expect(siteOf(again.path)).toBe(siteOf(first.path));
    expect(again.path.endsWith("/veri.json")).toBe(true);
    expect(siteOf(other.path)).not.toBe(siteOf(first.path));
    expect(preview.stats().tokens).toBe(2);
  });

  it("keeps a bounded number of previews, per project and in total (the oldest goes)", async () => {
    build({ maxTokensPerProject: 2, maxTokens: 3, rate: { max: 100, windowMs: 1000 } });
    const dirs = ["a", "b", "c", "d"].map((n) => write(join(home, "siteler", n, "index.html"), "<!doctype html>"));
    const [a, b, c] = dirs.slice(0, 3).map((f) => preview.issue(P1, f, []));
    expect(preview.stats().tokens).toBe(2);
    expect((await get(a!.path)).status).toBe(404);
    expect((await get(b!.path)).status).toBe(200);
    preview.issue(P2, dirs[0]!, []);
    preview.issue("proje-3", dirs[3]!, []);
    expect(preview.stats().tokens).toBe(3);
    expect((await get(b!.path)).status).toBe(404);
    expect((await get(c!.path)).status).toBe(200);
  });

  it("limits how often one project opens previews", () => {
    build({ rate: { max: 2, windowMs: 1000 } });
    expect(refused(join(report, "index.html"))).toBe("ok");
    expect(refused(join(report, "index.html"))).toBe("ok");
    expect(refused(join(report, "index.html"))).toMatchObject({ code: "INVALID", message: expect.stringContaining("Çok sık") });
    // Another project is not slowed down by it; later it works again.
    expect(refusal(() => preview.issue(P2, join(report, "index.html"), []))).toBe("ok");
    clock += 1001;
    expect(refused(join(report, "index.html"))).toBe("ok");
  });

  it("check() says the same as issue() without opening anything", () => {
    expect(preview.check(join(report, "index.html"), [])).toEqual({ single: false });
    expect(preview.check(join(home, "Documents", "tek.html"), [])).toEqual({ single: true });
    expect(refusal(() => preview.check(join(home, ".ssh", "sayfa.html"), []))).toMatchObject({ code: "INVALID" });
    expect(preview.stats().tokens).toBe(0);
    expect(preview.typeOf("a/b.HTML")).toBe("text/html; charset=utf-8");
    expect(preview.typeOf("a/b.sh")).toBeUndefined();
    expect(preview.typeOf("Makefile")).toBeUndefined();
  });

  it("the policy must keep its confinement directives", () => {
    expect(() => loadFilesConfig({ preview: { contentSecurityPolicy: "default-src *" } })).toThrow(/contentSecurityPolicy/);
  });
});
