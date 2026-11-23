// İş C — Harita: WebSocket request handlers. The HTTP side lives in MapService.handleHttp.
import type { ParamsOf, Project, ResultOf } from "@kokpit/shared";
import { engineError } from "../contracts.ts";
import type { MapService } from "../map.ts";

export interface MapHandlerDeps {
  /** Absent = maps disabled (e.g. server unit tests): never available. */
  map: MapService | undefined;
  requireProject(projectId: string): Project;
}

export function createMapHandlers(deps: MapHandlerDeps) {
  return {
    "map.info": (_ctx: unknown, p: ParamsOf<"map.info">): ResultOf<"map.info"> => {
      const project = deps.requireProject(p.projectId);
      return deps.map ? deps.map.info(project) : { available: false };
    },
    "map.token": (_ctx: unknown, p: ParamsOf<"map.token">): ResultOf<"map.token"> => {
      const project = deps.requireProject(p.projectId);
      if (!deps.map) throw engineError("INVALID", "engine.handlers.map.off");
      return deps.map.issueToken(project);
    },
  };
}
