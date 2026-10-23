# Changelog

## 0.10.1 — 2026-10-23

- Review fixes for the v0.10.0 automation host:
  - A dispatch that races an active turn (or a bb resume that wins the
    thread) now defers instead of burning one of the three failure strikes;
    a busy bound thread was already deferred by the pre-check.
  - Run reservations can no longer freeze a schedule: an unreadable store or
    a record without a session binding releases the reservation and retries
    on the next scheduler tick.
  - A schedule whose next occurrence cannot be computed (damaged or legacy
    cron in the store) is marked `failed` with an `Invalid schedule` error
    instead of redispatching on every tick.
  - Schedules are workspace-scoped like the native per-workspace index:
    `CronList`, `CronUpdate`, `CronDelete`, the binding check and
    `/zcode-automations` only see the invoking session's workspace, and
    cross-workspace ids read as unknown. The scheduler itself still serves
    every workspace's due tasks.
- Documented: runs are at-least-once across bridge-worker restarts (a crash
  between dispatch and run recording can repeat a run after restart).

## 0.10.0 — 2026-10-23

- Host ZCode's native automations inside the plugin (roadmap stage 6). A new
  `automationsEnabled` setting (off by default) lets sessions use the native
  Cron tools: the bridge answers the five `automation/*` reverse RPCs
  (create/update/list/delete/checkTaskBinding) from a local JSON store with
  upstream-matching snapshots, including interval carriers, relative
  one-shots, `maxRuns`, the 20-task create limit, and permanent one-task
  binding per session with fail-closed binding checks on a damaged store.
- Run schedules locally. A scheduler in the bridge worker fires due tasks
  while bb is open: it cold-resumes the bound native session with the saved
  provider options, model and mode, sends the prompt with the native
  `automationId` marker (blocking recursive task creation), streams the run
  into the same bb thread, records run counts/lifecycle, defers busy
  sessions up to ten minutes, and fails a schedule after three consecutive
  run failures. Runs missed while bb is closed are skipped. Off-Peak tasks
  stay unsupported and unregistered.
- Add `/zcode-automations` (list with next runs) and
  `/zcode-automation-delete <id>` management commands. With the setting off
  the Cron tools are hidden from the model instead of erroring.

## 0.9.8 — 2026-10-22

- Use the official Z.ai brand mark in both icons. The store badge is now
  `icons/zai-badge.svg`, a cleaned vector reproduction of Z.ai's own logo
  (the dark rounded square with the white three-stroke Z, path data taken
  from the official favicon asset); the theme-aware provider mark
  (`icons/zcode.svg`) uses the same official Z geometry as a currentColor
  glyph. This replaces the previous hand-drawn Z introduced in v0.9.2 and
  restyled in v0.9.4/v0.9.7. The badge also moves to a new asset URL so
  bb's catalog icon cache refreshes; `icons/zcode-badge.svg` is removed.
  Z.ai and ZCode are trademarks of Z.ai / Zhipu AI, used nominatively to
  identify the integrated product; see `icons/README.md`.

## 0.9.7 — 2026-10-22

- Give the marketplace/store listing the ZCode app-icon look: a full-color
  black rounded square with the white Z mark (icons/zcode-badge.svg). The new
  asset URL also refreshes bb's catalog icon cache. The in-app provider mark
  stays the theme-aware monochrome glyph - bb draws provider marks with
  currentColor by design, like its bundled Claude and Codex marks.

## 0.9.6 — 2026-10-21

- Add context-budget model variants to the bb selector: every model whose
  advertised window exceeds a budget (currently 256K) also lists a
  `GLM-5.3 (256K)`-style entry alongside `GLM-5.3 (1M)`. The variant runs the
  base native model — the registry has no separate ids for smaller windows —
  but caps bb's context meter and usage window to the chosen variant. Only
  catalog-generated aliases map back to the base model on native calls
  (`session/send`, `provider/testModelConnectivity`); native compaction keeps
  the model's own window.
- Preserve real native model IDs ending in `-256k`. Budget aliases use a
  provider-scoped, collision-free ID when the usual suffix is already taken,
  so both the native model and its neighbor's budget remain selectable.
- Retain the selected reporting budget across native background follow-ups
  and cold resume. Rejected prompts do not change it; accepting a new model
  selection replaces it.
- Keep discovered model windows when ZCode 0.17.0's `session/read` replaces
  them with its 200K projection default. New and resumed sessions refresh the
  catalog; projection refreshes preserve each known model's discovered window.

## 0.9.5 — 2026-10-21

- Report the bound model's advertised context window instead of the native
  projection's pre-bind default: GLM-5.3's 1M-token window now sizes bb's
  context meter (both the initial session state and post-turn usage), where
  the projection keeps reporting 200K until the native runtime changes.
- Advertise each model's context window in `model/list` descriptions (e.g.
  "1M token context window"), since bb model entries cannot carry a numeric
  window.

## 0.9.4 — 2026-10-20

- Match the ZCode app mark exactly: both terminal cuts now lean the same way
  (the top-left tip leads on the top bar, the bottom-right tip on the bottom
  bar), and the bars and diagonal carry the reference weights.

## 0.9.3 — 2026-10-20

- Fix the provider mark: the first Z polygon was self-touching, which fill
  rules collapsed into hairline slivers. The mark is now composed of three
  simple overlapping shapes (top bar, diagonal band, sheared bottom bar) and
  renders as a bold Z at every size.

## 0.9.2 — 2026-10-20

- Add a custom provider mark: a bold angular "Z" with slash-cut terminals in
  ZCode's monochrome style, served as an SVG mask so it follows bb's theme.
- The marketplace catalog now carries the icon as a plugin asset URL instead
  of the generic Terminal glyph.

## 0.9.1 — 2026-10-20

- Reject native host-service ports (browser control, automations, Off-Peak
  tasks, topic resources, MCP Apps) with an actionable message pointing to
  ZCode Desktop, instead of a generic capability error or session mismatch.
- Verified against SDK 0.6.49 that bb's provider bridge has no host-service
  channel (`BRIDGE_REQUEST_METHODS`); full browser bridging stays blocked on
  bb and is documented as such in the capability audit roadmap.

## 0.9.0 — 2026-10-20

- Add `/zcode-plugin` provider commands for ZCode's native plugin manager:
  list, install, update, uninstall, enable, disable, and marketplace
  add/update/remove, mapped onto the native `plugins/*` methods.
- Render only the fields native replies actually carry (installed plugins,
  dependency closure, diagnostics) with bounded output; malformed commands
  fail explicitly without native calls.
- These commands mutate ZCode's own plugin configuration inside its trust
  boundary, exactly as if performed from ZCode itself.

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
