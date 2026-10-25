---
type: contract
title: Off-Peak protocol and plugin design (draft, feat/off-peak branch)
description: The upstream off-peak wire contract (tickets, idle-plan execution, continuation) and the staged plugin design derived from it. Draft until the feature ships and is verified.
status: draft
stale_after: 2027-02-01T00:00:00Z
tags: [contract, off-peak, zcode, host-services]
sources:
  - title: Upstream spec (docs/off-peak-task/spec.md, main 2026-10-24)
    resource: https://github.com/zai-org/ZCode/blob/main/docs/off-peak-task/spec.md
  - title: packages/services/src/session/offPeakTaskService.ts, offPeakServerClient.ts, offPeakRuntimeModel.ts
    resource: https://github.com/zai-org/ZCode/tree/main/packages/services/src/session
  - title: packages/desktop/src/host/index.ts dispatchOffPeakRun + offPeakDispatchPlan.ts
    resource: https://github.com/zai-org/ZCode/blob/main/packages/desktop/src/host/index.ts
  - title: packages/shared/src/model-execution.ts and off-peak-types.ts
    resource: https://github.com/zai-org/ZCode/blob/main/packages/shared/src/model-execution.ts
  - title: Plugin credential access (src/coding-plan.ts readLogin)
    resource: ../../src/coding-plan.ts
generated:
  by: zcode-agent/GLM-5.3
  at: 2026-10-24T08:00:00Z
verified:
  - by: zcode-agent/GLM-5.3
    at: 2026-10-24T08:00:00Z
---

# Off-Peak protocol and plugin design (draft)

Research record for the `feat/off-peak` branch (roadmap stage 6 remainder).
Everything below is read from upstream main on 2026-10-24; wire details are
NOT a public contract and can change without notice.

## What off-peak is

One-shot background tasks queued on Z.ai's server and executed when the
server grants capacity: create takes a **ticket** (`POST /ticket`), the
client batch-polls `POST /ticket/status`, and a `ready` ticket authorizes
unattended execution through the **idle plan provider** whose model calls go
directly to `POST /anthropic/v1/messages` with an `X-Off-Peak-Ticket-ID`
header. There are no time windows to miss: nothing happens while the app is
closed; polling resumes on start.

## Server wire (prefix `<zcode-api-origin>/api/v1/off-peak`)

Auth on all endpoints: `Authorization: Bearer <zcode-jwt>` +
`X-Coding-Plan-Api-Key: <coding-plan-api-key>` (server verifies both: login
identity + plan eligibility). BigModel Team adds org/project headers -
out of scope (individual plans only in this plugin, already enforced by
`readLogin`).

- `GET /ticket/availability` → `{can_take_number}` (+`next_take_at` ms)
- `POST /ticket {task_id}` → `{ticket_id, state, position|null,
next_poll_after (SECONDS), ...}` | `429/3103` (+`next_take_at`) | `3101`
  (plan not eligible)
- `POST /ticket/status {ticket_ids:[≤100]}` → `{next_poll_after, tickets:
[{ticket_id, state, position, active_deadline}]}`; states
  `queued|ready|active|expired|settled|not_found`
- `POST /anthropic/v1/messages` - model calls, header
  `X-Off-Peak-Ticket-ID`; `429/3105`+Retry-After = model concurrency (wait,
  clamp min(Retry-After,5m)); `400/3102` = ticket expired (re-take and
  continue); `400/3006` = model not in whitelist
- `POST /ticket/:id/settle` (no body) - terminal settlement

Poll interval: server `next_poll_after` wins, clamped 5s..5min. Upstream
failure backoff uses a 10s base; the plugin's syncCycle retries failed
status polls after 30s. Task lifecycle:
`queued ⇄ paused → running → completed|failed|cancelled`; mid-run 3102 →
requeue, re-take the ticket (same task_id), continue the same session with a
continuation prompt. Terminal → settle (outbox with retry).

## Credentials (already available in the plugin)

`CodingPlanHost.readLogin()` reads desktop `credentials.json` and yields
exactly the off-peak credential matrix: `zcodejwttoken` → JWT,
`oauth:{family}:access_token` → coding-plan API key, family zai|bigmodel,
and already rejects non-individual plans. Idle-plan provider ids (per
family): `account:zai-offpeak-idle-plan` / `account:bigmodel-offpeak-idle-plan`
(`OFF_PEAK_PROVIDER_IDS`).

## Dispatch (native `session/send` shape, from dispatchOffPeakRun)

Three kinds: `init` (new session), `bound-first-run` (session-bound task -
the only kind our `offPeakCreate` produces), `resume` (continuation). The
send params that matter:

```
content: task.prompt | CONTINUATION_PROMPT,
toolDenylist: ["CronCreate", "OffPeakCreate"],
modelSelection: {providerId: <idle-plan-id>, modelId: task.model},
modelExecution: {
  memoryExtraction: "skip", selectionScope: "execution",
  offPeak: {executionId, ticketId, providerErrorCode: "3102"},
  requestAuth: {apiKey: jwt, headers: {
    Authorization, X-Coding-Plan-Api-Key, X-Off-Peak-Ticket-ID}},
  subagents: {foregroundModel: "submission", background: "allow"},
},
offPeakTaskId, offPeakRunType: "init" | "resume",
```

Native guards worth copying: check the bound session is idle BEFORE writing
its mode (a busy session must not get its permission mode switched by a
rejected send); bound-session-deleted is permanent, busy is transient
(30s→15min backoff); credentials/plan/model-missing are permanent (fail
fast, never park as "waiting for idle capacity"). Continuation prompt
(upstream wording): "Continue the previous task from where it left off. The
run was interrupted (app restart or execution window expired). Do not start
over; review what has already been done and complete the remaining work."

Turn outcome mapping: completed → task completed + settle; failed with the
word-bounded provider code 3102 → requeue + re-take + resume dispatch; the
first two other failures requeue after 30s (the third marks the task
failed). Plugin behavior beyond upstream: dispatch persists `running` +
`ranOnce` before the prompt leaves, and loading the store recovers
interrupted `running` rows as queued continuations.

## Plugin design (v1 scope)

- New `offPeakTasksEnabled` setting (default off) → passes
  `offPeakToolEnabled: true` at native create/resume (registers
  `OffPeakCreate`/`OffPeakList`).
- `src/offpeak.ts`: separate JSON store (`offpeak.json` in bridge-data -
  native keeps the domains in separate tables), server client (injectable
  fetch for tests), task service (create/list/cancel, sync loop, settle
  outbox), scheduler claiming ready tasks.
- Reverse RPCs: `offPeakCreate` (validates, bound-session guard before
  taking a ticket, failure classification `failureStage`/`errorCategory`
  per upstream discriminated result) and `offPeakList` (workspace-scoped).
- Dispatch reuses the automation machinery (construct-or-reuse, busy-defer,
  settle-hook outcome reporting) plus the `modelExecution` block above;
  continuation loop for 3102.
- `/zcode-offpeak` list + cancel command.
- Out of scope v1: standalone `init` tasks (ours are always session-bound),
  pause/continue, BigModel Team identity headers, client/configs
  gray-release check, native mock gateway (tests inject a fake client).

## Risks

Undocumented wire API (upstream iterates actively); plan-gated eligibility;
verification requires real Coding Plan requests. Cron-parser-style contract
tests cover wire shapes; live gateway behavior only verifiable on the real
account.
