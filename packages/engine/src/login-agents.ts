// Girişler: "is an agent running in this project right now?" — as far as the engine can tell.
//
// What this is NOT: a statement that the project's browser is out of an agent's reach. The browser's DevTools port
// is a loopback port every program of this user can connect to — project and card terminals (KOKPIT_CDP_URL),
// background Claude sessions (the address the engine writes into the project's Claude settings file), agents of
// other projects, anything else. That is why the per-project acceptance of the agent risk is ALWAYS required
// before the first fill (logins.ts), whatever this returns.
//
// What it is for: when the answer is yes, the warning says so ("şu anda bu projede çalışan ajan var") and every
// single fill needs a fresh confirmation. Not knowing counts as yes.
export interface AgentPresenceDeps {
  /** Terminals of the project, its cards' terminals included — any tool, any location. */
  terminalCount(projectId: string): number;
  /** Known background Claude sessions; `projectId` = the project whose folder (or a card worktree of it) the session runs in. */
  bgSessions(): Promise<readonly { projectId?: string | undefined }[]>;
}

export async function agentsPresentIn(projectId: string, deps: AgentPresenceDeps): Promise<boolean> {
  if (deps.terminalCount(projectId) > 0) return true;
  try {
    return (await deps.bgSessions()).some((s) => s.projectId === projectId);
  } catch {
    return true;
  }
}
