# Knowledge log

## 2026-10-24 (v0.11.0, feat/off-peak branch)

- **Added** Idle-time (off-peak) task host, completing roadmap stage 6:
  `src/offpeak.ts` implements the Z.ai ticket-gateway flow (take/batch
  status/settle with double auth = desktop JWT + individual Coding Plan key,
  both already read by `CodingPlanHost`), a workspace-scoped `offpeak.json`
  store separate from automations (native domain separation), upstream
  failure classification (3101/3103/session-bound before spending quota),
  server-directed polling, a settle outbox, and dispatch that passes the
  hidden idle-plan provider per run through `modelExecution.requestAuth`
  (no reverse-RPC auth needed - key architectural finding) with
  `toolDenylist: [CronCreate, OffPeakCreate]` and `offPeakRunType`
  init/resume including the native continuation prompt on 3102. Setting
  `offPeakTasksEnabled` gates both the tools (`offPeakToolEnabled` on
  create/resume) and the host. Contract pinned in
  [off-peak protocol](contracts/off-peak-protocol.md) (draft: live gateway
  behavior unverified - fixtures only). 9 focused tests incl. dispatch-level
  and the 3102 continuation loop.

## 2026-10-24

- **Verified** Live end-to-end automation run on the installed bb (v0.10.1,
  real individual Coding Plan inference): scheduler start on the first
  post-setting session construct, busy-turn deferral, dispatch with the
  native `automationId` marker into the bound thread, and `maxRuns: 1`
  lifecycle (`runCount: 1` → `completed`, `nextRunAt` cleared). First
  non-synthetic model request verified through the plugin. Tool-driven
  `CronCreate` from a model turn remains unverified live (the creating
  session predated the setting); store CRUD, the limit and workspace
  scoping carry automated coverage. Recorded in
  [validation](../docs/validation.md).

## 2026-10-23 (v0.10.1 review fixes)

- **Fixed** Four defects found in a full review of the v0.10.0 automation
  host: (1) a dispatch racing an active turn deferred instead of counting a
  failure strike (three strikes killed schedules of users who typed at fire
  time); (2) run reservations could freeze a schedule forever when the store
  became unreadable or a record lacked its session binding - early-exit
  paths now release via `retryRun`; (3) `completeRun` computes `nextRunAt`
  defensively: a schedule whose cron no longer parses is marked `failed`
  with `Invalid schedule` instead of redispatching every tick; (4) the store
  is workspace-scoped like the native per-workspace index - list/update/
  delete/binding-check/`/zcode-automations` see only the invoking session's
  workspace, cross-workspace ids read as unknown, while the scheduler still
  serves all workspaces. Also documented: runs are at-least-once across
  bridge-worker restarts (native records `claimed` before executing; ours
  records after completion). Regression coverage in
  tests/automations.test.ts (15 tests).

## 2026-10-23 (v0.10.0)

- **Added** Plugin-side automation host (roadmap stage 6 done):
  `src/automations.ts` answers the five `automation/*` native reverse RPCs
  from a JSON store in `BB_BRIDGE_DIR` (host daemon's per-plugin
  `bridge-data` dir), mirroring the upstream schemas pinned 2026-10-23
  (interval carriers → `scheduleRule`, relative one-shots, `maxRuns`,
  20-task limit with `AUTOMATION_CREATE_LIMIT_REACHED`, permanent
  one-task-per-session binding, fail-closed on an unparsable store). The
  bridge-worker scheduler cold-resumes the bound session with saved
  provider options/model/mode and the `session/send` `automationId` marker;
  settle() reports run outcome. Gate: `automationsEnabled` (default off)
  also denylists `CronCreate/CronList/CronUpdate/CronDelete` at
  create/resume when off. Constraint learned: the CLI attaches
  `automationPort` unconditionally for local sessions, so the tools were
  already model-visible before this change. Off-Peak stays unregistered
  (`offPeakToolEnabled` never passed). Focus: tests/automations.test.ts
  (store + dispatch-level). [Feature roadmap](decisions/feature-roadmap.md)
  and [capability audit](../docs/capability-audit.md) updated.

## 2026-10-23

- **Amended** [ZCode Desktop host boundary](decisions/zcode-desktop-host-boundary.md)
  after a user-reported gap: the first version missed the open server
  surface. `zcode --web` (specs/zcode-unified-distribution.md) runs a local
  HTTP/WS server hosting its own `app-server --stdio` Agent, and the host
  side of the protocol is open in `packages/services`
  (`zcodeAgentService` handlers, `AutomationService`/`OffPeakTaskService`).
  Assembly is host-injected: `browserControlExecutor` and the scheduler
  wake-up come from a Desktop-grade host, so `zcode --web` without Desktop
  still lacks browser/scheduler. Corrected the "only bb#6008 or a Z.ai API"
  claim: plugin-side assembly of the open implementations is a real third
  path for automation/Off-Peak (browser stays on the stage 5 CDP decision);
  attaching to `zcode --web` as a client is a fourth, architectural option.
  [Feature roadmap](decisions/feature-roadmap.md) stage 6 now references the
  open implementations.
- **Added** [ZCode Desktop host boundary](decisions/zcode-desktop-host-boundary.md):
  rejected the "attach to the running Desktop over RPC" alternative for
  host-service features. Evidence from the installed Desktop 3.16.2 bundle
  and live sockets: host/scheduler processes bind ephemeral loopback ports
  (`listen(0, "127.0.0.1")`), addresses are handed only to Desktop-launched
  sessions via launch-scoped handles (`pluginAuthority`/`bundleId`/`pid`),
  and peers are validated (`MACH_PORT_RENDEZVOUS_PEER_VALIDATION`,
  `ZCODE_CUA_BROKER_ALLOW_ANY_PEER` exists only as a dev override). The only
  externally shared surface remains files (`~/.zcode` sign-in,
  `~/.zcode/cli/config.json` MCP inheritance), which the plugin already
  consumes. Unblock paths stay [get-bb/bb#6008](https://github.com/get-bb/bb/issues/6008)
  or a documented Z.ai host API; [Feature roadmap](decisions/feature-roadmap.md)
  stage 5 now links the decision.

## 2026-10-22

- **Added** Icon provenance in v0.9.8: `icons/README.md` records that both
  marks reproduce the official Z.ai logo
  (<https://z-cdn.chatglm.cn/z-ai/static/logo.svg>, path data verbatim) and
  why the badge filename must change with artwork: bb caches catalog icons
  by asset URL, so only a new URL refreshes the store listing. The v0.9.2
  hand-drawn Z and its v0.9.3/v0.9.4 geometry fixes are superseded; the
  provider mark keeps the currentColor convention (bb inlines provider
  marks, so `<img>`-style currentColor loss does not apply).

- **Updated** [Protocol contracts](contracts/protocol-contracts.md): context
  budgets use a deterministic provider-scoped alias table that reserves native
  model identities; suffixes alone never authorize rewriting a model ID.
- **Updated** [Session invariants](architecture/session-invariants.md): reporting
  selections survive settlement and resume for native background follow-ups,
  change only after accepted submissions, and do not enforce native budgets.
  Regression coverage is linked from both documents.
- **Verified** The isolated CLI 0.17.0 fixture returns 1M model metadata from
  `session/create`, then 200K for the same identity from `session/read`.
  Discovery windows must survive projection refreshes; both base and budget
  reporting have focused regressions for this native behavior.
- **Verified** PR #1's candidate passed 175 automated tests, its direct CLI
  fixture and a fresh disposable-bb installation fixture. The latter verified
  installed 1M reporting, checkpoint fork/rewind and background controls with
  synthetic inference; see [validation](../docs/validation.md) for scope.
- **Updated** [Change verification](runbooks/change-verification.md): mocked
  sessionless probes must supply an executable explicitly, because launch
  resolution runs before client injection. Local ZCode discovery can otherwise
  hide a dependency absent on Linux CI.

## 2026-10-20

- **Added** Initial OKF v0.2 bundle: this index,
  [system overview](architecture/system-overview.md) and
  [session invariants](architecture/session-invariants.md),
  [protocol contracts](contracts/protocol-contracts.md), and the
  [change verification](runbooks/change-verification.md) and
  [diagnostics](runbooks/diagnostics.md) runbooks.
- **Verified** All documents were cross-checked against commit `3dc639d`; at
  that commit `npm run typecheck`, `npm test` (138 tests, 11 files),
  `npm run format:check`, and `npm run marketplace:check` passed (2026-10-20).
- **Verified** Compatibility re-check with ZCode: the installed app updated to
  3.16.2 (CLI bundle 0.17.0, `zcode` off PATH, plugin bundle fallback works);
  `npm run test:live` returned `RUNTIME_VERIFIED` / exit 0 with protocol
  version 1; upstream `main` still keeps the legacy session API. Updated
  [protocol contracts](contracts/protocol-contracts.md) and
  [change verification](runbooks/change-verification.md).
- **Updated** Recorded the upstream no-drift re-check (110 methods unchanged
  versus 0a1fc56) and the confirmed remaining feature gaps in
  docs/capability-audit.md; noted surface stability in
  [protocol contracts](contracts/protocol-contracts.md).
- **Added** [Feature roadmap](decisions/feature-roadmap.md): the installed bb
  SDK 0.6.49 is wider than the plugin used (archive/rename/goal bridge
  methods, rich item shapes, a desktop browser host, plugin UI), with a
  staged plan to close the audited gaps.
- **Updated** v0.6.0 rich tool rows implemented in `src/timeline.ts`
  (Edit/Write/Read/Grep/Glob/WebSearch/WebFetch/TodoWrite/Task mapped to
  rich bb rows; failures fall back to generic rows). Baseline updated in
  [change verification](runbooks/change-verification.md) (144 tests, full
  `npm run check`, live smoke green); new text caps recorded in
  [session invariants](architecture/session-invariants.md).
- **Updated** v0.7.0 honest provider maintenance: `provider/usage` answered
  from sessionless discovery (status + Coding Plan label, no invented
  numbers) and `/zcode-check` added to run the native connectivity test on
  demand. Stage 2 marked done in the
  [feature roadmap](decisions/feature-roadmap.md); baseline and bounds
  updated.
- **Updated** v0.8.0 lifecycle parity: bb-local archive/unarchive/rename acks
  and `thread/goal/clear` → native `session/goal` clear. Stage 3 marked done
  in the [feature roadmap](decisions/feature-roadmap.md) with the bb-0.46.1
  runtime finding; baseline updated to 151 tests.
- **Updated** v0.9.0 native plugin management: `/zcode-plugin` family mapped
  onto `plugins/*` with explicit errors, bounded honest rendering and the
  trust boundary documented. Stage 4 marked done in the
  [feature roadmap](decisions/feature-roadmap.md); baseline 155 tests.
- **Updated** v0.9.1: native host-service ports (browser, automation,
  Off-Peak, topics, MCP Apps) now fail with actionable messages; stage 5 of
  the [feature roadmap](decisions/feature-roadmap.md) recorded as blocked on
  bb with SDK evidence (no host-service channel in the bridge protocol).
- **Added** Upstream feature request
  [get-bb/bb#6008](https://github.com/get-bb/bb/issues/6008): a host-service
  channel in the provider bridge, with SDK evidence and the concrete native
  ports. Stages 5-7 of the [feature roadmap](decisions/feature-roadmap.md)
  now track this issue as their unblock condition.
- **Added** Custom provider mark in v0.9.2: `icons/zcode.svg` - a bold
  angular Z with slash-cut terminals in ZCode's monochrome style, rendered as
  a themed currentColor mask; the marketplace catalog carries it as a plugin
  asset URL instead of the Terminal glyph.
- **Fixed** v0.9.3 provider mark: the initial Z polygon was self-touching
  (a vertex lay on its own edge), so fill rules rendered only hairline
  slivers. Rebuilt as three simple overlapping shapes; verified at 512 px
  and 64 px.
- **Fixed** v0.9.4 provider mark geometry: terminal cuts are now parallel and
  lean the same way as the ZCode app mark (top-left and bottom-right tips
  lead), with reference-matched bar and diagonal weights.
