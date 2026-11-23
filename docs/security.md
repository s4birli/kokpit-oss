# Security model

The engine runs commands and browsers as your user. Whoever can talk to it can do what you can, so the model is about
who can reach it and what it hands out.

## Reaching the engine

- **Listening.** The engine binds only to `127.0.0.1` (`listenLocalhost`) and to the Mac's Tailscale addresses
  (`listenTailscale`, re-scanned every `tailscaleRescanMs`). It never binds to a LAN address or `0.0.0.0`.
- **Mutual authentication.** App and engine share an access key of at least 32 random bytes (`<dataDir>/engine.key`,
  generated on first start, mode 0600, or `KOKPIT_KEY`). The handshake is an HMAC-SHA-256 challenge–response in both
  directions (`packages/shared/src/auth.ts`); the key never crosses the wire, replayed nonces are refused, and the
  client sends nothing until the engine has proven it holds the key too.
- **Connection gate.** The app connects only to this Mac, to an address Tailscale currently reports for a peer, or to
  a `wss://` URL (`packages/app/src/main/connection-gate.ts`). The key is stored in the macOS Keychain.
- **Known limit.** The handshake is not bound to the transport channel: someone able to relay traffic on an
  unprotected network path could relay a handshake. This is why plain addresses outside loopback and Tailscale are
  refused.

## What terminals and agents get

- Terminals never inherit the engine's key or its `KOKPIT_*` configuration variables.
- A terminal gets `KOKPIT_CDP_URL` (its project's Chrome) and, for `open`, a credential scoped to its own project that
  ends with the terminal.
- Each project's Chrome has its own profile, its DevTools port bound to `127.0.0.1`, and is never brought to the
  front. Anything running as your user can reach a DevTools port — the app says so before you fill a saved login
  while an agent is running in that project, and asks once per project for your acceptance.
- Saved login passwords live only in the engine Mac's Keychain; the protocol can write them but never read them back.

## Updates

App builds are signed with an Ed25519 publisher key that stays outside the repository
(`~/.config/kokpit/app-signing`, `scripts/publish-app.ts keygen`). The app verifies the signature and refuses
unsigned builds and downgrades.

## Files

Files are served read-only and only inside a project's folder; media and page previews go through short-lived,
single-purpose tokens. Symlinks out of the project are not followed.

## Reporting

See [SECURITY.md](../SECURITY.md).
