---
type: invariant
title: Session invariants
description: Behaviors every change must preserve - explicit failure, context-selection lifetime, credential containment, and hard numeric bounds.
status: stable
stale_after: 2027-01-20T00:00:00Z
tags: [invariants, security, reliability]
sources:
  - title: src/bridge.ts at 3dc639d
    resource: https://github.com/dpolishuk/bb-zcode/blob/3dc639de8e7926b2460059dcf20156950fc7f2d3/src/bridge.ts
  - title: src/client.ts at 3dc639d
    resource: https://github.com/dpolishuk/bb-zcode/blob/3dc639de8e7926b2460059dcf20156950fc7f2d3/src/client.ts
  - title: src/lifecycle.ts at 3dc639d
    resource: https://github.com/dpolishuk/bb-zcode/blob/3dc639de8e7926b2460059dcf20156950fc7f2d3/src/lifecycle.ts
  - title: src/coding-plan.ts at 3dc639d
    resource: https://github.com/dpolishuk/bb-zcode/blob/3dc639de8e7926b2460059dcf20156950fc7f2d3/src/coding-plan.ts
  - title: src/tool-server.ts at 3dc639d
    resource: https://github.com/dpolishuk/bb-zcode/blob/3dc639de8e7926b2460059dcf20156950fc7f2d3/src/tool-server.ts
  - title: Current accepted model selection and turn settlement
    resource: ../../src/bridge.ts
  - title: Native follow-up, resume, rejection, and model-switch regressions
    resource: ../../tests/core-features.test.ts
  - title: Real CLI fixture for reporting budgets and background work
    resource: ../../scripts/smoke-live.ts
generated:
  by: zcode-agent/GLM-5.3
  at: 2026-10-20T11:15:00Z
verified:
  - by: zcode-agent/GLM-5.3
    at: 2026-10-20T11:15:00Z
  - by: Codex
    at: 2026-10-22T11:22:00Z
---

# Session invariants

These are cross-cutting rules the implementation deliberately enforces. A
change that weakens one of them is a behavior change, not a refactor, and needs
matching tests and documentation updates (see
[Change verification](../runbooks/change-verification.md)).

## Explicit failure over silent substitution

- Resume failure is reported; an unresumable session is never silently
  replaced with a new one.
- Checkpoint tokens are strict (`v: 1`, session, log epoch, row ID, entity ID,
  64-hex content fingerprint in `src/lifecycle.ts`). Missing, changed, stale,
  or rejected targets fail explicitly; **no later turn is silently
  substituted**, and lookup is bounded (see table below).
- Incompatible CLIs fail loudly: history queries that do not parse return
  "This ZCode CLI does not expose compatible v4 history controls. Update
  ZCode."; out-of-order rows return "ZCode returned inconsistent history
  rows."
- Invalid or unanswered approval requests never become allow decisions, and
  approvals are single-use; no persistent permission rules are granted.
- The bridge does not fabricate data it cannot know: billing cost is not
  invented, native Bash file edits are reported as ignored rather than claimed
  restorable, and the fallback "ZCode models unavailable" entry does not claim
  authentication.
- Automatic retries of transient upstream failures (v0.11.x) are visible and
  bounded: every hold emits a bb `provider.error` reconnect row before
  waiting, retries re-run the turn through the native `retryTurn` control
  (rewind to the last user input, no message duplication), and exhaustion
  fails the turn with the original native error. A turn that already streamed
  any output (the abandoned partial answer cannot be retracted from the bb
  thread) or ran any tool, and idle-time ticket runs, are never retried
  automatically — explicit failure is preserved wherever a retry could repeat
  side effects or corrupt the transcript.

## Context selection lifetime

- The reporting model selection is session state. Creation and resume restore
  it from bb's model option (or the native current model for `zcode-default`).
- A native accepted prompt replaces that selection before buffered events are
  replayed. Rejected or failed submissions leave the previous selection intact.
- Foreground settlement does not clear it: ZCode can start an automatic turn
  after background work finishes without a bb `turn/start`. Both usage and
  refreshed context deltas must still honor the last accepted reporting budget.
- A `session/read` refresh updates native current selection and projection but
  retains discovered windows for known model identities. CLI 0.17.0 rewrites
  those windows to its 200K default; that must not overwrite 1M discovery
  metadata or remove a selected 256K reporting budget.
- A new accepted base-model selection removes the previous cap. Budget-to-native
  identity rules are in [Protocol contracts](../contracts/protocol-contracts.md#translation-rules).

Re-verified on 2026-10-22 with focused regressions and the real CLI 0.17.0
loopback fixture (native background completion and cold resume). Other pinned
bounds retain the verification dates stated below; see
[validation](../../docs/validation.md) for the evidence boundary.

## Credential containment

- Short-lived Coding Plan project tokens exist only in memory; desktop
  credentials are read, never modified.
- In `src/coding-plan.ts`, only the module's own `AccountError` messages may
  leave the module - API bodies and credential-parser failures can contain
  secrets and must never become bb diagnostics (stated in a code comment).
- bb's raw child-I/O recorder is never attached to the ZCode transport because
  reverse-RPC replies can contain credentials (`src/client.ts`); child stderr
  is drained, never forwarded.
- The bb tool bridge endpoint binds to `127.0.0.1` on an ephemeral port with a
  random 32-byte bearer token, rejects any request carrying an `Origin` header
  (browser-origin defense), and answers only `POST /mcp`.
- Credentials live in ZCode (`~/.zcode/v2/`); the plugin has no API-key
  settings, and diagnostics must never instruct copying credentials out of
  ZCode.

## Hard bounds

Numeric limits enforced in code (values verified at commit `3dc639d`):

| Bound                         | Value                                                                                           | Enforced in                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------- |
| Follow-up queue               | 32 pending inputs                                                                               | `src/bridge.ts`                       |
| Image inputs (local/data URL) | 16 MiB                                                                                          | `src/input.ts`                        |
| Tool-server request body      | 1 MiB (HTTP 413 beyond)                                                                         | `src/tool-server.ts`                  |
| bb tool call timeout          | 10 minutes                                                                                      | `src/bridge.ts`, `src/tool-server.ts` |
| Bash output snapshot          | last 8192 bytes                                                                                 | `src/lifecycle.ts`                    |
| File-rewind preview token     | 5 minutes, single-use, session-bound                                                            | `src/lifecycle.ts`                    |
| v4 history lookup             | 200 rows/page, ≤50 pages (= 10,000 rows)                                                        | `src/lifecycle.ts`                    |
| bb tool catalog               | ≤256 tools, unique names                                                                        | `src/tool-server.ts`                  |
| bb skill catalog              | ≤128 roots, ≤1024 skills, ≤256 KiB JSON                                                         | `src/skills.ts`                       |
| Rich row text (v0.6.0)        | 64 KiB per old/new text, 4 KiB labels/summaries                                                 | `src/timeline.ts`                     |
| Connectivity check (v0.7.0)   | 60 s timeout, one real model request                                                            | `src/bridge.ts`                       |
| Upstream turn retries         | 2 per turn (≈15 s and 45 s waits), 30 s start timeout; tool-active and idle-time turns excluded | `src/bridge.ts`                       |
| Native request timeout        | 30 s default                                                                                    | `src/client.ts`                       |

## Related knowledge

- Component responsibilities: [System overview](system-overview.md).
- Where these failures surface to users: [Diagnostics](../runbooks/diagnostics.md).
