# Knowledge log

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
