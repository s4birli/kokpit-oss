// SSH hosts: read-only aliases from ~/.ssh/config plus hosts the user created in
// Kokpit (persisted in the StateStore). Identity files are referenced by NAME
// inside HostPaths.sshDir only; key contents are never read.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { RequestParams, type ParamsOf, type SshHost } from "@kokpit/shared";
import { st } from "@kokpit/shared/i18n";
import { EngineError, engineError, type HostPaths, type Logger, type SshHostService, type StateStore } from "./contracts.ts";
import { parseSshConfig } from "./ssh-config.ts";

export interface SshDirEntry {
  name: string;
  /** Regular file (not a directory, not a symlink). */
  isFile: boolean;
}

export interface SshHostServiceDeps {
  hostPaths: HostPaths;
  store: StateStore;
  logger: Logger;
  /** Number of projects whose location points at this host. */
  projectsUsingHost: (hostId: string) => number;
  /** Reads a text file (only ever called with HostPaths.sshConfigFile). */
  readFile?: (path: string) => string;
  /** Lists a directory without following symlinks or reading contents. */
  readdir?: (dir: string) => SshDirEntry[];
  newId?: () => string;
}

const PUB_SUFFIX = ".pub";
/** Files in ~/.ssh that are never private keys, even when a `.pub` happens to sit next to them. */
const NOT_KEYS = [/^known_hosts/, /^authorized_keys/, /^config$/];

const CreateSchema = RequestParams["sshHosts.create"];
const UpdateSchema = RequestParams["sshHosts.update"];
const HostTokenSchema = CreateSchema.shape.hostname;

function defaultReaddir(dir: string): SshDirEntry[] {
  return readdirSync(dir, { withFileTypes: true }).map((d) => ({ name: d.name, isFile: d.isFile() }));
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function invalid(error: { issues: { message: string; path: PropertyKey[] }[] }): EngineError {
  const issue = error.issues[0];
  const detail = issue?.message ?? st("engine.ssh.invalidHost");
  return issue && issue.path.length > 0
    ? engineError("INVALID", "engine.ssh.invalidField", { field: issue.path.map(String).join("."), detail })
    : engineError("INVALID", "engine.ssh.invalid", { detail });
}

export function createSshHostService(deps: SshHostServiceDeps): SshHostService {
  const { hostPaths, store, logger, projectsUsingHost } = deps;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const readdir = deps.readdir ?? defaultReaddir;
  const newId = deps.newId ?? (() => randomUUID());

  function configHosts(): SshHost[] {
    let text: string;
    try {
      text = readFile(hostPaths.sshConfigFile);
    } catch (err) {
      if (!isMissing(err)) logger.warn("ssh config okunamadı", { file: hostPaths.sshConfigFile, error: String(err) });
      return [];
    }
    const out: SshHost[] = [];
    for (const e of parseSshConfig(text)) {
      if (!HostTokenSchema.safeParse(e.alias).success) continue;
      const h: SshHost = { id: e.alias, name: e.alias, hostname: e.alias, source: "ssh-config" };
      if (e.user !== undefined) h.user = e.user;
      if (e.port !== undefined) h.port = e.port;
      if (e.identityFile !== undefined) h.identityFile = basename(e.identityFile);
      out.push(h);
    }
    return out;
  }

  function sshDirEntries(): SshDirEntry[] {
    try {
      return readdir(hostPaths.sshDir);
    } catch (err) {
      if (!isMissing(err)) logger.warn("ssh klasörü okunamadı", { dir: hostPaths.sshDir, error: String(err) });
      return [];
    }
  }

  /** Private key file NAMES in ~/.ssh: regular files with a sibling `.pub`, minus known non-keys. Never read. */
  function keyNames(): string[] {
    const entries = sshDirEntries();
    const names = new Set(entries.map((e) => e.name));
    return entries
      .filter(
        (e) =>
          e.isFile &&
          !e.name.endsWith(PUB_SUFFIX) &&
          !NOT_KEYS.some((re) => re.test(e.name)) &&
          names.has(e.name + PUB_SUFFIX) &&
          CreateSchema.shape.identityFile.safeParse(e.name).success,
      )
      .map((e) => e.name)
      .sort();
  }

  /** Same predicate as listKeys: a host may only point at a key the app could have offered. */
  function assertKeyExists(name: string): void {
    if (!keyNames().includes(name)) throw engineError("INVALID", "engine.ssh.noKey");
  }

  function kokpitHost(hostId: string): SshHost {
    if (configHosts().some((h) => h.id === hostId)) throw engineError("INVALID", "engine.ssh.fromConfig");
    const h = store.getSshHost(hostId);
    if (!h) throw engineError("NOT_FOUND", "engine.ssh.notFound");
    return h;
  }

  function list(): SshHost[] {
    const fromConfig = configHosts();
    const taken = new Set(fromConfig.map((h) => h.id));
    return [...fromConfig, ...store.listSshHosts().filter((h) => !taken.has(h.id))];
  }

  function uniqueId(): string {
    const taken = new Set(list().map((h) => h.id));
    for (const h of store.listSshHosts()) taken.add(h.id);
    const base = newId();
    let id = base;
    for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
    return id;
  }

  return {
    list,

    get(hostId) {
      return list().find((h) => h.id === hostId);
    },

    create(input: ParamsOf<"sshHosts.create">): SshHost {
      const r = CreateSchema.safeParse(input);
      if (!r.success) throw invalid(r.error);
      const v = r.data;
      if (v.identityFile !== undefined) assertKeyExists(v.identityFile);
      const host: SshHost = { id: uniqueId(), name: v.name, hostname: v.hostname, source: "kokpit" };
      if (v.user !== undefined) host.user = v.user;
      if (v.port !== undefined) host.port = v.port;
      if (v.identityFile !== undefined) host.identityFile = v.identityFile;
      store.upsertSshHost(host);
      logger.info("ssh sunucusu eklendi", { hostId: host.id });
      return host;
    },

    update(input: ParamsOf<"sshHosts.update">): SshHost {
      const r = UpdateSchema.safeParse(input);
      if (!r.success) throw invalid(r.error);
      const v = r.data;
      const host = { ...kokpitHost(v.hostId) };
      if (v.name !== undefined) host.name = v.name;
      if (v.hostname !== undefined) host.hostname = v.hostname;
      if (v.user === null) delete host.user;
      else if (v.user !== undefined) host.user = v.user;
      if (v.port === null) delete host.port;
      else if (v.port !== undefined) host.port = v.port;
      if (v.identityFile === null) delete host.identityFile;
      else if (v.identityFile !== undefined) {
        assertKeyExists(v.identityFile);
        host.identityFile = v.identityFile;
      }
      store.upsertSshHost(host);
      logger.info("ssh sunucusu güncellendi", { hostId: host.id });
      return host;
    },

    delete(hostId: string): void {
      if (typeof hostId !== "string") throw engineError("INVALID", "engine.ssh.notFound");
      kokpitHost(hostId);
      if (projectsUsingHost(hostId) > 0) throw engineError("INVALID", "engine.ssh.inUse");
      store.removeSshHost(hostId);
      logger.info("ssh sunucusu silindi", { hostId });
    },

    listKeys(): string[] {
      return keyNames();
    },
  };
}
