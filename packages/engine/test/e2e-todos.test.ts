// End-to-end for Yapılacaklar (Adım 6) against the real engine: two clients see each other's
// changes through events, todos and notes survive a restart, and unfinished todos roll over to
// the next day (engine clock pinned with KOKPIT_TEST_NOW, zone pinned with TZ).
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Todo } from "@kokpit/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_NOW_ENV } from "../src/todos.ts";
import { Client, startEngine, stopEngine, type EngineProc } from "./harness.ts";

const KEY = randomBytes(32).toString("base64url");
const ZONE = "Europe/Istanbul";
const DAY1 = "2026-11-16";
const DAY1_NOW = "2026-11-16T20:30:00Z"; // 23:30 in Istanbul
const DAY2 = "2026-11-17";
const DAY2_NOW = "2026-11-16T21:30:00Z"; // 00:30 next day in Istanbul

let root: string;
let home: string;
let configPath: string;
let engine: EngineProc | undefined;

const start = (now: string) => startEngine({ KOKPIT_CONFIG: configPath, KOKPIT_KEY: KEY, HOME: home, TZ: ZONE, [TEST_NOW_ENV]: now });
const connect = () => Client.connect(engine!.port, KEY);

type List = { date: string; todos: Todo[] };

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-e2e-todos-")));
  home = join(root, "home");
  mkdirSync(home, { recursive: true });
  configPath = join(root, "engine.json");
  writeFileSync(
    configPath,
    JSON.stringify({ dataDir: join(root, "data"), port: 0, shell: "/bin/sh", shellArgs: [], listenTailscale: false }),
  );
  engine = await start(DAY1_NOW);
  // Like the other suites: never start the seeded global default tool (claude) in a terminal here.
  const c = await connect();
  await c.req("settings.update", { defaultToolId: null });
  await c.close();
}, 30000);

afterAll(async () => {
  await stopEngine(engine);
  rmSync(root, { recursive: true, force: true });
});

describe("yapılacaklar end-to-end", () => {
  let first: Todo;
  let second: Todo;

  it("a todo created on one client reaches the other through todos.changed", async () => {
    const a = await connect();
    const b = await connect();
    expect(await a.req<List>("todos.list", {})).toEqual({ date: DAY1, todos: [] });
    ({ todo: first } = await a.req<{ todo: Todo }>("todos.create", { text: "Faturayı öde" }));
    await b.waitFor((f) => f.type === "event" && f.name === "todos.changed");
    const seen = await b.req<List>("todos.list", {});
    expect(seen.todos.map((t) => t.text)).toEqual(["Faturayı öde"]);
    ({ todo: second } = await b.req<{ todo: Todo }>("todos.create", { text: "Bitti bile" }));
    await b.req("todos.update", { id: second.id, done: true });
    await b.req("todos.update", { id: second.id, order: 0 });
    const list = await a.req<List>("todos.list", {});
    expect(list.todos.map((t) => [t.text, t.done, t.order])).toEqual([
      ["Bitti bile", true, 0],
      ["Faturayı öde", false, 1],
    ]);
    await a.close();
    await b.close();
  });

  it("notes are shared and announced with notes.changed", async () => {
    const a = await connect();
    const b = await connect();
    expect(await a.req("notes.set", { text: "Bugünün notu" })).toEqual({ date: DAY1, text: "Bugünün notu" });
    await b.waitFor((f) => f.type === "event" && f.name === "notes.changed" && f.date === DAY1);
    expect(await b.req("notes.get", {})).toEqual({ date: DAY1, text: "Bugünün notu" });
    await a.close();
    await b.close();
  });

  it("refuses invalid requests without dropping the connection", async () => {
    const c = await connect();
    await expect(c.req("todos.create", { text: "  " })).rejects.toMatchObject({ code: "INVALID" });
    await expect(c.req("todos.create", { text: "x", projectId: "yok" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(c.req("todos.update", { id: "yok", done: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(c.req("notes.set", { text: "x".repeat(20_001) })).rejects.toMatchObject({ code: "INVALID" });
    await expect(c.req("todos.list", { date: "2026-02-30" })).rejects.toMatchObject({ code: "INVALID" });
    expect((await c.req<List>("todos.list", {})).todos).toHaveLength(2);
    await c.close();
  });

  it("a restart keeps todos and notes", async () => {
    await stopEngine(engine);
    engine = await start(DAY1_NOW);
    const c = await connect();
    const list = await c.req<List>("todos.list", {});
    expect(list.todos.map((t) => t.id)).toEqual([second.id, first.id]);
    expect(await c.req("notes.get", {})).toEqual({ date: DAY1, text: "Bugünün notu" });
    await c.close();
  });

  it("on the next local day the unfinished todo rolls over; the done one and the note stay behind", async () => {
    await stopEngine(engine);
    engine = await start(DAY2_NOW);
    const a = await connect();
    const b = await connect();
    const today = await a.req<List>("todos.list", {});
    expect(today.date).toBe(DAY2);
    expect(today.todos).toEqual([expect.objectContaining({ id: first.id, date: DAY2, rolledFrom: DAY1, done: false })]);
    await b.waitFor((f) => f.type === "event" && f.name === "todos.changed");
    const yesterday = await b.req<List>("todos.list", { date: DAY1 });
    expect(yesterday.todos.map((t) => t.id)).toEqual([second.id]);
    expect(await b.req("notes.get", {})).toEqual({ date: DAY2, text: "" });
    expect(await b.req("notes.get", { date: DAY1 })).toEqual({ date: DAY1, text: "Bugünün notu" });
    await a.req("todos.delete", { id: first.id });
    expect((await b.req<List>("todos.list", {})).todos).toEqual([]);
    await a.close();
    await b.close();
  });
});
