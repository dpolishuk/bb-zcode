---
type: runbook
title: Change verification
description: Which checks to run for which kind of change, what CI runs, and the boundary between synthetic and live verification.
status: stable
tags: [runbook, testing, ci]
sources:
  - title: package.json scripts at 3dc639d
    resource: https://github.com/dpolishuk/bb-zcode/blob/3dc639de8e7926b2460059dcf20156950fc7f2d3/package.json
  - title: .github/workflows/ci.yml at 3dc639d
    resource: https://github.com/dpolishuk/bb-zcode/blob/3dc639de8e7926b2460059dcf20156950fc7f2d3/.github/workflows/ci.yml
  - title: CONTRIBUTING.md at 3dc639d
    resource: https://github.com/dpolishuk/bb-zcode/blob/3dc639de8e7926b2460059dcf20156950fc7f2d3/CONTRIBUTING.md
  - title: docs/validation.md at 3dc639d
    resource: https://github.com/dpolishuk/bb-zcode/blob/3dc639de8e7926b2460059dcf20156950fc7f2d3/docs/validation.md
generated:
  by: zcode-agent/GLM-5.3
  at: 2026-10-20T11:15:00Z
verified:
  - by: zcode-agent/GLM-5.3
    at: 2026-10-20T11:15:00Z
  - by: zcode-agent/GLM-5.3
    at: 2026-10-20T11:23:47Z
---

# Change verification

How to prove a change works before opening a PR. The contribution rules in
[CONTRIBUTING.md](../../CONTRIBUTING.md) are authoritative; this runbook maps
change types to checks and records the evidence boundaries.

## Checks by change type

| Change                                                | Checks                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------- |
| Any code under `src/` or `server.ts`                  | `npm run typecheck` and `npm test`                                  |
| Protocol translation, lifecycle, or approval behavior | Add focused tests first; then `npm test` (required by CONTRIBUTING) |
| `package.json` branding or `PLUGIN_OVERVIEW.md`       | `npm run marketplace:build`, then `npm run marketplace:check`       |
| Markdown, docs, knowledge base                        | `npm run format:check`                                              |
| Everything, before opening a PR                       | `npm run check` and `npm run format:check`                          |

`npm run check` = `marketplace:check` + `typecheck` + `test` + `build`. The
build step needs bb's CLI; on a machine without the desktop app install the
pinned builder with `npm install --no-save --ignore-scripts bb-app@0.46.1`.

## What CI runs

[ci.yml](../../.github/workflows/ci.yml) (Ubuntu, Node 24) runs, in order:
`npm ci --ignore-scripts`, `format:check`, `marketplace:check`, `typecheck`,
`test`, then installs `bb-app@0.46.1` and `build`. Hosted CI **does not** run
the live CLI smoke.

## Live and installed-bb checks

- `npm run test:live` starts the installed ZCode CLI with an isolated `HOME`,
  synthetic provider configuration, and a deterministic loopback model server.
  It never uses real model credentials and is optional for documentation-only
  changes.
- The full bb smoke additionally needs a **disposable bb instance**
  (`BB_SMOKE_SERVER_URL`, `BB_SMOKE_DATA_DIR`, optionally
  `BB_HOST_DAEMON_PORT`). It changes that instance's ZCode executable setting;
  never target a normal bb profile. The invocation template is in
  [docs/validation.md](../../docs/validation.md).

## Verification boundaries

Keep these distinctions explicit in PR descriptions and validation records
(they come from [docs/validation.md](../../docs/validation.md) and
[docs/capability-audit.md](../../docs/capability-audit.md)):

- Synthetic tests validate adapter behavior, not the native CLI's engines.
- A model catalog or healthy protocol probe is **not** proof of authenticated
  model connectivity.
- Real-CLI fixtures use deterministic loopback inference; paid production
  inference, personal-provider authentication, and Linux/Windows operation
  remain unverified.
- `npm audit` and formatting are part of the release record, not proof of
  runtime behavior.

## Current baseline

At commit `3dc639d` (2026-10-20): `npm run typecheck` clean; `npm test`
**138 tests in 11 files, all passing** (matches the v0.5.0 validation record);
`npm run format:check` and `npm run marketplace:check` pass. The build step was
not re-run locally for this knowledge change; CI covers it on push.

Compatibility re-check the same day against the installed app **3.16.2 / CLI
bundle 0.17.0** (auto-updated after the v0.5.0 validation): `npm run
test:live` reported `RUNTIME_VERIFIED` with exit 0, protocol "ZCode Protocol"
version 1, 27 synthetic model requests, all direct-CLI, bridge,
checkpoint/fork, background-work, file-rollback, Coding Plan, and
tool/skill/subagent checks passing. `bbThreadVerified` was false only because
the opt-in disposable-bb environment variables were not set.

v0.6.0 (rich tool rows, 2026-10-20): `npm run check` passed end to end on
this machine for the first time (the desktop bb CLI supplies the builder) -
**144 tests in 11 files**, marketplace consistency, typecheck, formatting,
and the plugin build; `npm run test:live` again reported `RUNTIME_VERIFIED`
with exit 0 against CLI 0.17.0.

## Related knowledge

- Failure meanings and reproduction fixtures: [Diagnostics](diagnostics.md).
- Contracts a change may break: [Protocol contracts](../contracts/protocol-contracts.md).

v0.7.0 (provider usage and `/zcode-check`, 2026-10-20): **148 tests in 11
files**, marketplace consistency, typecheck, formatting and the plugin build
all green; the live smoke stays `RUNTIME_VERIFIED` against CLI 0.17.0.

v0.8.0 (bb-local archive/rename and goal clearing, 2026-10-20): **151 tests
in 11 files**, full `npm run check` and the live smoke green. The bb 0.46.1
runtime asar was inspected to confirm it does not yet send
`thread/archive|unarchive|name/set|goal/clear` requests.

v0.9.0 (`/zcode-plugin` management commands, 2026-10-20): **155 tests in 11
files**, full `npm run check` and the live smoke green.

v0.9.1 (actionable host-service errors, 2026-10-20): **156 tests in 11
files**, full `npm run check` and the live smoke green.

v0.9.2 (custom provider icon, 2026-10-20): **156 tests in 11 files**, full
`npm run check` and the live smoke green; the icon follows bb's bundled-plugin
`icons/*.svg` convention and the catalog uses the schema's `{url}` form.
