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
