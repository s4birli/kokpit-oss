import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SshHost } from "@kokpit/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineError, type HostPaths, type Logger, type StateStore } from "./contracts.ts";
import { createSshHostService, type SshHostServiceDeps } from "./ssh.ts";

/** Only the ssh-host part of StateStore; the rest is never called by the ssh service. */
class HostStore {
  readonly hosts = new Map<string, SshHost>();
  listSshHosts(): SshHost[] {
    return [...this.hosts.values()].map((h) => ({ ...h }));
  }
  getSshHost(id: string): SshHost | undefined {
    const h = this.hosts.get(id);
    return h && { ...h };
  }
  upsertSshHost(h: SshHost): void {
    this.hosts.set(h.id, { ...h });
  }
  removeSshHost(id: string): void {
    this.hosts.delete(id);
  }
}

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(opts: { config?: string; files?: Record<string, string>; noSshDir?: boolean } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-ssh-")));
  tmpDirs.push(home);
  const sshDir = join(home, ".ssh");
  const hostPaths: HostPaths = { homeDir: home, sshDir, sshConfigFile: join(sshDir, "config") };
  if (!opts.noSshDir) {
    mkdirSync(sshDir);
    if (opts.config !== undefined) writeFileSync(hostPaths.sshConfigFile, opts.config);
    for (const [name, content] of Object.entries(opts.files ?? {})) writeFileSync(join(sshDir, name), content);
  }
  const store = new HostStore();
  const usage = new Map<string, number>();
  const readFile = vi.fn((p: string) => readFileSync(p, "utf8"));
  let n = 0;
  const deps: SshHostServiceDeps = {
    hostPaths,
    store: store as unknown as StateStore,
    logger,
    projectsUsingHost: (id) => usage.get(id) ?? 0,
    readFile,
    newId: () => `h${++n}`,
  };
  return { svc: createSshHostService(deps), store, usage, hostPaths, readFile, deps };
}

function expectEngineError(fn: () => unknown, code: string): EngineError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(EngineError);
    expect((e as EngineError).code).toBe(code);
    return e as EngineError;
  }
  throw new Error("expected an EngineError");
}

const CONFIG = ["Host oracle", "  HostName 1.2.3.4", "  User ubuntu", "  Port 2222", "  IdentityFile ~/.ssh/oracle_key", "Host *", "  User x"].join(
  "\n",
);

describe("list", () => {
  it("lists ~/.ssh/config aliases then Kokpit hosts", () => {
    const { svc, store } = setup({ config: CONFIG });
    store.upsertSshHost({ id: "k1", name: "Kutu", hostname: "box.local", source: "kokpit" });
    expect(svc.list()).toEqual([
      { id: "oracle", name: "oracle", hostname: "oracle", user: "ubuntu", port: 2222, identityFile: "oracle_key", source: "ssh-config" },
      { id: "k1", name: "Kutu", hostname: "box.local", source: "kokpit" },
    ]);
    expect(svc.get("oracle")?.source).toBe("ssh-config");
    expect(svc.get("k1")?.name).toBe("Kutu");
    expect(svc.get("nope")).toBeUndefined();
  });

  it("re-reads the config on every call", () => {
    const { svc, hostPaths } = setup({ config: "Host a\n" });
    expect(svc.list().map((h) => h.id)).toEqual(["a"]);
    writeFileSync(hostPaths.sshConfigFile, "Host b\n");
    expect(svc.list().map((h) => h.id)).toEqual(["b"]);
  });

  it("treats a missing config file or ssh dir as no aliases", () => {
    expect(setup().svc.list()).toEqual([]);
    expect(setup({ noSshDir: true }).svc.list()).toEqual([]);
  });

  it("skips aliases that are unsafe as ssh argv (leading dash, shell chars)", () => {
    const { svc } = setup({ config: "Host -oProxyCommand=x ok a;b $(x) `y`\n" });
    expect(svc.list().map((h) => h.id)).toEqual(["ok"]);
  });

  it("a Kokpit host whose id clashes with an alias is hidden behind the alias", () => {
    const { svc, store } = setup({ config: "Host dup\n" });
    store.upsertSshHost({ id: "dup", name: "x", hostname: "y", source: "kokpit" });
    expect(svc.list()).toHaveLength(1);
    expect(svc.list()[0]!.source).toBe("ssh-config");
  });
});

describe("create", () => {
  it("stores a kokpit host with a generated id", () => {
    const { svc, store } = setup({ files: { id_ed25519: "SECRET", "id_ed25519.pub": "pub" } });
    const h = svc.create({ name: "Sunucu", hostname: "10.0.0.1", user: "root", port: 22, identityFile: "id_ed25519" });
    expect(h).toEqual({ id: "h1", name: "Sunucu", hostname: "10.0.0.1", user: "root", port: 22, identityFile: "id_ed25519", source: "kokpit" });
    expect(store.getSshHost("h1")).toEqual(h);
  });

  it("never takes an id already used by an alias or a stored host", () => {
    const { svc, deps, store } = setup({ config: "Host h1\n" });
    store.upsertSshHost({ id: "h2", name: "x", hostname: "y", source: "kokpit" });
    const ids = ["h1", "h2", "h1"];
    const svc2 = createSshHostService({ ...deps, newId: () => ids.shift() ?? "fresh" });
    const h = svc2.create({ name: "n", hostname: "x" });
    expect(h.id).not.toBe("h1");
    expect(h.id).not.toBe("h2");
    expect(svc.list().map((x) => x.id).sort()).toEqual(["h1", "h2", h.id].sort());
  });

  it("rejects an identity file that is not a regular file directly in sshDir", () => {
    const { svc, hostPaths } = setup({ files: { real: "k" } });
    mkdirSync(join(hostPaths.sshDir, "adir"));
    symlinkSync("/etc/hosts", join(hostPaths.sshDir, "link"));
    for (const identityFile of ["missing", "adir", "link", "../real", "sub/real", "-oFoo"]) {
      expectEngineError(() => svc.create({ name: "n", hostname: "x", identityFile }), "INVALID");
    }
  });

  it("accepts exactly the files listKeys offers: not known_hosts/config/authorized_keys, not a key without .pub", () => {
    const { svc } = setup({
      config: "",
      files: {
        k: "s",
        "k.pub": "p",
        lonely: "s",
        known_hosts: "x",
        "known_hosts.pub": "x",
        authorized_keys: "x",
        "authorized_keys.pub": "x",
        "config.pub": "x",
        "k2.pub": "p",
      },
    });
    expect(svc.listKeys()).toEqual(["k"]);
    for (const identityFile of ["known_hosts", "config", "authorized_keys", "lonely", "k.pub", "k2.pub"]) {
      expectEngineError(() => svc.create({ name: "n", hostname: "x", identityFile }), "INVALID");
    }
    expect(svc.create({ name: "n", hostname: "x", identityFile: "k" }).identityFile).toBe("k");
    const h = svc.create({ name: "m", hostname: "x" });
    expectEngineError(() => svc.update({ hostId: h.id, identityFile: "known_hosts" }), "INVALID");
  });

  it("validates hostname, user and port", () => {
    const { svc } = setup();
    const bad = [
      { name: "n", hostname: "-oProxyCommand=evil" },
      { name: "n", hostname: "a b" },
      { name: "n", hostname: "x;rm" },
      { name: "n", hostname: "x", user: "-l" },
      { name: "n", hostname: "x", user: "$(id)" },
      { name: "n", hostname: "x", port: 0 },
      { name: "n", hostname: "x", port: 65536 },
      { name: " ", hostname: "x" },
    ];
    for (const b of bad) expectEngineError(() => svc.create(b), "INVALID");
  });
});

describe("update", () => {
  it("changes and clears fields of a kokpit host", () => {
    const { svc, store } = setup({ files: { k: "s", "k.pub": "p" } });
    const h = svc.create({ name: "a", hostname: "x", user: "u", port: 2200, identityFile: "k" });
    const u = svc.update({ hostId: h.id, name: "b", user: null, port: null, identityFile: null });
    expect(u).toEqual({ id: h.id, name: "b", hostname: "x", source: "kokpit" });
    expect(store.getSshHost(h.id)).toEqual(u);
    expect(svc.update({ hostId: h.id, hostname: "y", port: 22 })).toMatchObject({ hostname: "y", port: 22, name: "b" });
  });

  it("refuses ssh-config hosts with a pointer to the file, and unknown ids", () => {
    const { svc } = setup({ config: "Host oracle\n" });
    const e = expectEngineError(() => svc.update({ hostId: "oracle", name: "x" }), "INVALID");
    expect(e.message).toContain("oradan düzenle");
    expectEngineError(() => svc.update({ hostId: "nope", name: "x" }), "NOT_FOUND");
  });

  it("validates new values", () => {
    const { svc } = setup();
    const h = svc.create({ name: "a", hostname: "x" });
    expectEngineError(() => svc.update({ hostId: h.id, hostname: "-x" }), "INVALID");
    expectEngineError(() => svc.update({ hostId: h.id, identityFile: "missing" }), "INVALID");
  });
});

describe("delete", () => {
  it("removes an unused kokpit host", () => {
    const { svc, store } = setup();
    const h = svc.create({ name: "a", hostname: "x" });
    svc.delete(h.id);
    expect(store.getSshHost(h.id)).toBeUndefined();
  });

  it("refuses hosts used by a project, ssh-config hosts and unknown ids", () => {
    const { svc, usage, store } = setup({ config: "Host oracle\n" });
    const h = svc.create({ name: "a", hostname: "x" });
    usage.set(h.id, 2);
    expectEngineError(() => svc.delete(h.id), "INVALID");
    expect(store.getSshHost(h.id)).toBeDefined();
    expectEngineError(() => svc.delete("oracle"), "INVALID");
    expectEngineError(() => svc.delete("nope"), "NOT_FOUND");
  });
});

describe("listKeys", () => {
  it("lists private key names that have a .pub sibling, never reading them", () => {
    const { svc, hostPaths, readFile } = setup({
      config: "Host a\n",
      files: {
        id_ed25519: "SECRET",
        "id_ed25519.pub": "pub",
        id_rsa: "SECRET",
        "id_rsa.pub": "pub",
        lonely: "SECRET",
        "orphan.pub": "pub",
        known_hosts: "x",
        "known_hosts.pub": "x",
        "known_hosts.old": "x",
        "known_hosts.old.pub": "x",
        authorized_keys: "x",
        "authorized_keys.pub": "x",
        "config.pub": "x",
      },
    });
    mkdirSync(join(hostPaths.sshDir, "dirkey"));
    writeFileSync(join(hostPaths.sshDir, "dirkey.pub"), "p");
    expect(svc.listKeys()).toEqual(["id_ed25519", "id_rsa"]);
    svc.list();
    const readPaths = readFile.mock.calls.map((c) => c[0]);
    expect(readPaths.every((p) => p === hostPaths.sshConfigFile)).toBe(true);
  });

  it("returns [] when the ssh dir is missing", () => {
    expect(setup({ noSshDir: true }).svc.listKeys()).toEqual([]);
  });

  it("create/update with a key never read the key file", () => {
    const { svc, readFile } = setup({ files: { k: "SECRET", "k.pub": "p" } });
    const h = svc.create({ name: "a", hostname: "x", identityFile: "k" });
    svc.update({ hostId: h.id, identityFile: "k" });
    expect(readFile.mock.calls.every((c) => !String(c[0]).endsWith("/k"))).toBe(true);
  });
});

describe("monkey", () => {
  it("random input only ever throws EngineError", () => {
    const { svc } = setup({ config: "Host a\n", files: { k: "s", "k.pub": "p" } });
    const atoms = ["", "-", "a", "k", "$(x)", "`", "'", '"', " ", "\n", "../", "/", "é", "0", "-o", "ü", ";", "@"];
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const str = () => Array.from({ length: rnd(5) }, () => atoms[rnd(atoms.length)]).join("");
    const anyVal = (): unknown => [str(), rnd(70000) - 10, null, undefined, 1.5, {}, []][rnd(7)];
    for (let i = 0; i < 1000; i++) {
      const input = { hostId: rnd(2) ? "a" : str(), name: anyVal(), hostname: anyVal(), user: anyVal(), port: anyVal(), identityFile: anyVal() };
      for (const op of [() => svc.create(input as never), () => svc.update(input as never), () => svc.delete(input.hostId)]) {
        try {
          op();
        } catch (e) {
          expect(e).toBeInstanceOf(EngineError);
        }
      }
    }
    for (const h of svc.list()) {
      expect(h.hostname).not.toMatch(/^-|[\s;$`'"]/);
      if (h.user !== undefined) expect(h.user).not.toMatch(/^-|[\s;$`'"]/);
    }
  });
});
