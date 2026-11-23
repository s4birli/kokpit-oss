# Development

## Setup

```sh
corepack enable          # pnpm at the version in package.json
pnpm install             # also restores node-pty's spawn-helper exec bit (scripts/fix-node-pty.mjs)
```

Node 25 runs the engine's TypeScript directly (type stripping); there is no build step for the engine or `shared`.

## Checks

```sh
pnpm typecheck                                   # tsc in every package
pnpm test:unit                                   # shared + app unit tests, engine unit tests (src/)
pnpm vitest run --project engine                 # + engine end-to-end tests (real engine process, real Chrome)
pnpm --filter @kokpit/app test:e2e               # Electron end-to-end tests (Playwright `_electron`)
```

The end-to-end tests start their own engine on a free port with a temporary data dir and temporary Chrome profiles
(`browser.testMode`: mock keychain, basic password store). They never use `~/.config/kokpit`, your engine or your own
Chrome. Engine and app e2e tests need Google Chrome installed; the app e2e tests also open Electron windows.

## Running

```sh
KOKPIT_CONFIG=/path/to/engine.json pnpm --filter @kokpit/engine start
pnpm --filter @kokpit/app dev
```

Useful engine environment variables: `KOKPIT_CONFIG`, `KOKPIT_PORT`, `KOKPIT_DATA_DIR`, `KOKPIT_KEY`,
`KOKPIT_LOG_DEBUG=1`, `KOKPIT_FEATURES` (see below).

## Conventions

- **No hard-coded settings.** Ports, paths, timeouts, limits and names live in the `*.defaults.json` files next to the
  code that reads them and can be overridden in `engine.json`.
- **Validate at the boundary.** Every frame, config file and stored state is parsed with zod; anything unexpected is
  refused with a clear message.
- **Tests first.** Each module has unit tests with fakes (`packages/engine/test/fakes`), plus end-to-end tests against
  the real engine process.

## Optional modules

`kokpit.features.json` (repository root) is the build-time list of optional modules:

```json
{ "features": { "my-module": { "enabled": true, "methodPrefixes": ["myModule."], "requires": [] } } }
```

- Shared code asks `BUILD_FEATURES.isEnabled("my-module")` (`packages/shared/src/features.ts`).
- The engine creates the module in `main.ts` only when it is enabled, as an `EngineModule`
  (`packages/engine/src/engine-module.ts`): server dependencies, a project clean-up hook, a launch-preparation hook,
  a shutdown hook. Requests whose method starts with one of its prefixes answer `UNKNOWN_METHOD` when it is off.
- The app registers a module's panels only when it is enabled (`PANEL_ENTRIES` with a `feature` in
  `packages/app/src/renderer/ui/layout/registry.ts`).
- `KOKPIT_FEATURES=a,b` narrows the set for one engine run; an empty value turns every module off. An unknown name, or
  a module whose `requires` is off, stops the engine at start.

This edition ships with an empty feature list.
