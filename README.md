# Kokpit

Kokpit is a cockpit for working with coding agents on a Mac. A small **engine** runs on an always-on Mac (a Mac mini,
say) and owns everything that must keep running: Claude Code and other terminals, git worktrees, and a separate
Chrome for every project. An **Electron app** — on the same Mac or on a laptop — is only the screen and keyboard:
close it, reopen it, connect from another machine, and every terminal and browser is still where you left it.

<!-- Screenshots: add images under docs/images/ and reference them here. -->

## What you get

- **Projects and cards.** A project is a local folder, a GitHub clone or a folder on an SSH host. A *card* is a git
  worktree on its own branch, so several agents can work on one repository side by side.
- **Terminals that outlive the app.** Tabbed terminals per project or card, run by the engine. Reconnecting replays
  the history first, then streams live output. Tools (Claude Code, Codex, Gemini, your own commands) are configured
  under *Settings › Tools* and start a terminal with one click; the app shows which agent is running, idle or waiting
  for you.
- **A Chrome per project.** Each project gets its own Chrome profile on the engine Mac, streamed into the app's
  browser panel: tabs, Chrome-like zoom, saved logins (passwords stay in the engine Mac's Keychain). Agents in the
  project's terminals drive the same Chrome (`KOKPIT_CDP_URL`, Playwright MCP). Links and file paths printed in a
  terminal — and `open page.html` — open in that browser.
- **Files and media.** Browse a project's files; video, audio, images and PDFs open inside the app.
- **Copy and paste everywhere** between terminals, the browser panel and your machine.
- **Background agents.** `claude agents` sessions are listed, with a "waiting for you" section; they use the project's
  Chrome too.
- **Claude usage** per Claude account (config dir), counted from local session transcripts (numbers only).
- **To-dos, flow diagrams and a project map**, and a layout per project that the app remembers.
- **Self-update.** The engine publishes signed app builds; connected apps update themselves.

## Requirements

- macOS (Apple silicon tested) for the engine; the app runs on macOS.
- [Node.js](https://nodejs.org/) 25 and [pnpm](https://pnpm.io/) 11 (`corepack enable` picks the version in
  `package.json`).
- Google Chrome installed in `/Applications` on the engine Mac (path configurable).
- Optional: [Tailscale](https://tailscale.com/) to reach the engine from another machine. Without it, run the app on
  the engine Mac itself.

## Install

```sh
git clone https://github.com/s4birli/kokpit-oss kokpit
cd kokpit
pnpm install
pnpm typecheck && pnpm test:unit
```

## Run the engine

The engine reads `~/.config/kokpit/engine.json` (or the file named by `KOKPIT_CONFIG`). The only required field is
`dataDir`, where it keeps its state, terminal buffers, worktrees, browser profiles and access key:

```json
{
  "dataDir": "~/Library/Application Support/Kokpit",
  "port": 7420,
  "language": "en"
}
```

`language` (`en` or `tr`) is the engine's language for its own messages; the app has its own setting under
*Settings › Language*.

Everything else has defaults in `packages/engine/*.defaults.json`; see `packages/engine/config.example.json`.

```sh
pnpm --filter @kokpit/engine start          # in the foreground
node packages/engine/scripts/launchd.ts install --config ~/.config/kokpit/engine.json   # as a launchd service
```

On first start the engine creates a random access key in `<dataDir>/engine.key` (or takes `KOKPIT_KEY`). It listens
only on `127.0.0.1` and on this Mac's Tailscale addresses — never on the LAN.

## Connect the app

```sh
pnpm --filter @kokpit/app dev     # development
pnpm --filter @kokpit/app dist    # a packaged Kokpit.app in packages/app/dist
```

Enter the engine's address (`127.0.0.1:7420` on the same Mac, or its Tailscale address) and the access key. The app
keeps the key in the macOS Keychain.

## Security model (summary)

- The engine binds to loopback and Tailscale addresses only.
- App and engine authenticate each other with an HMAC challenge–response over the shared key (at least 32 random
  bytes); the key itself never crosses the wire.
- The app connects only to this Mac, to an address Tailscale currently vouches for, or to a `wss://` URL.
- App updates are signed with an Ed25519 publisher key; unsigned or older builds are refused.
- Terminals never inherit the engine's key or its `KOKPIT_*` settings. Each project's Chrome has its own profile and
  its DevTools port is bound to `127.0.0.1`.

Details: [docs/security.md](docs/security.md). Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Deploy and update

On the engine Mac, one command builds the app, signs and publishes it, and restarts the engine; connected apps then
update themselves:

```sh
node packages/engine/scripts/publish-app.ts keygen     # once: the publisher key, kept outside the repository
pnpm deploy:local
```

## Documentation

- [docs/architecture.md](docs/architecture.md) — packages, processes and the wire protocol
- [docs/security.md](docs/security.md) — the security model in detail
- [docs/development.md](docs/development.md) — building, testing and the optional-module layout

## License

[MIT](LICENSE)
