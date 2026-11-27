# Security policy

## Reporting a vulnerability

Please don't open a public issue for a security problem. Report it privately through GitHub
instead: go to the [Security tab](https://github.com/Gradiated/grad/security) and click
**Report a vulnerability**, or open
[a new advisory](https://github.com/Gradiated/grad/security/advisories/new) directly. Only the
maintainers can see it.

A good report says what is affected (server, trainer, an SDK, the CLI, the Helm chart or a
published image), the version or commit, how to reproduce it, and what an attacker gains.

We'll acknowledge the report within three working days, keep you posted while we fix it, and
credit you in the advisory unless you'd rather stay anonymous. Please give us a reasonable
window to ship a fix before you disclose it publicly.

## Supported versions

`grad` is pre-1.0. Security fixes go into the latest release only; upgrade to get them.

## Scope

In scope: everything in this repository and the artifacts we publish from it (`grad-sdk` on
PyPI and crates.io, `@gradiated/grad` on npm, `grad-cli`, the Go module, the
`ghcr.io/gradiated/*` images and the Helm chart).

The hosted Gradiated Cloud service runs this code too, so a vulnerability here usually affects
it as well. Report it the same way. Please don't test against other people's data or run load
or denial-of-service tests against the hosted service.
