# Contributing

Thanks for your interest in Kokpit.

1. Open an issue first for anything larger than a small fix, so we can agree on the approach.
2. Fork, create a branch, and keep each commit focused (conventional messages: `feat(engine): …`, `fix(app): …`).
3. Write the failing test first, then the change. Keep settings out of the code (`*.defaults.json`).
4. Before opening a pull request run `pnpm typecheck` and `pnpm test:unit`; run the end-to-end tests
   (`docs/development.md`) when you touch the engine's processes, the browser or the app's windows.
5. Describe what changed and how you verified it.

Never commit keys, `engine.key`, signing material or personal data. Security issues go to the maintainers privately —
see [SECURITY.md](SECURITY.md).

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
