---
type: contract
title: Dynamic workflow protocol (POC-verified)
description: Wire contract for ZCode dynamic workflows as exercised against the installed CLI 0.17.0 - gate, tool family, skill gate, approval, display payload, completion notification, the cross-process run read API, and the POC-verified live-status sources (projection background jobs + v4 run journal events).
status: draft
stale_after: 2027-02-27T00:00:00Z
tags: [contract, protocol, workflow, visualization]
sources:
  - title: POC run 2026-10-27 (live CLI 0.17.0, loopback fixture)
    resource: ../../scripts/poc-dynamic-workflow.ts
  - title: Upstream presentation spec
    resource: https://github.com/zai-org/ZCode/blob/main/docs/dynamic-workflow/presentation.md
  - title: Upstream authoring spec
    resource: https://github.com/zai-org/ZCode/blob/main/docs/dynamic-workflow/authoring.md
  - title: Upstream launch spec
    resource: https://github.com/zai-org/ZCode/blob/main/docs/dynamic-workflow/launch.md
  - title: Gate policy source
    resource: https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/dynamic-workflow-policy.ts
generated:
  by: zcode-agent/GLM-5.3
  at: 2026-10-27T15:30:00Z
verified:
  - by: zcode-agent/GLM-5.3
    at: 2026-10-27T15:30:00Z
---

# Dynamic workflow protocol (POC-verified)

Every claim below was observed against the installed CLI bundle 0.17.0
(`zcode.cjs`, Oct 23 2026 build) driven by
[scripts/poc-dynamic-workflow.ts](../../scripts/poc-dynamic-workflow.ts):
an isolated-data-dir run with a deterministic loopback model that loaded the
skill gate, called `CreateWorkflow` with a two-phase script, auto-allowed the
approval, and watched the run reach `completed`. Draft status: one minimal
happy path; amend/resume/holes/multi-lane fan-out are unexercised.

## Gate (how the tools turn on)

- `session/create` / `session/resume` accept `dynamicWorkflowEnabled: true`
  plus optional `dynamicWorkflowMode` (`alwaysOn` | `onDemand`). The gate is
  fail-closed and requires an explicit boolean from trusted hosts - a host
  session may not fall into the TUI/headless exemption ("absent = register
  everything").
- Alternative: `workspace/updateDynamicWorkflowPolicy` caches a
  workspace-level answer inside the CLI process
  (`{workspace, enabled, mode?}`); per-call params still win.
- Observed: one boolean on `session/create` was enough. The model tool
  catalog then contained **10 workflow tools**: `CreateWorkflow`,
  `AmendWorkflow`, `SaveWorkflow`, `EvalWorkflowSnippet`, `ListWorkflowRuns`,
  `GetWorkflowRun`, `ResumeWorkflowRun`, `ResolveQuestion` variants
  (`ResolveWorkflowQuestion`), `FillWorkflowHole`, `ListSavedWorkflows`.

## Script and skill gate

- The bundled `dynamic-workflows` skill must be loaded first: a completed
  `Skill` tool call with `{ skill: "dynamic-workflows" }` in visible history.
  The skill is bundled (present even with `plugins.enabled: false`).
- Script shape on 0.17.0: `const meta = { name, description, phases: [{id, ...}] }`
  - **no `export`** ("the script is compiled inside a function body"; the
    diagnostic arrives in the tool result). Body facade: `agent(name?)`,
    `.ask(instructions)`, `phase(name)`, `log(message)`.
- The persisted editable copy lands under `.zcode/workflow-drafts/*.dwf.ts`
  inside the workspace; the tool result names the path and suggests
  `AmendWorkflow` with `path` for revisions.
- Compile diagnostics ride the same tool result channel (`display.errorCount`,
  `display.diagnostics`) - a failed compile never reaches the permission flow.

## Approval

`CreateWorkflow` triggers the standard `interaction/requestPermission`
reverse RPC (already answered by our bridge via bb approvals). Shape
observed: `{ sessionId, turnId, toolCallId, toolName: "CreateWorkflow",
reason: "Tool CreateWorkflow always requires explicit approval", riskLevel,
requestId, options: [{kind: "allow_once"|"deny", response: {decision, reason}}],
input: { script, adjustable_settings: { subagent_model: boolean,
concurrency_ceiling: number } } }`. The `adjustable_settings` block is the
host's cue that a confirmation UI could offer a subagent-model picker and a
parallelism control. Timeline side: `permission.requested` /
`permission.resolved` session events also fire.

## Display payload (the visualization contract)

The plain `tool.updated` (`kind: "result"`) event for `CreateWorkflow`
carries `result.display` with `kind: "create_workflow"` and the full
`causalityGraph` exactly as the presentation spec describes it:
`steps` (ask/world-read sites with `line/column/lane/phase`), `lanes`
(actors), `participants` (phase:lane cards), `handoffs`, `phases`,
`phaseEdges`, `exits`, optional `holes`/`truncated`. Our bridge already
translates `tool.updated` into bb tool rows - the graph needs no new event
channel, only a renderer (bb `experimental_timelineRenderer`) on the bb side.
`truncated: true` drops the whole phase vocabulary; renderers must honor
that (half a picture would lie).

## Completion and wake-up

When the run finishes, the runtime injects a **new turn** whose input is a
`<task-notification>` block (`task-id` = `dwfrun-...`, `tool-use-id`,
`status`, `summary`) followed by a presentation instruction for the model.
The follow-up `turn.completed` carries `workflowResultConsumed`. This is the
same background-wake channel the bridge already maps for background work.

## Run read API (host-side, cross-process)

Verified cold from a second CLI process against the persisted store:

- `workflows/runs { workspace, limit }` → rows with `runId`, `status`
  (`pending|running|completed|errored|stopped` + `stopReason`), `createdAt`,
  `updatedAt`, `spentTokens`, **`parentSessionId` + `toolCallId`** (deep-link
  keys into the owning turn), `cwd`, and `artifacts` chips (≤8:
  `file|markdown|chart|table|metrics|board`).
- `workflows/list { workspace }` → saved workflows (`workflows`, `invalid`,
  `dir` = `<workspace>/.zcode/workflows`).
- `workflows/forRun`, `workflows/get`, `workflows/save`, `workflows/delete`,
  `workflows/move`, `workflows/updateMeta` exist; `forRun` returned `{}` for
  an unsaved run.

The store outlives the thread's CLI process, so a bb-side hub/pane can read
run history from any live session without the original thread.

## Live run status (POC-verified 2026-10-27, CLI 0.17.0)

Three host-visible sources, exercised mid-run with the loopback fixture:

- **Session projection background jobs.** A launched run registers in the
  session's runtime task registry and appears in `session/read`
  `projection.backgroundJobs` as `{taskId: <runId>, toolCallId, toolName:
"CreateWorkflow", taskKind: "workflow", cancellable: true|false, status:
"running"→"completed"|"failed"|"cancelled", startedAt, completedAt}`.
  `cancellable` flips false at settle. The bridge's `BackgroundWork` polls
  this at 1 s and now maps `taskKind: "workflow"` rows to bb's
  `backgroundTask`/`local_workflow` item.
- **Run journal events** (the lamp source; same feed the Desktop consumes):
  `v4/conversation/workflowRunEvents {sessionId, runId, afterSequence?,
limit?}` → `{events: [{sequence, type, payload}], hasMore}` with a
  sequence cursor. Observed grammar: `run-started` (caps), `run-launched`
  (`phaseNames[]`, `scriptPath`, `parentSessionId`, `toolCallId`),
  `phase-entered {name, ordinal}`, `actor-created {actor{siteId,ordinal},
name, persona, phaseName}`, `node-queued`/`node-dispatched` (instance +
  actor + `instructionsHead` + `phaseName`), `node-executing {instance}`,
  plus `node-waiting`/`node-repairing`/`node-nudged`/`node-settled`
  (outcome ok|failed|cancelled, cached), `node-progress`, `usage-updated
{spentTokens}`, `hole-reached`/`hole-filled`, `artifact-published`,
  `run-settled {status, stopReason?, error?}`. Settle events may omit the
  actor, so fold node→actor edges from dispatch events.
- **v4 run rows**: `v4/conversation/workflowRuns {sessionId, limit}` →
  `{runs: [{runId, toolCallId?, label?, updatedAt?, status, stopReason?,
failureCode/Message?, resumable}]}` (session-scoped, no usage).
  `v4/conversation/workflowRunWorkspace` returned **no nodes** for an
  ask-only two-phase script (live and post-run) — workspace nodes are not a
  reliable lamp source; fold the journal instead.

bb's `backgroundTask.workflow` snapshot grammar is 1-based (`agents[].index`
and `attempt` ≥ 1, `phases[].index` ≥ 1); the plugin fills `agents` from
folded actor/node states and `phases` from `run-launched.phaseNames`.

Bridge fold invariants (review-hardened in v0.14.0): pages are drained while
`hasMore` is true before a settled run may close its row (a 25-page cap per
refresh guards a runaway journal; the `afterSequence` cursor resumes), and
node settlement is not actor settlement — an actor tracks its in-flight
nodes and only goes terminal when the last one settles, so a second ask
reactivates a `done` lamp. Identity keys are `siteId#ordinal` (fan-out
reuses siteIds), and a terminal row closes only when the journal reports
`run-settled` (three consecutive pull failures degrade to a run-level
close; one transient timeout retries) — covering runs first seen already
settled and the race where the projection turns terminal before the fold
catches up.

## Open questions for stage 8/9

- ~~Per-step live status~~ — verified: journal events via the v4 pull (above).
- `model_bindings` validation, holes/`FillWorkflowHole` round trip,
  `AmendWorkflow`, `ResumeWorkflowRun`, and fan-out (`Promise.all`)
  topologies are unexercised.
- Subagent child sessions: no parent-stream events observed (children are
  invisible to the owning session's subscription beyond the notification).
- bb's own rendering of the `workflow` snapshot grammar is not yet verified
  in an installed bb run (only the delta grammar is schema-validated); the
  row degrades honestly to run-level status if the journal surface is
  missing.

## Related knowledge

- [Feature roadmap](../decisions/feature-roadmap.md) stages 8-9.
- [Protocol contracts](protocol-contracts.md) for the surrounding wire
  surfaces.
