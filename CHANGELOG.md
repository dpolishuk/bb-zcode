# Changelog

## 0.8.0 — 2026-10-20

- Support bb thread archive, unarchive and rename actions. Names and archive
  state are bb-local by design: the native protocol has no title or archive
  API, and ZCode title generation stays off, so nothing is overwritten.
- Bridge `thread/goal/clear` to the native `session/goal` clear action; it
  requires the thread's active ZCode session and propagates native errors.
- Advertise `threadArchive`, `threadRename` and `threadGoalClear` in the
  bridge handshake and provider declaration.

## 0.7.0 — 2026-10-20

- Answer bb's provider usage panel from sessionless discovery: account status
  and the active individual Coding Plan subscription label, with no invented
  usage numbers, quotas or spend.
- Add `/zcode-check [providerId/modelId]` to run ZCode's native model
  connectivity test on demand - one real model request, no session prompt.
- Health guidance now points to `/zcode-check` instead of only stating that
  model connectivity is untested.

## 0.6.0 — 2026-10-20

- Render native coding tools as rich bb rows: file edits and writes with
  old/new text, file reads, content and path search, web search and fetch,
  plan steps translated from TodoWrite statuses, and Task delegations with
  result summaries.
- Keep failures explicit: errored or interrupted tools fall back to the
  generic row so the error stays visible; unknown tools are unchanged.

## 0.5.0 — 2026-10-19

- Track background Bash tasks and agent delegations across foreground turns;
  list tasks, read bounded Bash output and cancel specific native work.
- Prevent idle release while native work remains; cancel on interrupt and
  settle pending task cards on native child failure.
- Enable bb forks and edit-message/rewind through exact native checkpoints,
  including continued and cold forks with isolated child tools and settings.
- Preserve checkpoint identity across native restarts; validate content and
  current revision/epoch, and reject missing/stale/rejected targets explicitly.
- Add native file-rewind preview and explicit apply with a short-lived,
  single-use token, Full Access gate and native file-conflict checks.
- Extend automated, real-CLI and installed bb checks; document that native
  background completion/cancellation can independently trigger model turns.

## 0.4.0 — 2026-10-18

- Add an opt-in bridge for bb plugin tools through a session-scoped authenticated local MCP server,
  preserving schemas, presentation, text/images and failures. Cancel pending
  bridge calls on stop/crash and rebuild tool selection on resume.
- Forward bb skill catalogs with original file paths for native file-tool loading.
- Add validated native subagent snapshots and model overrides, with scoped startup
  callbacks and child questions/approvals routed through the parent session.
- Retain nested tool attribution and render Bash commands with bounded output.
- Expand native CLI and installed bb extension fixtures; document remaining audit gaps.

## 0.3.0 — 2026-10-18

- Queue follow-ups in order, cancel pending inputs on stop, and deduplicate
  replayed accepted inputs.
- Forward local images/files and image data URLs; download HTTPS images with
  size, redirect, credential and timeout limits. Preserve structured mentions
  as model-visible references.
- Expose native token/cache/reasoning usage and estimated context, including
  persisted usage after resume. Preserve other saved model-selection options.
- Enable native manual compaction through bb's normal compact action.
- Inject configured stdio/HTTP/SSE MCP servers at create/resume. Add official
  individual Coding Plan MCP authentication for the default ZCode endpoint.
- Add optional native memory and enhanced-search settings.
- Expand automated and real-CLI fixture coverage. Publish the capability audit
  with an explicit list of remaining host integrations.

## 0.2.0

- Add individual Coding Plan model discovery and scoped runtime authentication.
- Expose each model's native reasoning choices and defaults.
