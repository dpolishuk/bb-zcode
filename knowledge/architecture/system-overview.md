---
type: architecture
title: System overview
description: Entry points, the per-thread supervised ZCode process, and the responsibility of each source module of the bb-zcode plugin.
status: stable
tags: [architecture, bridge, plugin]
sources:
  - title: server.ts at 3dc639d
    resource: https://github.com/dpolishuk/bb-zcode/blob/3dc639de8e7926b2460059dcf20156950fc7f2d3/server.ts
  - title: src/host.ts at 3dc639d
    resource: https://github.com/dpolishuk/bb-zcode/blob/3dc639de8e7926b2460059dcf20156950fc7f2d3/src/host.ts
  - title: src/bridge.ts at 3dc639d
    resource: https://github.com/dpolishuk/bb-zcode/blob/3dc639de8e7926b2460059dcf20156950fc7f2d3/src/bridge.ts
  - title: src/launch.ts at 3dc639d
    resource: https://github.com/dpolishuk/bb-zcode/blob/3dc639de8e7926b2460059dcf20156950fc7f2d3/src/launch.ts
  - title: README "How it works" at 3dc639d
    resource: https://github.com/dpolishuk/bb-zcode/blob/3dc639de8e7926b2460059dcf20156950fc7f2d3/README.md
generated:
  by: zcode-agent/GLM-5.3
  at: 2026-10-20T11:15:00Z
verified:
  - by: zcode-agent/GLM-5.3
    at: 2026-10-20T11:15:00Z
---

# System overview

The plugin is a protocol adapter with two process boundaries: bb on one side
(through the published plugin SDK) and a supervised ZCode CLI child process on
the other. The user-facing picture, including the protocol diagram, is in the
[README](../../README.md#how-it-works); this document maps the code.

## Entry points

`package.json` declares two entries under its `bb` field:

- `server` → [server.ts](../../server.ts) runs inside bb. It defines the eight
  plugin settings (with zod-backed `experimental_schema` validation), registers
  the `zcode` provider with its capabilities and model fallback, and
  re-registers whenever settings change. It never launches a child process.
- `host` → [src/host.ts](../../src/host.ts) defines the provider bridge worker.
  `createBridge()` is constructed eagerly but performs no child spawn or I/O
  until a request arrives (stated in a code comment and enforced by
  `createBridge`'s lazy session handling).

## Process and session model

- One supervised ZCode child process per bb thread. Each `Session` record in
  [src/bridge.ts](../../src/bridge.ts) owns its `ZCodeConnection`, account
  host, timeline, usage, v4 history, background-work tracker, follow-up queue,
  tool server, and skills catalog.
- Every bb method is validated against the SDK's zod schemas (`initialize`,
  `model/list`, `provider/health`, `thread/*`, `turn/*`, `skills/configure`)
  before dispatch.
- Empty sessions are marked non-restorable (ZCode does not persist them until a
  turn starts); saved conversations resume by native session ID.
- Settings changes re-register the provider; because launch settings become
  part of `experimental_bridgeOptions`, the bridge fingerprint changes and bb
  invalidates the old model catalog (comment in `server.ts`).

## Module map

| Module               | Responsibility                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| `src/bridge.ts`      | Session orchestration and bb ↔ ZCode translation; the largest module (~1500 lines)                          |
| `src/client.ts`      | `ZCodeClient`: JSON-lines stdio child, split-UTF-8-safe framing, request timeouts, exit/error surfacing     |
| `src/launch.ts`      | Executable resolution and child argv/env construction (`app-server --stdio --surface terminal`)             |
| `src/protocol.ts`    | Zod schemas for native snapshots/events, model-selection resolution, fallback model, runtime preferences    |
| `src/lifecycle.ts`   | Bounded v4 history queries, checkpoint token encode/resolve, background work, provider management commands  |
| `src/coding-plan.ts` | Individual Coding Plan host: desktop credential exchange, short-lived project tokens, official MCP identity |
| `src/timeline.ts`    | Native events → bb thread deltas and tool presentation                                                      |
| `src/input.ts`       | Prompt/attachment preparation: local files, data URLs, bounded HTTPS images, follow-up queueing             |
| `src/usage.ts`       | Token/cache/reasoning usage aggregation and context estimates                                               |
| `src/tool-server.ts` | Opt-in authenticated loopback MCP endpoint exposing bb plugin tools to ZCode                                |
| `src/skills.ts`      | bb skill catalog: names, descriptions, absolute SKILL.md paths                                              |
| `src/subagents.ts`   | Validation of the native subagent configuration snapshot                                                    |
| `src/settings.ts`    | `mcpServers` setting parsing and runtime settings assembly                                                  |

## Executable resolution order

`resolveLaunch` in [src/launch.ts](../../src/launch.ts) resolves the CLI in
this order: explicit `executable` setting → `BB_ZCODE_EXECUTABLE` env →
`zcode` on `PATH` → the macOS app bundle
`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`. Script bundles
(`.cjs`/`.mjs`/`.js`) run through `nodeExecutable`; the launcher strips
`ELECTRON_RUN_AS_NODE` and pins `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` and
`ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` so account-overlay revisions stay aligned
with the desktop catalog.

## Related knowledge

- External boundaries and their pinned versions: [Protocol contracts](../contracts/protocol-contracts.md).
- Behaviors the bridge must preserve: [Session invariants](session-invariants.md).
