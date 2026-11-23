import { EngineRequestError } from "../engine/types.ts";

export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

export function isDisconnected(err: unknown): boolean {
  return err instanceof EngineRequestError && err.code === "DISCONNECTED";
}
