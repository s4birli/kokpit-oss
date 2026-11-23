// Girişler — in-memory logins.* for FakeEngineClient. Like the engine: the list holds metadata only, a save with the
// same site and username replaces, and a fill is refused unless the "open page" (`pageOrigin`) is the login's site.
// What the UI sent is kept in `saved` / `filled` for assertions; no handler ever returns a password.
import { type LoginFillField, type LoginPolicy, type ParamsOf, type ResultOf, type SavedLogin } from "@kokpit/shared";
import { EngineRequestError } from "../../engine/types.ts";

type LoginMethod = "logins.list" | "logins.save" | "logins.delete" | "logins.fill" | "logins.risk.set";
type Handlers = { [M in LoginMethod]: (params: ParamsOf<M>) => ResultOf<M> };

export const FAKE_LOGIN_TIME = "2026-01-01T00:00:00.000Z";

export function makeLogin(id: string, projectId: string, origin: string, username: string, extra: Partial<SavedLogin> = {}): SavedLogin {
  return { id, projectId, origin, username, createdAt: FAKE_LOGIN_TIME, updatedAt: FAKE_LOGIN_TIME, ...extra };
}

export class FakeLogins {
  items: SavedLogin[] = [];
  /** Origin of the page the fake browser shows; a fill of another site's login is refused. */
  pageOrigin = "";
  fields: LoginFillField[] = ["username", "password"];
  /** Every logins.save as the UI sent it (password included — this is the engine's side of the wire). */
  readonly saved: ParamsOf<"logins.save">[] = [];
  readonly filled: string[] = [];
  /** Engine policy: Keychain mode, and whether something that can drive the browser runs right now. */
  keychainAccess: LoginPolicy["keychainAccess"] = "confirm";
  agentsPresent = false;
  /** Projects whose agent risk the user accepted. */
  readonly accepted = new Set<string>();
  policy(projectId: string): LoginPolicy {
    return { keychainAccess: this.keychainAccess, agentRiskAccepted: this.accepted.has(projectId), agentsPresent: this.agentsPresent };
  }
  private next = 0;

  readonly handlers: Handlers = {
    "logins.list": ({ projectId }) => ({ logins: this.items.filter((l) => l.projectId === projectId).map((l) => ({ ...l })), policy: this.policy(projectId) }),
    "logins.risk.set": ({ projectId, accepted }) => {
      if (accepted) this.accepted.add(projectId);
      else this.accepted.delete(projectId);
      return { policy: this.policy(projectId) };
    },
    "logins.save": (p) => {
      this.saved.push(p);
      const existing = this.items.find((l) => l.projectId === p.projectId && l.origin === p.origin && l.username === p.username);
      const login = existing ?? makeLogin(`login-${++this.next}`, p.projectId, p.origin, p.username);
      if (p.label !== undefined) login.label = p.label;
      if (!existing) this.items.push(login);
      return { login: { ...login } };
    },
    "logins.delete": ({ id }) => {
      if (!this.items.some((l) => l.id === id)) throw new EngineRequestError("NOT_FOUND", "Giriş bulunamadı");
      this.items = this.items.filter((l) => l.id !== id);
      return {};
    },
    "logins.fill": ({ projectId, id, confirmAgentRisk }) => {
      const login = this.items.find((l) => l.id === id && l.projectId === projectId);
      if (!login) throw new EngineRequestError("NOT_FOUND", "Giriş bulunamadı");
      // Like the engine: it enforces the acceptance, whatever the UI did.
      if (!this.accepted.has(projectId) || (this.agentsPresent && confirmAgentRisk !== true)) {
        throw new EngineRequestError("LOGIN_RISK_UNACCEPTED", "Bu tarayıcıyı ajanlar da sürebiliyor; doldurulan şifreyi okuyabilirler.");
      }
      if (login.origin !== this.pageOrigin) {
        throw new EngineRequestError("INVALID", `Bu giriş ${login.origin} için kayıtlı; açık sayfa ${this.pageOrigin}. Hiçbir alan doldurulmadı.`);
      }
      this.filled.push(id);
      return { filled: [...this.fields] };
    },
  };
}
