---
type: decision
title: Feature roadmap toward fuller ZCode coverage
description: Prioritized plan for closing the audited capability gaps, grounded in what the installed bb SDK 0.6.49 actually supports.
status: stable
tags: [roadmap, decision, contracts]
sources:
  - title: docs/capability-audit.md at 2ec3261 (gap matrix and 2026-10-20 re-check)
    resource: https://github.com/dpolishuk/bb-zcode/blob/2ec3261507ad1a79196f4e03d828278d8e1201e5/docs/capability-audit.md
  - title: bb provider-bridge contracts in the installed SDK 0.6.49
    resource: https://github.com/get-bb/bb/tree/9937c46f5c7e369de3563eb864c8cbc4c3b9c231
  - title: src/timeline.ts rich-row mapping (v0.6.0)
    resource: ../../src/timeline.ts
generated:
  by: zcode-agent/GLM-5.3
  at: 2026-10-20T19:20:36Z
verified:
  - by: zcode-agent/GLM-5.3
    at: 2026-10-20T19:20:36Z
---

# Feature roadmap toward fuller ZCode coverage

Decided 2026-10-20 after re-diffing the ZCode protocol surface (no upstream
drift; see [Protocol contracts](../contracts/protocol-contracts.md)) and
inspecting the installed `@get-bb/plugin-sdk` 0.6.49. Key finding: **bb's
contracts are wider than the plugin uses**, so several audited "missing"
items are plugin-limited, not bb-limited.

bb-side mechanisms confirmed in the SDK:

- Bridge methods not yet used: `thread/archive`, `thread/unarchive`,
  `thread/name/set`, `thread/goal/clear`, `provider/usage`.
- Rich item shapes: `fileChange`, `fileRead`, `search`, `webSearch`,
  `webFetch`, `planSteps`, `delegation`, `backgroundTask` (plus shipped
  presentation builders).
- Main plugin API: a desktop **browser host** (`BrowserCommandSchema`,
  `browser.find/reload/focusLocation`), rich plugin UI (fixed tabs, panels,
  timeline/diff renderers), storage, RPC, background services.

## Stage 1 — rich tool rows (done in v0.6.0)

`src/timeline.ts` maps native Edit/Write/Read/Grep/Glob/WebSearch/WebFetch/
TodoWrite/Task onto the rich item shapes. Failures and interruptions fall
back to the generic tool row so errors stay visible; unknown tools are
unchanged. Remaining presentation gaps: full unified-diff views (bb renders
`oldText`/`newText` itself), richer delegation summaries.

## Stage 2 — honest provider maintenance (done in v0.7.0)

`provider/usage` now answers from sessionless discovery: account status plus
the active individual Coding Plan subscription label (captured in
`src/coding-plan.ts`), with empty windows rather than invented numbers.
`/zcode-check [providerId/modelId]` runs the native
`provider/testModelConnectivity` on demand - one real model request, no
session prompt - and health guidance points to it.

## Stage 3 — lifecycle parity (done in v0.8.0)

`thread/archive`, `thread/unarchive` and `thread/name/set` are implemented as
bb-local acks - the native legacy protocol has no title or archive API, and
title generation stays off, so bb owns names and archive state. Verified in
the installed bb 0.46.1 runtime that it does not send these requests yet (the
schemas are forward compatibility); the handlers define behavior for future
bb versions. `thread/goal/clear` maps to the native `session/goal` clear
action and requires the thread's active session. Native goal state is not
mirrored into bb timeline deltas (no native goal push events); that remains
follow-up work with the v4 snapshot surface.

## Stage 4 — native plugin management commands (done in v0.9.0)

`/zcode-plugin list|install|update|uninstall|enable|disable|marketplace
add|update|remove` maps onto the native `plugins/*` methods following the
`/zcode-tasks` pattern: idle foreground, no model prompt, explicit errors for
malformed commands, bounded output that renders only fields native replies
carry. The documented trust boundary: operations mutate ZCode's own plugin
configuration inside its trust boundary, with no bridge-side review. Long
operations use a 120 s native request timeout; async operation polling
(`plugins/operationProgress`) is not bridged yet.

## Stage 5 — browser control: blocked on bb, errors shipped (v0.9.1)

Conclusion (2026-10-20): bb's provider bridge has **no host-service channel**

- `BRIDGE_REQUEST_METHODS` (SDK 0.6.49) is the complete bb→bridge surface and
  carries no browser/host RPCs, and the main SDK's browser APIs
  (`ExperimentalDesktopBrowsersArea` etc.) serve plugin UI webview contexts,
  not provider bridge workers. Full bridging therefore waits on an upstream
  bb extension - requested in [get-bb/bb#6008](https://github.com/get-bb/bb/issues/6008)
  (2026-10-20). What shipped in v0.9.1: `interaction/browserList|Execute`,
  `automation/*`, `offPeak/*`, `bot/channel/reply` and `mcp/ui*` reverse RPCs
  are rejected uniformly with an actionable message pointing to ZCode
  Desktop. The remaining design option that does not need bb is a
  self-hosted CDP browser provider inside the plugin - a security-sensitive
  decision (browser launch, permissions, lifecycle) that needs explicit
  maintainer approval before any implementation.

## Stage 6 — automations and Off-Peak mapping

Choose between mapping native `automation/*`/`offPeak/*` onto bb's own
automations (inter-plugin RPC) or persisting schedules in plugin storage.
Full native-scheduler parity is not promised.

## Stage 7 — MCP Apps / Gen UI (experimental)

Map `mcp/ui*` (16 methods) onto bb plugin UI surfaces (fixed tabs, browser
pages). Long-term; upstream itself limits interactive pages.

## Stages 6-7 — same upstream blocker

Automations/Off-Peak (stage 6) and MCP Apps / Gen UI (stage 7) hit the same
wall: they are CLI→host reverse RPCs with no channel through the provider
bridge. They are covered by the same upstream request
([get-bb/bb#6008](https://github.com/get-bb/bb/issues/6008)); no further
plugin-side work is possible until bb answers.

## Out of scope for this plugin

Start/Team/Highspeed plans (need real accounts to verify), full subagent
tree (possible later via native `sessionsIndexReconcile`), desktop-only
features (GUI computer use, remote SSH/WSL management) with no bb host
equivalents.

Each stage follows the audit's verification ladder: SDK contract tests, a
real-CLI fixture check, and an installed-bb run before release claims.
