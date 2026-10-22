---
type: contract
title: Protocol contracts
description: The three external contracts the plugin must honor (bb provider bridge, ZCode native protocol, marketplace catalog), their pinned versions, and the translation rules between them.
status: stable
stale_after: 2027-01-20T00:00:00Z
tags: [contract, protocol, versions]
sources:
  - title: package.json at 3dc639d
    resource: https://github.com/dpolishuk/bb-zcode/blob/3dc639de8e7926b2460059dcf20156950fc7f2d3/package.json
  - title: server.ts at 3dc639d
    resource: https://github.com/dpolishuk/bb-zcode/blob/3dc639de8e7926b2460059dcf20156950fc7f2d3/server.ts
  - title: src/protocol.ts at 3dc639d
    resource: https://github.com/dpolishuk/bb-zcode/blob/3dc639de8e7926b2460059dcf20156950fc7f2d3/src/protocol.ts
  - title: docs/validation.md at 3dc639d (versions and reference snapshots)
    resource: https://github.com/dpolishuk/bb-zcode/blob/3dc639de8e7926b2460059dcf20156950fc7f2d3/docs/validation.md
  - title: bb upstream at 9937c46 (v0.5.0 contract refresh)
    resource: https://github.com/get-bb/bb/tree/9937c46f5c7e369de3563eb864c8cbc4c3b9c231
  - title: ZCode upstream at 0a1fc56 (v0.5.0 contract refresh)
    resource: https://github.com/zai-org/ZCode/tree/0a1fc56d279fd1001f78387bd81aec1c26767411
  - title: Current model identity and context-budget translation
    resource: ../../src/protocol.ts
  - title: Native model identity and budget regression tests
    resource: ../../tests/protocol.test.ts
  - title: Catalog, connectivity, and follow-up regressions
    resource: ../../tests/core-features.test.ts
generated:
  by: zcode-agent/GLM-5.3
  at: 2026-10-20T11:15:00Z
verified:
  - by: zcode-agent/GLM-5.3
    at: 2026-10-20T11:15:00Z
  - by: zcode-agent/GLM-5.3
    at: 2026-10-20T11:23:47Z
  - by: Codex
    at: 2026-10-22T11:22:00Z
---

# Protocol contracts

The plugin sits between three contracts. Version drift in any of them is the
most common reason this code needs to change; re-verify this document against
the sources when `stale_after` passes or an upstream release lands.

## Contract parties

| Boundary            | Contract                                          | Verified baseline                                           | Upstream source                                                                                   |
| ------------------- | ------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| bb ↔ plugin         | Provider bridge protocol 2, delta grammar 3 (SDK) | SDK `@get-bb/plugin-sdk` 0.6.49                             | [bb @ 9937c46](https://github.com/get-bb/bb/tree/9937c46f5c7e369de3563eb864c8cbc4c3b9c231)        |
| plugin ↔ ZCode CLI  | "ZCode Protocol" version 1 over stdio JSON lines  | CLI 0.17.0 (app 3.16.2), macOS; 0.16.9 in the v0.5.0 record | [ZCode @ 0a1fc56](https://github.com/zai-org/ZCode/tree/0a1fc56d279fd1001f78387bd81aec1c26767411) |
| marketplace catalog | bb marketplace schema v2 (generated)              | `marketplace.json` at repo HEAD                             | [docs/marketplace.md](../../docs/marketplace.md)                                                  |

Engine ranges (`package.json`): Node `>=22` (24+ recommended for use), bb
`>=0.46`, SDK `>=0.6.49 <0.7`. The runtime baseline above comes from
[docs/validation.md](../../docs/validation.md), which pins the exact reference
snapshots.

## bb provider bridge

- All request schemas come from the SDK's `provider-bridge` module; plugin code
  must stay on the SDK's public import surfaces (also enforced by a
  public-SDK-only import scan in the test suite).
- Provider capabilities are declared once in [server.ts](../../server.ts):
  `fork: "checkpoint"`, native user questions and manual compaction supported;
  thread archive/rename and service tiers not supported; permission modes
  `accept-edits`, `auto`, `full`.
- The `reasoningLevels` list in the capabilities declaration is only bb's
  coarse validation ladder; `model/list` supplies each model's actual choices
  (comment in `server.ts`).

## ZCode native protocol

- Transport is newline-delimited JSON over stdio. ZCode frames deliberately
  carry **no `jsonrpc` field** (bb's frames do) - `src/client.ts`.
- The child is launched as `app-server --stdio --surface terminal`
  (`src/launch.ts`).
- v0.5.0 uses read-only v4 row queries (`v4/conversation/rowsRange`) and
  compare-and-swap commands for history management, while the legacy session
  stream remains **the only prompt lane** (`src/lifecycle.ts`). No full v4
  fragmented-subscription decoder or physical replay transport is claimed.
- ZCode's own source labels this session API legacy while it migrates its
  desktop protocol; a future CLI may require adapter changes (recorded in
  [docs/validation.md](../../docs/validation.md)).
- **Re-verification 2026-10-20**: the installed app updated to 3.16.2 with CLI
  bundle **0.17.0** (`zcode` no longer on PATH; the plugin's macOS bundle
  fallback resolves it). `npm run test:live` against 0.17.0 reported
  `RUNTIME_VERIFIED`, exit 0, negotiated protocol still version 1, with
  checkpoints/forks, background work, file rollback, Coding Plan, and
  bb-tool/skill/subagent paths passing. Upstream `main` still declares
  `ZCODE_PROTOCOL_VERSION = 1` with the legacy session methods present under
  deletion-boundary comments and v4 wire version 3 coexisting - the legacy
  API has not been removed yet, but the documented migration risk stands. The
  protocol method and v4 command surfaces are unchanged versus the 0a1fc56
  pin (110 methods, none added or removed), so the
  [capability audit](../../docs/capability-audit.md) inventory is current.

## Translation rules

- **Model IDs** cross the bridge as `providerId/modelId`. The sentinel
  `zcode-default` maps to the native current model; anything else without a
  `/` separator is rejected (`src/protocol.ts`).
- **Reasoning fallback**: a requested or saved reasoning level that the
  selected model does not list falls back to the native default level, as
  required by bb's bridge contract (`modelForTurn` in `src/protocol.ts`).
- **Context-budget aliases** are allocated from the native catalog, scoped
  to a provider. The allocator reserves every native identity, including
  disabled entries and the current native selection. `model-256k` is the
  usual alias for a 256,000-token reporting budget; collisions use
  `model-bb-context-256k`, then numbered alternatives. Sorted allocation makes
  aliases independent of native catalog ordering. Listing, prompt dispatch,
  context reporting and connectivity checks use the same mapping; a real or
  unknown suffixed model ID is never stripped just because of its suffix.
- **Reported context windows** prefer positive finite model metadata over
  the native projection's pre-bind default. Windows for known provider/model
  identities come from session creation or resume: CLI 0.17.0's `session/read`
  replaces those values with its 200K projection default, so projection
  refreshes retain the discovered windows. A new/resumed session refreshes
  them from the catalog. Advertised budget variants are
  smaller than the native window and reuse the base model's reasoning
  choices. A saved variant remains resolvable if window metadata shrinks or
  is missing, and never enlarges a known native window. The budget caps bb's
  meter and usage fields; it does not constrain native inference or
  compaction. Selection lifetime is defined by
  [Session invariants](../architecture/session-invariants.md#context-selection-lifetime).
- **Permission modes** (`modeFor` in `src/bridge.ts`):

  | bb side                 | ZCode mode |
  | ----------------------- | ---------- |
  | Plan composer action    | `plan`     |
  | `accept-edits` / `auto` | `build`    |
  | `full`                  | `yolo`     |

- These are agent approval policies, not an OS sandbox; the CLI runs with the
  host account's permissions.

## Marketplace catalog contract

`marketplace.json` is generated from `package.json` branding and
`PLUGIN_OVERVIEW.md` by `npm run marketplace:build`; `npm run marketplace:check`
guards against drift and CI enforces it. After changing either source, the
committed catalog must be regenerated in the same change
([docs/marketplace.md](../../docs/marketplace.md)).

## Related knowledge

- Model identity and reporting-window rules were re-verified on 2026-10-22:
  protocol/bridge regressions and the real CLI 0.17.0 loopback fixture passed,
  including cold resume and native background follow-ups. This refresh does
  not change the historical upstream pins above; see the dated
  [validation record](../../docs/validation.md).
- How the modules implement these contracts: [System overview](../architecture/system-overview.md).
- What a contract change must re-verify: [Change verification](../runbooks/change-verification.md).
