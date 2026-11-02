---
type: runbook
title: Diagnostics
description: Where failures surface, which module owns each error message, how to reproduce protocol failures with the test fixtures, and the safety rules for interpreting results.
status: stable
tags: [runbook, debugging]
sources:
  - title: src/client.ts at 3dc639d
    resource: https://github.com/dpolishuk/bb-zcode/blob/3dc639de8e7926b2460059dcf20156950fc7f2d3/src/client.ts
  - title: src/launch.ts at 3dc639d
    resource: https://github.com/dpolishuk/bb-zcode/blob/3dc639de8e7926b2460059dcf20156950fc7f2d3/src/launch.ts
  - title: src/lifecycle.ts at 3dc639d
    resource: https://github.com/dpolishuk/bb-zcode/blob/3dc639de8e7926b2460059dcf20156950fc7f2d3/src/lifecycle.ts
  - title: src/bridge.ts at 3dc639d
    resource: https://github.com/dpolishuk/bb-zcode/blob/3dc639de8e7926b2460059dcf20156950fc7f2d3/src/bridge.ts
  - title: docs/configuration.md troubleshooting at 3dc639d
    resource: https://github.com/dpolishuk/bb-zcode/blob/3dc639de8e7926b2460059dcf20156950fc7f2d3/docs/configuration.md
  - title: skills/zcode-provider/SKILL.md at 3dc639d
    resource: https://github.com/dpolishuk/bb-zcode/blob/3dc639de8e7926b2460059dcf20156950fc7f2d3/skills/zcode-provider/SKILL.md
generated:
  by: zcode-agent/GLM-5.3
  at: 2026-10-20T11:15:00Z
verified:
  - by: zcode-agent/GLM-5.3
    at: 2026-10-20T11:15:00Z
---

# Diagnostics

Start here when a session, install, or model list misbehaves. The end-user
symptom table lives in
[docs/configuration.md](../../docs/configuration.md#troubleshooting); this
runbook adds the code-level view for contributors.

## Error ownership map

Error messages are stable search keys; each is produced by exactly one module:

| Message / behavior                                                             | Produced by          | Meaning                                                                                                                                                                                        |
| ------------------------------------------------------------------------------ | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ZCode was not found. Install ZCode or set the plugin executable setting.`     | `src/launch.ts`      | Resolution order (setting → `BB_ZCODE_EXECUTABLE` → PATH → macOS bundle) found nothing                                                                                                         |
| `Cannot launch ZCode: …` / `ZCode exited (signal/code)`                        | `src/client.ts`      | Child spawn failure or early exit; check executable and provider configuration                                                                                                                 |
| `ZCode stdin closed.`                                                          | `src/client.ts`      | Child closed stdin while requests were pending                                                                                                                                                 |
| `ZCode Coding Plan: cannot read the desktop configuration…`                    | `src/coding-plan.ts` | Desktop sign-in missing; open ZCode and sign in again                                                                                                                                          |
| `The ZCode follow-up queue is full.`                                           | `src/bridge.ts`      | More than 32 pending follow-ups (bounded queue, by design)                                                                                                                                     |
| `No ZCode session; start or resume the thread first.`                          | `src/bridge.ts`      | `turn/start`/`turn/steer` arrived after the ZCode process exited or the bridge worker restarted; carries `data.recovery` `restartRecommended` so bb restarts the bridge and resumes the thread |
| `This ZCode CLI does not expose compatible v4 history controls. Update ZCode.` | `src/lifecycle.ts`   | v4 row query failed schema check; CLI too old or protocol changed                                                                                                                              |
| `ZCode returned inconsistent history rows.`                                    | `src/lifecycle.ts`   | Rows not strictly descending / outside the requested range                                                                                                                                     |
| `Invalid bb tool catalog: too many or duplicate tools.`                        | `src/tool-server.ts` | >256 tools or duplicate names                                                                                                                                                                  |
| `bb skill roots must be absolute paths (maximum 128).`                         | `src/skills.ts`      | bb sent relative skill paths or too many roots                                                                                                                                                 |
| Tool endpoint 401 / 404 / 405 / 413                                            | `src/tool-server.ts` | Bad bearer token or browser `Origin` / wrong path or inactive / non-POST / body >1 MiB                                                                                                         |

Bridge-level errors are thrown as `ProtocolError` (default code `-32000`);
native requests time out after 30 s by default (`src/client.ts`).

## Reproduction fixtures

The synthetic tests are the fastest way to reproduce a protocol failure
deterministically:

- [tests/fixtures/fake-zcode.mjs](../../tests/fixtures/fake-zcode.mjs) - fake
  ZCode CLI speaking the native stdio protocol (sessions, streaming,
  approvals, failures).
- [tests/fixtures/transport-peer.mjs](../../tests/fixtures/transport-peer.mjs)
  - raw peer for split UTF-8 frames and malformed/oversized input.
- [tests/fixtures/mcp-server.mjs](../../tests/fixtures/mcp-server.mjs) - MCP
  server for startup configuration and tool execution paths.
- [tests/fixtures/bb-extension-plugin/](../../tests/fixtures/bb-extension-plugin/)
  - companion bb plugin for the tool/skill bridge tests.

Pick the test file that covers the failing area
([tests/bridge.test.ts](../../tests/bridge.test.ts),
[tests/lifecycle.test.ts](../../tests/lifecycle.test.ts),
[tests/core-features.test.ts](../../tests/core-features.test.ts), …) and extend
it rather than testing through the real CLI first.

## Marketplace and install issues

A plain repository-page URL is rejected by bb with HTTP 422 because bb parses
every `https://` marketplace source as JSON. Use the raw manifest URL or the
`git:` form; details and update commands are in
[docs/marketplace.md](../../docs/marketplace.md).

## Interpretation rules

From the provider skill's diagnostics section (kept authoritative there):

- Diagnose a stopped session by its native error. Never silently replace an
  unresumable session, replay a prompt after an uncertain timeout, or copy
  credentials out of ZCode to work around authentication.
- A model catalog or healthy protocol probe is not proof of authenticated
  model connectivity (see the boundaries in
  [Change verification](change-verification.md)).
- Follow-up failures after queue overflow are expected bounded behavior, not a
  bug; report them to the user instead of retrying unbounded.
- The two observed transient Z.ai account failures (`The API key status is not
active.` and `account request failed or returned an invalid response.`) emit
  `provider.error` with `errorInfo.category: "internal"` before the failed turn
  boundary. bb's Provider retry plugin owns the bounded retry and accepted-input
  continuation; the bridge does not replay input itself. Inspect the recorded
  decision with `bb provider-retry explain <thread-id>`. Other native failures,
  including reasoning/configuration errors, stay unclassified and terminal.
- When the ZCode process exits unexpectedly, the bridge emits the
  `session.ended` delta and then an unsolicited `provider/recovery`
  (`restartRecommended`, `retryable: true`) notification for restorable sessions.
  bb reacts by restarting the bridge worker and resuming the thread (and idle
  sibling threads) from native checkpoints — look for `Restarting the "zcode"
bridge` in the host-daemon log to confirm it ran. This matters because
  `session.ended` alone does not clear bb's stored provider-thread claim, which
  is why submits used to fail forever with `No ZCode session` (observed
  2026-11-01: threads `thr_8htvmki9xm`, `thr_d6pdiigxzx`). The notification is
  deliberately skipped when no turn ever started (`restorable: false`) — there is
  no checkpoint to restore.

## Related knowledge

- Invariants behind these failures: [Session invariants](../architecture/session-invariants.md).
- Architecture map: [System overview](../architecture/system-overview.md).
