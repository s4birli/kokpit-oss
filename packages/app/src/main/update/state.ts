// Kendini güncelleme: what the updater remembers across launches (`<userData>/update/update-state.json`): the
// user's choice, the builds that failed here, and the update in flight — the journal the next launch recovers from.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { BuildIdSchema } from "@kokpit/shared";

const STATE_VERSION = 1;
const MAX_BAD_BUILDS = 50;
const CLIENT_ID_BYTES = 12;

const PendingSchema = z.object({
  /** ready = verified and unpacked, waiting for a restart; applying = handed to the swap helper. */
  phase: z.enum(["ready", "applying"]),
  buildId: BuildIdSchema,
  version: z.string(),
  /** The unpacked, verified bundle in the staging folder. */
  stagedBundle: z.string(),
  /** SHA-256 of the signed entry list it was written from (kept next to it; checked again before the swap). */
  entriesSha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** The build that was running when the update was staged (the one a rollback returns to). */
  fromBuildId: z.string(),
  /** Times the swap was started. */
  attempts: z.number().int().min(0),
});
export type PendingUpdate = z.infer<typeof PendingSchema>;

const LastSchema = z.object({
  outcome: z.enum(["updated", "rolledBack", "failed"]),
  buildId: BuildIdSchema,
  detail: z.string().optional(),
  /** Told to the engine (`app.update.report`). */
  reported: z.boolean(),
  /** Hidden by the user. */
  dismissed: z.boolean(),
});
export type LastOutcome = z.infer<typeof LastSchema>;

const StateSchema = z.object({
  version: z.literal(STATE_VERSION),
  /** Random id of this install, so the engine can tell its apps apart. */
  clientId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  /** Download and install by itself; off = only say that an update exists. */
  auto: z.boolean(),
  /** Builds that failed on this machine: never tried again. */
  badBuilds: z.array(z.object({ buildId: BuildIdSchema, reason: z.string(), at: z.string() })),
  verifyFailures: z.record(z.string(), z.number().int().min(0)),
  pending: PendingSchema.optional(),
  last: LastSchema.optional(),
  /**
   * The rollback floor: the build stamp (UTC yyyymmddHHMMSS) of the newest build ever installed AND healthy in this
   * profile. A signed update older than this is only offered; it needs the dedicated confirmation. Read as
   * max(this, the running build), so a lowered or garbled value changes nothing.
   */
  floorStamp: z.string().optional(),
  /** The one older build the user confirmed ("Eski sürüme dön"); nothing else below the floor goes through. */
  allowDowngradeTo: BuildIdSchema.optional(),
});
export type UpdateState = z.infer<typeof StateSchema>;

export function freshState(): UpdateState {
  return { version: STATE_VERSION, clientId: randomBytes(CLIENT_ID_BYTES).toString("base64url"), auto: true, badBuilds: [], verifyFailures: {} };
}

export interface StateStore {
  get(): UpdateState;
  /** Applies `change` to a copy and persists it (write + rename). */
  update(change: (draft: UpdateState) => void): UpdateState;
}

/** A missing or unreadable file starts fresh (auto on, a new client id) and is written at once. */
export function createStateStore(filePath: string): StateStore {
  let state: UpdateState;
  let existed = true;
  try {
    state = StateSchema.parse(JSON.parse(readFileSync(filePath, "utf8")));
  } catch {
    state = freshState();
    existed = false;
  }
  const persist = (): void => {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, filePath);
  };
  if (!existed) {
    try {
      persist();
    } catch {
      // A userData folder that cannot be written: the updater works from memory for this run.
    }
  }
  return {
    get: () => state,
    update(change) {
      const draft = structuredClone(state);
      change(draft);
      if (draft.badBuilds.length > MAX_BAD_BUILDS) draft.badBuilds = draft.badBuilds.slice(-MAX_BAD_BUILDS);
      state = StateSchema.parse(draft);
      persist();
      return state;
    },
  };
}

/** An in-memory store for tests. */
export function memoryStateStore(initial: UpdateState = freshState()): StateStore {
  let state = initial;
  return {
    get: () => state,
    update(change) {
      const draft = structuredClone(state);
      change(draft);
      state = StateSchema.parse(draft);
      return state;
    },
  };
}
