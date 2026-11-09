---
type: contract
title: Z.ai Coding Plan quota API and bb usage surfaces
description: Wire contract of the Z.ai/bigmodel quota-remaining endpoint (5-hour/weekly/MCP windows) and its mapping onto bb's provider/usage windows and provider.rateLimits deltas; live-verified on the zai family, bigmodel fixture-only.
status: stable
tags: [contract, usage, quota, coding-plan]
sources:
  - title: docs/coding-plan-quota-remaining-api.md at zai-org/ZCode a60ba6a
    resource: https://github.com/zai-org/ZCode/blob/a60ba6a/docs/coding-plan-quota-remaining-api.md
  - title: packages/services/src/usage-stats/providers/bigmodelUsageQuotaProvider.ts at a60ba6a
    resource: https://github.com/zai-org/ZCode/blob/a60ba6a/packages/services/src/usage-stats/providers/bigmodelUsageQuotaProvider.ts
  - title: packages/shared/src/usage-quota.ts and zcodeEndpoint.ts at a60ba6a
    resource: https://github.com/zai-org/ZCode/blob/a60ba6a/packages/shared/src/usage-quota.ts
  - title: SDK 0.6.49 providerUsageWindowSchema / provider.rateLimits delta (bundled-types)
    resource: ../../node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk-provider-bridge.d.ts
  - title: Quota fetch and window mapping implementation
    resource: ../../src/coding-plan.ts
  - title: provider/usage wiring and cache
    resource: ../../src/bridge.ts
generated:
  by: zcode-agent/GLM-5.3
  at: 2026-11-09T00:00:00Z
verified:
  - by: zcode-agent/GLM-5.3 (live probe through CodingPlanHost, GLM Coding Max)
    at: 2026-11-09T13:10:00Z
  - by: user (Provider usage panel shows the ZCode windows in an installed bb run)
    at: 2026-11-09T18:30:00Z
---

# Z.ai Coding Plan quota API and bb usage surfaces

Researched 2026-11-09 against upstream sync `a60ba6a` (CLI 0.17.1) and
implemented the same day. The zai family was exercised live through
`CodingPlanHost.usageWindows()` (GLM Coding Max: 5-hour/weekly/MCP windows
with real reset timestamps); the bigmodel family has fixture coverage only.

## Quota endpoint

```http
GET {origin}/api/monitor/usage/quota/limit
authorization: <Coding Plan API key>   (raw key, no Bearer prefix)
```

- `origin` follows the plan family and reuses the same origins as
  `src/coding-plan.ts` (`api.z.ai` for `zai`, `bigmodel.cn` for `bigmodel`).
  Upstream env overrides: `ZAI_BUSINESS_BASE_URL`, `BIGMODEL_API_BASE_URL`,
  and the full-URL `ZCODE_BIGMODEL_USAGE_QUOTA_URL` / `BIGMODEL_USAGE_QUOTA_URL`.
- Envelope: `{code?, msg?, success?, data: {level?, limits[]}}`; the plugin's
  existing 0/200-code envelope check applies.
- Each limit: `{type, unit?, number?, usage?, currentValue?, remaining?,
percentage?, nextResetTime?, usageDetails?[{modelCode?, usage?}]}`.
  `percentage` is **used** percent (display inverts to remaining);
  `nextResetTime` is epoch milliseconds.

Window identity (upstream dashboard matching rules):

| Window   | Match                                                   |
| -------- | ------------------------------------------------------- |
| 5-hour   | `type === "TOKENS_LIMIT" && unit === 3 && number === 5` |
| Weekly   | `type === "TOKENS_LIMIT" && unit === 6`                 |
| MCP time | `type === "TIME_LIMIT" && unit === 5 && number === 1`   |

Adjacent endpoints discovered but not wired: `/api/v1/coding-plan/reset`
(5h/weekly reset opportunities, status/use/history - the Desktop
"CodingPlanQuotaReset" feature) and the official-MCP quota provider with its
own credential source.

## bb surfaces

1. `provider/usage` (pull; wired to the quota endpoint since this change):
   `status: "ok"` + `accountEmail` + `planLabel` +
   `windows: [{label, usedPercent, resetsAt (ISO | null), cost?}]`. The
   installed bb 0.46 daemon validates `resetsAt`/windows, so the pipeline is
   live. Limits without a finite 0..100 `percentage` are omitted, not invented
   (the same honesty rule as stage-2 usage); `resetsAt` drops to `null` when
   `nextResetTime` is missing or stale.
2. **"Provider usage" panel federation** (the panel never calls
   `provider/usage` itself): bb's builtin provider-usage plugin discovers
   usage sources server-side via `experimental_discoverRpc` of
   `provider-usage.v1.listResources` and reads each with
   `provider-usage.v1.getResource`. Only plugins that register that contract
   with `experimental_discoverable: true` appear; the builtin provider
   plugins (codex, claude-code, acp) implement it, and `providers.list({
capability: "usage" })` (fed by the manifest's `maintenance.usage`) is
   display metadata, not a data source. Resources are
   `{accountKey: null, id: JSON([hostId, providerId]), providerId, label,
scope: {kind: "host", hostId, hostName}}`; windows carry the panel grammar
   (`kind: five-hour|daily|weekly|custom`, stable `id`, `model`, `cost`);
   measurements flow server → `system.usageLimits({hostId, providerId,
refresh})` → daemon `provider/usage` → the bridge quota fetch. The panel's
   plugin caches per resource and invalidates on `thread.idle`/`thread.failed`.
   Implemented in `src/usageSource.ts` (2026-11-09) after the first quota PR
   shipped windows that the panel could not see.
3. `provider.rateLimits` thread delta (push; still unused): a
   `subscription-window`-kind state with per-window `resetsAtMs` and
   `allowed/warning/blocked` status, plus the `rateLimited` provider-recovery
   kind. Upstream CLI classifies HTTP 429 as retryable rate-limited with
   `retryAfterMs` (`failure-classifier.ts`); a quota-exhausted turn failure is
   the natural trigger to push this state.
4. Per-turn `usage` and `contextWindow` deltas are already implemented in
   `src/usage.ts`; the contextWindow delta additionally accepts a rich
   `snapshot` (categories, `autoCompactAtTokens`) the plugin does not send yet.

## Implemented mapping (`src/coding-plan.ts`, `src/bridge.ts`)

- `quotaWindows(limits, now)` maps in a fixed display order: `5-hour window`
  (TOKENS_LIMIT/unit3/number5), `Weekly window` (TOKENS_LIMIT/unit6),
  `MCP quota` (TIME_LIMIT/unit5/number1); `usedPercent = percentage`
  (already used-percent), `resetsAt = ISO(nextResetTime)` only while it is in
  the future.
- `CodingPlanHost.usageWindows()` does one bounded GET with the short-lived
  project token via the shared `request()` plumbing and degrades to
  `undefined` on any account failure.
- The bridge fetches windows only from the `provider/usage` handler (never
  `model/list`/`provider/health`, which share `probe`), behind a single-slot
  cache keyed by the exact request payload with a 60 s TTL
  (`usageCacheTtlMs` test seam) so panel refreshes neither respawn the CLI
  probe nor re-query the account service.
- `src/usageSource.ts` registers the panel-facing `provider-usage.v1` source
  (contract in `src/usageContract.ts`, wired from `server.ts`): host-scoped
  resources for the zcode provider, window-grammar mapping by label, a 60 s
  observedAt cache with `refresh` bypass, and error usage states for
  disconnected hosts and failed collections. `src/usageSource.ts` takes
  injected deps; `tests/usage-source.test.ts` covers listing, mapping,
  caching, and degradation.
