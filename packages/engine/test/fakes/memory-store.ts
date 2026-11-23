// The one in-memory StateStore for all engine tests. It is the real store logic
// (same validation, same copy semantics) without the file, so the fake never
// drifts from the contract.
import type { StateStore } from "../../src/contracts.ts";
import { createMemoryStore } from "../../src/store.ts";

export interface MemoryStore extends StateStore {}

export class MemoryStore {
  constructor() {
    Object.assign(this, createMemoryStore());
  }
}
