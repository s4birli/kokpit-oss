# Architecture

Kokpit is a pnpm monorepo with three packages:

| Package | Runs where | What it is |
| --- | --- | --- |
| `packages/shared` | both | The wire protocol (zod schemas, `protocol.ts`), the handshake (`auth.ts`), URL and path rules, update signing, the build's feature set (`features.ts`) |
| `packages/engine` | the engine Mac | A Node process (TypeScript run directly by Node's type stripping) that owns terminals (node-pty), cards (git worktrees), per-project Chromes (DevTools protocol), files, logins, background agents and app updates |
| `packages/app` | any Mac | An Electron app (React renderer, main process, preload) that shows everything and holds no state of its own beyond its window layout and the engine address |

```
┌──────────────┐  WebSocket (JSON frames)   ┌──────────────────── engine Mac ─────────────────────┐
│ Kokpit app   │ ─────────────────────────▶ │ engine ── terminals (shells, Claude Code, …)         │
│ (Electron)   │   loopback or Tailscale    │        ── one Chrome per project (headless, CDP)     │
└──────────────┘                            │        ── git worktrees, files, Keychain, updates    │
                                            └──────────────────────────────────────────────────────┘
```

## Engine

`src/main.ts` loads the config (`config.ts`: defaults JSON < `engine.json` < env), creates the services and hands them
to `src/server.ts`, which serves the WebSocket and a few token-protected HTTP routes (media streaming, local page
previews, the project map, app downloads). Every service implements an interface in `src/contracts.ts`, so each can be
tested with fakes. Request handlers live in `src/handlers/`.

- **Terminals** (`pty.ts`, `buffer.ts`, `activity.ts`): a pty per terminal with a ring buffer; a reconnecting client
  gets the history as numbered `output` frames, then live output. `activity.ts` decides whether the agent in a terminal
  is running, idle or waiting for you (patterns per tool).
- **Launch** (`launch.ts`, `tools.ts`): what a terminal starts — an explicit command, a tool, the project's or the
  global default, or a plain shell — locally or over SSH.
- **Browser** (`browser*.ts`, `cdp.ts`): one Chrome per project with its own profile and DevTools port, screencast
  frames to the app with backpressure (`frame-gate.ts`), input, tabs, zoom, copy/paste, saved logins (`logins.ts`,
  passwords in the macOS Keychain via `security`).
- **Files and paths** (`files*.ts`, `local-paths.ts`, `terminal-open.ts`): read-only browsing, media streaming, and
  the `open` shim terminals get so that `open page.html` shows the page in the project's browser.
- **Claude** (`claude-*.ts`, `bg-agents.ts`): Claude accounts (config dirs), the project's skills/agents/commands,
  background sessions (`claude agents`), and usage counted from local transcripts.
- **Updates** (`app-updates.ts`, `scripts/publish-app.ts`, `scripts/deploy-local.ts`): signed app builds published
  by the engine and fetched by the apps.

### Optional modules

`kokpit.features.json` lists optional modules and the request-method prefixes they own. `src/engine-module.ts` is the
seam: a module contributes server dependencies, a project clean-up hook, a launch-preparation hook and a shutdown
hook, and `main.ts` creates a module only when its feature is enabled (`KOKPIT_FEATURES` can narrow the set at run
time). A request owned by a disabled feature answers `UNKNOWN_METHOD`, exactly as if the module were absent. This
edition ships with no optional modules; the seam is there for your own.

## App

- `src/main/` — the Electron main process: windows, menus, the connection gate (which addresses the app may connect
  to), the key in the Keychain, web views, self-update.
- `src/preload/` — the narrow bridge the renderer gets (`window.kokpit…`).
- `src/renderer/` — React UI: `engine/client.ts` (the WebSocket client with reconnects), `ui/Workbench.tsx` and the
  panel registry in `ui/layout/` (terminals, browser, files, Claude, to-dos, map, flows…), settings in `ui/settings/`.

## Protocol

One WebSocket per app window, JSON text frames (`packages/shared/src/protocol.ts`):

1. Mutual authentication (`auth.ts`): `auth.hello` → `auth.challenge` → `auth.proof` → `hello.ok` (with the engine's
   proof). Nothing else is sent before the client has verified the engine.
2. Requests (`req` → `res` with the same id), fire-and-forget `input` / `resize`, stream acks.
3. Engine pushes: `output`, `exit`, `event`, and screencast frames.

Every frame is validated with zod on both sides; unknown methods are answered with `UNKNOWN_METHOD` so a newer app
keeps working against an older engine.
