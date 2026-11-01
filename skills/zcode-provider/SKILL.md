---
name: zcode-provider
description: Configure or troubleshoot the ZCode provider plugin in bb.
---

# ZCode provider

Use this skill for setup and diagnostics of the `zcode` provider in bb.

- Inspect available models with `bb provider models zcode`.
- Inspect settings with `bb plugin config zcode`.
- Set `executable` to a ZCode executable or JavaScript bundle path on the
  execution host; set `nodeExecutable` when the bundle needs an explicit Node 24+
  runtime. `args` is a JSON array; no shell interpolation occurs.
- Configure API credentials in ZCode, never in plugin settings or prompts.
  This version supports personal API providers and individual Coding Plan
  through the existing ZCode Desktop sign-in on the same machine and OS user.
  Open Coding Plan once in ZCode to prepare its project key. Start Plan,
  Team plans, and standalone CLI-only login are not supported.
- Native permission and question prompts are answered through bb. The plugin
  does not provide an OS sandbox, and does not grant persistent permission rules.
- Text and attachment prompts, streaming, generic tool activity, interruption,
  resume, queued follow-ups, token/context reporting and native `/compact` are
  supported. Follow-ups wait for a turn boundary; they do not inject into an
  active model loop. Native bb forks and edit-message/rewind use exact persisted
  assistant checkpoints; missing/stale targets fail explicitly.
- The context meter is sized from each model's advertised window (GLM-5.3:
  1M tokens; the native projection keeps a smaller pre-bind default), and
  `model/list` descriptions carry the window because bb model entries have
  no numeric field for it.
- Models with a larger native window also list context-budget variants, e.g.
  `GLM-5.3 (256K)` next to `GLM-5.3 (1M)`. A variant runs the same base
  native model but caps the window reported to bb. The cap survives native
  background follow-ups and resume; accepting a new model selection replaces
  it. Use the exact ID from `model/list`: only generated aliases map to the
  base model, and real native IDs (including those ending in `-256k`) stay
  unchanged. A reporting cap does not change ZCode's native compaction window.
- Enable `bbToolsEnabled` for bb-injected tools. It is off by default to preserve
  CLI MCP inheritance; when enabled, list other custom servers in `mcpServers`.
  These tools run through a session-scoped local MCP endpoint and bb’s tool
  dispatcher. bb skills are a file catalog read with native tools, not entries in
  ZCode’s native Skill registry. Start a new session to refresh the selection.
- `subagents` accepts a validated native configuration snapshot. Empty inherits
  native agents; custom child questions/approvals return through the parent bb
  session. Background Bash/agent cards survive foreground turn settlement.
  A full subagent tree UI is not implemented.
- Use `/zcode-tasks`, `/zcode-task-output <id>` (Bash only) and
  `/zcode-task-stop <id>` to manage native background work in an idle foreground.
  Native completion/cancellation may independently trigger a model follow-up.
- Conversation rewind preserves workspace files. File rollback requires
  `/zcode-file-preview [checkpoint]`, inspection of native safety results, and
  `/zcode-file-rewind <preview-token>` in Full Access mode. Tokens expire after
  five minutes and are single-use; native external-file conflicts block apply.
- `mcpServers` accepts native stdio/http/sse startup definitions. Native CLI MCP
  configuration is inherited when this list is empty. `memoryEnabled` and
  `nativeSearchEnhancementsEnabled` are optional booleans, off by default.
- Official MCP auth is separate from model auth and supports only individual
  Coding Plan at `https://zcode.z.ai`; credentials are workspace/account scoped.
  Browser Use, MCP Apps/Gen UI and workflow/scheduler host callbacks are not
  implemented. Do not claim these work merely because their skills are loaded.
- A model catalog or healthy protocol probe is not proof of authenticated model
  connectivity. `npm run test:live` uses a real CLI and synthetic loopback model
  with isolated data. Keep that evidence separate from a real provider run.
- Recognized transient Z.ai account failures emit typed `provider.error` deltas
  so bb's Provider retry plugin can retry the turn up to four times with
  backoff. Check `bb provider-retry explain <thread-id>` for the decision;
  authentication and configuration errors otherwise remain terminal.
- When the ZCode process exits unexpectedly, the bridge asks bb to restart it
  and resume the thread from its native checkpoint. A submit racing that
  restart fails with `No ZCode session; start or resume the thread first.`; if
  the error repeats, the restart is still deferred or in progress (bb defers
  it while sibling threads are mid-turn) — wait for `Restarting the "zcode"
bridge` in `~/.bb/logs/host-daemon.*.log`, then resubmit.
- Diagnose a stopped session by its native error. Never silently replace an
  unresumable session, replay a prompt after an uncertain timeout, or copy
  credentials out of ZCode to work around authentication.
