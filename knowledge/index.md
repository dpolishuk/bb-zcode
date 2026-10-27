---
okf_version: "0.2"
---

# bb-zcode knowledge base

Agent-oriented engineering knowledge for this repository, maintained in
[Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/ad30107c31c06aec8a7d5636e0d1058118604e6f/SPEC.md).
It distills what the source, tests, and validation records establish; it does
not replace the user-facing [README](../README.md) or [docs/](../docs/).

## Architecture

- [System overview](architecture/system-overview.md) - Entry points, the per-thread supervised ZCode process, and the responsibility of each `src/` module.
- [Session invariants](architecture/session-invariants.md) - Behaviors every change must preserve: explicit failure, context-selection lifetime, credential containment, and hard numeric bounds.

## Contracts

- [Protocol contracts](contracts/protocol-contracts.md) - The bb bridge, ZCode native protocol, and marketplace catalog contracts, with pinned versions, native model identities and context-budget translation rules.
- [Off-peak protocol](contracts/off-peak-protocol.md) - The undocumented Z.ai idle-time ticket gateway (wire shapes, idle-plan per-run execution, 3102 continuation) and the plugin design derived from it; draft until live-gateway verification.
- [Dynamic workflow protocol](contracts/dynamic-workflow-protocol.md) - POC-verified wire contract for ZCode dynamic workflows on CLI 0.17.0: gate params, tool family, skill gate, approval shape, the `causalityGraph` display payload, the task-notification wake turn, the cross-process `workflows/runs` read API, and the live-status sources (projection background jobs + v4 run journal events); draft - one happy path exercised.

## Decisions

- [Feature roadmap](decisions/feature-roadmap.md) - Prioritized plan for closing the audited capability gaps, grounded in what the installed bb SDK actually supports; stage 1 (rich tool rows) shipped in v0.6.0, stage 6 automations in v0.10.0, off-peak in v0.11.0; stages 8 (dynamic workflow launch, v0.12.0) and 9 (timeline graph v0.13.0; live lamps + hub/pane v0.14.0) shipped.
- [ZCode Desktop host boundary](decisions/zcode-desktop-host-boundary.md) - Why the plugin cannot proxy Desktop's host services by attaching to the running app: ephemeral loopback ports, launch-scoped handles and peer validation (investigated 2026-10-23, ZCode Desktop 3.16.2).

## Runbooks

- [Change verification](runbooks/change-verification.md) - Which checks to run for which change, what CI runs, and the synthetic/live verification boundary.
- [Diagnostics](runbooks/diagnostics.md) - Error-message ownership map, reproduction fixtures, and interpretation rules.

## Source material outside the bundle

Large documents are referenced, not duplicated:

- [README](../README.md) - product overview, install paths, compatibility.
- [docs/configuration.md](../docs/configuration.md) - settings, permissions, background work, troubleshooting.
- [docs/validation.md](../docs/validation.md) - dated validation record with versions and evidence.
- [docs/capability-audit.md](../docs/capability-audit.md) - feature matrix with evidence labels.
- [docs/marketplace.md](../docs/marketplace.md) - marketplace sources and catalog maintenance.
- [CONTRIBUTING.md](../CONTRIBUTING.md) and [CHANGELOG.md](../CHANGELOG.md) - workflow rules and release history.

Update history: [log.md](log.md).
