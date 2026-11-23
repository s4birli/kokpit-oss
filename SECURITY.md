# Security policy

Kokpit's engine runs commands and browsers with your user's rights, so security reports matter to us.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability reporting on this repository
(*Security › Report a vulnerability*). Include:

- what an attacker can do and from where (same Mac, the tailnet, a web page in a project's browser, …),
- the steps or a proof of concept,
- the version or commit you tested.

We aim to acknowledge a report within a week and to agree on a disclosure date with you once a fix is ready.

## Supported versions

Only the latest commit on the default branch is supported.

## Scope

The model the code defends is described in [docs/security.md](docs/security.md): who can reach the engine, what
terminals and agents receive, how updates are signed. Reports that break one of those promises are in scope.
