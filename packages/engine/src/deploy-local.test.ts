// Kendini güncelleme — the deploy helper, with every side effect faked: nothing is built, published or installed.
import { describe, expect, it } from "vitest";
import type { AppUpdateClient, AppUpdateManifest } from "@kokpit/shared";
import { describeClients, engineTarget, resolveConfigPath, runCli, waitState, type ClientsAnswer, type DeployDeps } from "../scripts/deploy-local.ts";

const NEW = "0.1.0+20261118120000.new";
const OLD = "0.1.0+20261118100000.old";
const current: AppUpdateManifest = {
  buildId: NEW,
  version: "0.1.0",
  format: 1,
  bundleName: "Kokpit.app",
  sha256: "a".repeat(64),
  size: 1,
  unpackedSize: 1,
  entryCount: 1,
  createdAt: "t",
  entriesSha256: "b".repeat(64),
  signingKeyId: "c".repeat(16),
  signature: `${"A".repeat(86)}==`,
};
const client = (clientId: string, buildId: string, over: Partial<AppUpdateClient> = {}): AppUpdateClient => ({ clientId, buildId, version: "0.1.0", seenAt: "t", ...over });

function world(over: Partial<DeployDeps> = {}, files: Record<string, string> = { "/cfg/engine.json": JSON.stringify({ dataDir: "/data" }), "/data/engine.key": "the-key\n" }) {
  const ran: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  let now = 0;
  const deps: DeployDeps = {
    cwd: "/work",
    homedir: "/home/u",
    env: {},
    nodePath: "/bin/node",
    run: (cmd, args) => {
      ran.push([cmd, ...args].join(" "));
      return 0;
    },
    readFile: (p) => {
      if (files[p] === undefined) throw new Error(`ENOENT ${p}`);
      return files[p];
    },
    clients: async () => ({ current, clients: [] }),
    sleep: async (ms) => void (now += ms),
    now: () => now,
    stdout: (s) => void out.push(s),
    stderr: (s) => void err.push(s),
    ...over,
  };
  return { deps, ran, out, err };
}

describe("deploy:local", () => {
  it("runs key → build (with the key's folder) → publish → reinstall the engine, in that order, all against the same config", async () => {
    const envs: (Record<string, string> | undefined)[] = [];
    const ran: string[] = [];
    const w = world({ run: (cmd, args, _cwd, env) => (ran.push([cmd, ...args].join(" ")), envs.push(env), 0) });
    expect(await runCli(["--config", "/cfg/engine.json"], w.deps)).toBe(0);
    expect(ran).toHaveLength(4);
    expect(ran[0]).toMatch(/^\/bin\/node .*scripts\/publish-app\.ts keygen --config \/cfg\/engine\.json$/);
    expect(ran[1]).toBe("pnpm --filter @kokpit/app dist");
    // The build embeds the public key of the folder the engine config names (default under the user's home).
    expect(envs[1]).toEqual({ KOKPIT_APP_SIGNING_DIR: "/home/u/.config/kokpit/app-signing" });
    expect(ran[2]).toMatch(/^\/bin\/node .*scripts\/publish-app\.ts --config \/cfg\/engine\.json$/);
    expect(ran[3]).toMatch(/^\/bin\/node .*scripts\/launchd\.ts install --config \/cfg\/engine\.json$/);
  });

  it("the key folder comes from appUpdates.signingKeyDir when the config sets one", async () => {
    const envs: (Record<string, string> | undefined)[] = [];
    const w = world({ run: (_c, _a, _cwd, env) => (envs.push(env), 0) }, { "/cfg/engine.json": JSON.stringify({ dataDir: "/data", appUpdates: { signingKeyDir: "~/keys/kokpit" } }), "/data/engine.key": "k" });
    expect(await runCli(["--config", "/cfg/engine.json"], w.deps)).toBe(0);
    expect(envs[1]).toEqual({ KOKPIT_APP_SIGNING_DIR: "/home/u/keys/kokpit" });
  });

  it("i18n: the engine config's `language` becomes the app build's default language", async () => {
    const envs: (Record<string, string> | undefined)[] = [];
    const w = world({ run: (_c, _a, _cwd, env) => (envs.push(env), 0) }, { "/cfg/engine.json": JSON.stringify({ dataDir: "/data", language: "tr" }), "/data/engine.key": "k" });
    expect(await runCli(["--config", "/cfg/engine.json"], w.deps)).toBe(0);
    expect(envs[1]).toEqual({ KOKPIT_APP_SIGNING_DIR: "/home/u/.config/kokpit/app-signing", KOKPIT_DEFAULT_LANGUAGE: "tr" });
  });

  it("i18n: an unsupported language in the config stops before anything runs", async () => {
    const w = world({}, { "/cfg/engine.json": JSON.stringify({ dataDir: "/data", language: "xx" }), "/data/engine.key": "k" });
    expect(await runCli(["--config", "/cfg/engine.json"], w.deps)).not.toBe(0);
    expect(w.ran).toEqual([]);
  });

  it("a failed step stops everything after it: a build that fails publishes nothing and leaves the engine alone", async () => {
    const ran: string[] = [];
    const w = world({ run: (cmd, args) => (ran.push([cmd, ...args].join(" ")), ran.length === 2 ? 1 : 0) });
    expect(await runCli(["--config", "/cfg/engine.json"], w.deps)).toBe(1);
    expect(ran).toHaveLength(2);
    expect(ran[1]).toBe("pnpm --filter @kokpit/app dist");
    expect(w.err.join("")).toContain("sonraki adımlar çalıştırılmadı");
  });

  it("--dry-run prints the commands and runs nothing; --skip-build leaves the build out; --label reaches launchd", async () => {
    const dry = world();
    expect(await runCli(["--config", "/cfg/engine.json", "--dry-run", "--wait"], dry.deps)).toBe(0);
    expect(dry.ran).toEqual([]);
    expect(dry.out.join("")).toContain("$ KOKPIT_APP_SIGNING_DIR=/home/u/.config/kokpit/app-signing pnpm --filter @kokpit/app dist");
    expect(dry.out.join("")).toContain("hiçbir şey çalıştırılmadı");
    const skip = world();
    await runCli(["--config", "/cfg/engine.json", "--skip-build", "--label", "test.kokpit"], skip.deps);
    expect(skip.ran).toHaveLength(3);
    expect(skip.ran[2]).toContain("--label test.kokpit");
  });

  it("a config that cannot be read stops before anything runs", async () => {
    const w = world();
    expect(await runCli(["--config", "/nowhere.json"], w.deps)).toBe(1);
    expect(w.ran).toEqual([]);
  });

  it("the config is the engine's own: --config, else $KOKPIT_CONFIG, else ~/.config/kokpit/engine.json", () => {
    const base = { cwd: "/work", homedir: "/home/u", env: {} };
    expect(resolveConfigPath(base, "rel.json")).toBe("/work/rel.json");
    expect(resolveConfigPath({ ...base, env: { KOKPIT_CONFIG: "~/x.json" } }, undefined)).toBe("/home/u/x.json");
    expect(resolveConfigPath(base, undefined)).toBe("/home/u/.config/kokpit/engine.json");
    expect(resolveConfigPath({ ...base, env: { XDG_CONFIG_HOME: "/xdg" } }, undefined)).toBe("/xdg/kokpit/engine.json");
  });

  it("--wait: polls the engine until every app that connected reports the published build", async () => {
    const answers: ClientsAnswer[] = [
      { current, clients: [] },
      { current, clients: [client("mac-mini-app", OLD), client("macbook-app", OLD)] },
      { current, clients: [client("mac-mini-app", NEW, { outcome: "updated", outcomeBuildId: NEW }), client("macbook-app", OLD)] },
      { current, clients: [client("mac-mini-app", NEW), client("macbook-app", NEW)] },
    ];
    let i = 0;
    const w = world({
      clients: async (t) => {
        expect(t).toEqual({ host: "127.0.0.1", port: 7420, key: "the-key" });
        return answers[Math.min(i++, answers.length - 1)]!;
      },
    });
    expect(await runCli(["--config", "/cfg/engine.json", "--wait=60"], w.deps)).toBe(0);
    expect(i).toBe(4);
    expect(w.out.join("")).toContain("macbook-app");
    expect(w.out.join("")).toContain("bütün uygulamalar yeni derlemede");
  });

  it("--wait: an engine that is still restarting is asked again; time running out is exit 2, not an error", async () => {
    let calls = 0;
    const w = world({
      clients: async () => {
        if (calls++ < 2) throw new Error("ECONNREFUSED");
        return { current, clients: [client("macbook-app", OLD)] };
      },
    });
    expect(await runCli(["--config", "/cfg/engine.json", "--wait=10"], w.deps)).toBe(2);
    expect(w.err.join("")).toContain("süre doldu");
  });

  it("--wait: an app that rolled the new build back fails the deploy loudly", async () => {
    const w = world({ clients: async () => ({ current, clients: [client("macbook-app", OLD, { outcome: "rolledBack", outcomeBuildId: NEW })] }) });
    expect(await runCli(["--config", "/cfg/engine.json", "--wait=10"], w.deps)).toBe(1);
    expect(w.err.join("")).toContain("kuramadı");
  });
});

describe("wait rules", () => {
  it("nobody connected yet is waiting, not done", () => {
    expect(waitState({ current, clients: [] })).toBe("waiting");
    expect(waitState({ current: null, clients: [client("a-client-1", OLD)] })).toBe("waiting");
  });

  it("a rollback of an EARLIER build does not fail this deploy", () => {
    expect(waitState({ current, clients: [client("a-client-1", NEW, { outcome: "rolledBack", outcomeBuildId: "0.1.0+20261118110000.mid" })] })).toBe("done");
  });

  it("each app gets one readable line", () => {
    expect(describeClients({ current, clients: [client("a-client-1", NEW), client("b-client-2", OLD), client("c-client-3", OLD, { outcome: "failed", outcomeBuildId: NEW })] })).toEqual([
      `  a-client-1  ${NEW}  güncel`,
      `  b-client-2  ${OLD}  bekleniyor`,
      `  c-client-3  ${OLD}  KURAMADI (failed)`,
    ]);
  });
});

describe("engineTarget", () => {
  const base = { homedir: "/home/u", env: {} };
  const read = (files: Record<string, string>) => (p: string) => {
    if (files[p] === undefined) throw new Error("ENOENT");
    return files[p];
  };

  it("port from the config (else the default), key from env, config or the data dir's key file", () => {
    expect(engineTarget({ ...base, readFile: read({ "/c": JSON.stringify({ dataDir: "~/d", port: 9000 }), "/home/u/d/engine.key": "k1\n" }) }, "/c")).toEqual({ host: "127.0.0.1", port: 9000, key: "k1" });
    expect(engineTarget({ ...base, readFile: read({ "/c": JSON.stringify({ dataDir: "/d", key: "k2" }) }) }, "/c").key).toBe("k2");
    expect(engineTarget({ ...base, env: { KOKPIT_KEY: "k3" }, readFile: read({ "/c": "{}" }) }, "/c")).toEqual({ host: "127.0.0.1", port: 7420, key: "k3" });
    expect(() => engineTarget({ ...base, readFile: read({ "/c": JSON.stringify({ dataDir: "/d" }) }) }, "/c")).toThrow("engine key not found");
  });

  it.each(["192.168.1.5", "100.64.0.7", "mini.local"])("never runs the key's handshake with a non-loopback host (%s)", (host) => {
    expect(() => engineTarget({ ...base, env: { KOKPIT_KEY: "k3" }, readFile: read({ "/c": "{}" }) }, "/c", host)).toThrow(/loopback/);
  });
});
