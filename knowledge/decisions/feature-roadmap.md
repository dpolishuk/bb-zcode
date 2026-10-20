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

## Stage 2 — honest provider maintenance

Use `provider/usage` and native `provider/testModelConnectivity` so health
stops being "protocol responds" and quotas/identity become queryable. Small,
self-contained; update the health caveat in
[docs/configuration.md](../../docs/configuration.md) when done.

## Stage 3 — lifecycle parity

Implement `thread/archive`/`thread/unarchive`/`thread/name/set` (bb methods
exist; flip the `supportsThreadArchive/Rename` capability flags) and bridge
`session/goal` to `thread/goal/clear` (replace the `threadGoalClear: false`
answer in `src/bridge.ts`).

## Stage 4 — native plugin management commands

Add `/zcode-plugin list|install|update|...` provider commands mapping to the
20 `plugins/*` methods, following the `/zcode-tasks` management-command
pattern (idle foreground, no model prompt). Operations mutate ZCode's own
configuration - document that trust boundary.

## Stage 5 — browser control via the bb desktop browser host

Stop rejecting `interaction/browserList`/`browserExecute` and translate them
to bb's browser host. The bridge→bb request channel already exists
(`item/tool/call`); design the permission model first (pages, screenshots).
Largest integration; needs installed-bb verification.

## Stage 6 — automations and Off-Peak mapping

Choose between mapping native `automation/*`/`offPeak/*` onto bb's own
automations (inter-plugin RPC) or persisting schedules in plugin storage.
Full native-scheduler parity is not promised.

## Stage 7 — MCP Apps / Gen UI (experimental)

Map `mcp/ui*` (16 methods) onto bb plugin UI surfaces (fixed tabs, browser
pages). Long-term; upstream itself limits interactive pages.

## Out of scope for this plugin

Start/Team/Highspeed plans (need real accounts to verify), full subagent
tree (possible later via native `sessionsIndexReconcile`), desktop-only
features (GUI computer use, remote SSH/WSL management) with no bb host
equivalents.

Each stage follows the audit's verification ladder: SDK contract tests, a
real-CLI fixture check, and an installed-bb run before release claims.
