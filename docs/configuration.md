# Configuration

## Launch settings

| Setting                           | Default     | Purpose                                                                                        |
| --------------------------------- | ----------- | ---------------------------------------------------------------------------------------------- |
| `executable`                      | Auto-detect | Native executable or `.cjs` / `.mjs` / `.js` CLI path                                          |
| `nodeExecutable`                  | `node`      | Node.js 24+ executable for a JavaScript CLI bundle                                             |
| `args`                            | `[]`        | JSON array of arguments before `app-server`, passed without a shell                            |
| `memoryEnabled`                   | `false`     | Allow native ZCode memory in new sessions                                                      |
| `nativeSearchEnhancementsEnabled` | `false`     | Enable native enhanced find/grep in new sessions                                               |
| `bbToolsEnabled`                  | `false`     | Enable the bb tool bridge; overrides native CLI MCP server list                                |
| `automationsEnabled`              | `false`     | Let sessions create scheduled tasks (Cron tools) and run them while bb is open                 |
| `offPeakTasksEnabled`             | `false`     | Let sessions queue idle-time (off-peak) tasks; runs consume Coding Plan quota                  |
| `subagents`                       | Empty       | JSON native subagent snapshot; empty inherits native configuration                             |
| `mcpServers`                      | `[]`        | JSON array of native MCP server definitions; empty inherits CLI settings when bb tools are off |

Use `node scripts/bb.mjs plugin config zcode set <setting> <value>` from the
checkout, or `bb plugin config` if the bb CLI is on PATH. Paths must exist on
the host running the thread. Settings changes refresh provider registration
and invalidate model discovery; restart existing sessions to change their
executable.

The provider checks `zcode` on PATH, then
`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs` on macOS. For a script
bundle it supplies the adjacent public provider configuration when present.
Personal configuration and credentials remain under ZCode's control.

Host environment overrides:

- `BB_ZCODE_EXECUTABLE`: used when no explicit executable setting is present.
- `BB_ZCODE_NODE_EXECUTABLE`: overrides the Node executable.
- `BB_CLI`: an explicit bb CLI executable for `scripts/bb.mjs`.

ZCode's own configuration environment is inherited. Arguments are passed
as an argv array; there is no shell interpolation.

## Scheduled tasks

Enable `automationsEnabled` to let ZCode sessions create scheduled tasks
through the native Cron tools (`CronCreate`, `CronList`, `CronUpdate`,
`CronDelete`). The plugin answers the native `automation/*` host ports from
a local store (`automations.json` in the plugin's bridge-data directory) and
runs schedules itself:

- Runs dispatch into the session that created the task: the plugin
  cold-resumes the saved native session, applies the saved model and mode,
  and sends the prompt with the native automation marker, so ZCode blocks
  recursive task creation for that turn. The reply streams into the same bb
  thread.
- The scheduler lives in the bridge worker and only runs while bb is open -
  like ZCode Desktop, schedules do not fire while the app is closed. Runs
  missed while closed are skipped; recurring schedules continue from the
  next occurrence.
- A thread busy at fire time defers up to ten minutes, then records a
  failed run. Three consecutive failures pause the schedule as `failed`.
- Schedules are workspace-scoped like the native index: `CronList`,
  `CronUpdate`, `CronDelete` and the binding check only see the invoking
  session's workspace; cross-workspace ids read as unknown. The scheduler
  itself runs every workspace's due tasks.
- Runs are at-least-once across restarts: a bridge-worker crash between
  dispatch and run recording can repeat a run after bb restarts.
- Cron expressions follow the machine's local timezone. Every session can
  hold at most one task, permanently - matching native semantics.

Manage tasks from any idle ZCode session with `/zcode-automations` (list
with next runs) and `/zcode-automation-delete <id>`. With the setting off,
the Cron tools stay hidden from the model entirely.

## Idle-time (off-peak) tasks

Enable `offPeakTasksEnabled` to let ZCode sessions queue idle-time tasks
through the native `OffPeakCreate`/`OffPeakList` tools. Unlike scheduled
tasks, the queue lives on the Z.ai server: creating a task takes a ticket,
the plugin polls its status, and when the server marks it ready the task
runs unattended in this bb:

- Requires an existing desktop sign-in with an **individual Coding Plan**
  (Z.ai or BigModel); the runs themselves execute through the plan's idle
  window and consume its quota. The server rejects ineligible plans with a
  typed error the model relays at creation time.
- A ready task dispatches into the session that created it with the plan's
  hidden idle-time model: the plugin passes the ticket, plan credentials and
  model per run, and hides `CronCreate`/`OffPeakCreate` for the run so a
  background task cannot queue more work. The reply streams into the same bb
  thread.
- When the execution window expires mid-run (server code 3102) the task
  requeues automatically, takes a new ticket and continues the same session
  from where it left off. Three consecutive failures park it as `failed`;
  busy bound threads defer with backoff.
- Nothing happens while bb is closed - like ZCode Desktop, there is no
  window to miss; polling resumes on the next start. Tasks are
  workspace-scoped in `offpeak.json` (separate from automations, like the
  native tables).
- v1 limits: tasks need an explicit `model` at creation (the tool normally
  sends one; a task without it fails with guidance instead of guessing), and
  pause/continue are not exposed - `/zcode-offpeak` lists tasks and
  `/zcode-offpeak-cancel <id>` cancels one.

The gateway wire API is undocumented upstream and can change; the plugin
follows the open-source reference implementation and pins it in
`knowledge/contracts/off-peak-protocol.md`.

## Models

Model IDs use `providerId/modelId`; model and reasoning options come from
ZCode. Unsupported or stale reasoning choices fall back to a native model
default, as required by bb's bridge contract.

The fallback **ZCode models unavailable** entry appears while the catalog is
unavailable. It does not prove that a provider is authenticated. Likewise,
health checks verify protocol/catalog availability, not model connectivity.
Run `/zcode-check` in an idle session to perform one real connectivity
request; the provider usage panel reports account status and the active
Coding Plan label without invented usage numbers.

## Individual Coding Plan

Sign in to ZCode Desktop on the same machine and OS user that runs bb. Select
individual Coding Plan (Z.ai or BigModel) and open it once in ZCode so its
project key exists. Update the plugin and start a new bb session. The plugin
supplies the account catalog and runtime-auth callback expected by ZCode.
Model names and efforts come from the installed catalog; no effort options
are invented by the plugin.

The plugin reads `~/.zcode/v2/credentials.json` and `setting.json`, including
ZCode's encrypted credential format. It exchanges the existing desktop login
for short-lived project tokens using fixed official account endpoints, checks
the subscription, and holds those tokens only in memory. It does not create
API keys or modify desktop credentials. Raw child-protocol recording is disabled
because authentication replies contain credentials. Signing out or switching
accounts invalidates the current bb session's credentials.

On macOS, the standard ZCode app supplies its builtin catalog and app version.
Custom installations must supply `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` and
`ZCODE_APP_VERSION` in bb's environment. `ZCODE_DATA_BASE_DIR` and
`ZCODE_CREDENTIAL_SECRET`, when used, must match ZCode. Both builtin and personal
catalog paths are passed explicitly to keep account-overlay revisions aligned.
Standalone CLI-only login, Start Plan, and Team plans are outside this version's
account support. Personal API providers continue to work independently.

### Official MCP identity

Official MCP services use a separate authentication callback. The adapter
supports individual Coding Plan using the existing ZCode login JWT plus the
selected family's MaaS JWT. It validates the default destination
`https://zcode.z.ai`, exact workspace, active account and entitlement before
returning headers. It never uses a project API key as a substitute for these
identity headers. Custom ZCode service origins and Team plans are unsupported.
This path has synthetic credential/bridge tests; production MCP access remains
unverified.

## Attachments, follow-ups and context

Attach local images or files with bb's composer or `bb thread tell --image` /
`--file`. Paths must be available on the execution host. Inline image data URLs
and HTTPS images are supported up to 16 MiB; HTTPS downloads use a deadline and
reject redirects and URL credentials. Native format/model limits still apply.
PNG and text-file attachments have real-CLI fixture coverage; other media
formats are delegated to ZCode and remain unverified.

Follow-up messages queue in FIFO order and run after the current turn finishes.
The queue holds up to 32 pending inputs. Stopping/releasing the session clears
pending follow-ups; queued inputs are not persisted by the bridge across a
process crash. bb validates expected turn identity; the bridge returns typed
stale-turn recovery when no turn remains active. `/compact` uses the native
compaction operation. Normal context reporting uses native estimates; billing
cost is not fabricated.

## MCP and native runtime preferences

Set `memoryEnabled` or `nativeSearchEnhancementsEnabled` through bb's plugin
settings, then start a new session. Both are off by default for compatibility.
ZCode owns memory storage and behavior; enabling the setting is not proof that
its extraction/recall cycle has been validated through a production model.

To supply explicit MCP startup configuration, set `mcpServers` to an array:

```json
[
  {
    "name": "local-tools",
    "command": "/absolute/path/to/node",
    "args": ["/absolute/path/to/server.mjs"],
    "env": []
  },
  {
    "name": "remote-tools",
    "type": "http",
    "url": "https://example.com/mcp",
    "headers": []
  }
]
```

Environment/header entries use `{ "name": "...", "value": "..." }` objects.
Optional server fields are `timeoutMs`, `isolation` (`session` or `workspace`),
and `protocolVersion` (`legacy`, `auto`, or `2026-07-28`). HTTP/SSE OAuth setup is
not exposed by this setting. Existing enabled native plugins and CLI MCP
configuration remain ZCode-managed; Desktop MCP settings are not automatically
imported. The setting injects servers at both session creation and resume.

## bb tools and skills

Enable `bbToolsEnabled` to make tools selected by bb plugins available through
a private loopback MCP endpoint for each session. It is off by default: ZCode’s
host-supplied MCP list replaces the native CLI MCP list. When enabled, list any
additional custom servers in `mcpServers`; native plugin MCP servers still load.
Names and JSON input schemas come from bb; calls return through bb's tool
dispatcher, with the original plugin presentation, text/image results and failure
status. The `bb-bridge` MCP server name is reserved. Tool selection is fixed at session
creation and rebuilt on cold resume; bb's denied tools are excluded.

The endpoint binds only to 127.0.0.1, requires a random session credential,
rejects browser-origin requests and bounds request bodies to 1 MiB. Unknown
tools and calls outside an active turn fail. Stop, crash and turn settlement
cancel pending bridge waits and settle their rows. Calls time out after ten
minutes. Cancellation does not undo effects a bb tool has already performed.

bb skills are delivered as a model-visible catalog of names, descriptions and
absolute SKILL.md paths. ZCode reads applicable files with its native file
tools; supporting assets stay in the original skill directory. This does not
register the skills in ZCode's native `Skill` tool catalog. The roots must be
available on the execution host. The catalog is refreshed at process/session
construction, including resume. No global ZCode configuration or project files
are modified to install these skills.

## Custom subagents

The optional `subagents` setting accepts the native resolved snapshot:

```json
{
  "kind": "ready",
  "profiles": [
    {
      "name": "reviewer",
      "description": "Review changes for correctness",
      "source": "user",
      "systemPrompt": "Inspect the requested changes and report concrete problems.",
      "tools": ["Read", "Grep", "Glob"],
      "maxTurns": 8
    }
  ],
  "builtInModelSelectionOverrides": {},
  "pluginAgentModelSelectionOverrides": {}
}
```

Profiles support the native model selection, tool allow/deny lists, skills,
MCP server selection, permission mode, memory scope, background preference,
color and instruction settings. Optional model selections use `providerId`,
`modelId` and `options.reasoningLevel`; built-in override keys are `Explore`
and `general-purpose`. Invalid or duplicate profiles are rejected before
launch. Empty settings preserve native agent loading; an explicit
`{"kind":"built-in-fallback"}` requests the native built-in fallback.

The native startup callback is scoped to the supervised session and checked
against the returned session identity. Child questions and approvals use the
parent bb session. Nested tool events preserve their parent reference; Bash
commands use bb's command row with bounded output snapshots and final output.
A full subagent tree, background-task management, rich diffs and checkpoint UI
remain outside this release. A background preference in a profile does not
establish complete bb background-task support.

## Permissions and sessions

| bb mode                 | ZCode mode                                     |
| ----------------------- | ---------------------------------------------- |
| Plan composer action    | `plan`                                         |
| `accept-edits` / `auto` | `build`, with approval decisions handled by bb |
| `full`                  | `yolo`                                         |

These are agent approval policies, not an OS sandbox. The ZCode CLI runs with
the permissions of its host account. The adapter offers single-use approvals;
invalid or unanswered approval requests do not become allow decisions.

One child process is supervised per thread. Empty sessions are marked
non-restorable because ZCode does not persist them until a turn starts. Saved
conversations resume by native session ID; resume failure is reported rather
than silently replacing the conversation.

bb archive, unarchive and rename actions are bb-local: the native protocol
has no title or archive API, ZCode title generation stays off, and names
live in bb. Clearing a thread goal calls the native `session/goal` clear
action and requires that thread's active session.

## Troubleshooting

| Symptom                          | What to check                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------------- |
| ZCode executable not found       | Set `executable` explicitly and check the host path.                                                |
| A JavaScript CLI will not start  | Point `nodeExecutable` to Node.js 24+ on that host.                                                 |
| No usable model appears          | Update the plugin, connect Coding Plan or a personal provider in ZCode, then refresh models.        |
| Coding Plan authentication fails | Reconnect individual Coding Plan in ZCode Desktop on the same machine, then start a new bb session. |
| Install cannot connect to bb     | Start bb, or check `BB_SERVER_URL` for a separate instance.                                         |
| An older session cannot resume   | Check the CLI version and native session data; retain the error and session ID.                     |

## Build and live checks

`npm run build` uses bb's plugin builder and emits `dist/server.js`,
`dist/host.js`, source maps, and SDK metadata. Generated `dist` files are not
committed. Without the desktop app, `bb-app@0.46.1` can supply the build CLI.

`npm run test:live` creates an isolated workspace and loopback model server.
Its processes and listener are closed at the end; the printed temporary
evidence directory is retained.

For the optional full bb check, install the plugin in a **disposable bb
instance** and set `BB_SMOKE_SERVER_URL`, `BB_SMOKE_DATA_DIR`, and, if needed,
`BB_HOST_DAEMON_PORT`. This check changes that instance's ZCode executable
setting and creates a project/thread. Do not target a normal bb profile.

Upstream contracts:
[provider API](https://github.com/get-bb/bb/blob/main/docs/provider-plugin-api.md),
[bridge protocol](https://github.com/get-bb/bb/blob/main/docs/provider-bridge-protocol.md),
[ZCode protocol](https://github.com/zai-org/ZCode/blob/main/packages/shared/src/zcode-protocol/index.ts).

## Background work, forks and rewind

Use bb's normal **Fork** and edit-message/rewind actions. Each completed native
assistant turn exposes a checkpoint. A fork copies conversation history up to
that checkpoint into a separate native session, then resumes it with the new
thread's tools and settings. Forking into another bb environment is supported.
The source conversation and workspace files are preserved. A tip fork requires
an idle conversation with a stable assistant reply; empty/unfinished tips fail.

Checkpoint tokens bind a native session, persisted message identity and content
hash. On native restart the bridge resolves the same entity in the new history
epoch, then uses its current row ID and revision. Missing/changed targets and
native stale/rejected command acknowledgements fail explicitly; no later turn
is silently substituted. Lookup is bounded to 10,000 history rows. Prompts still
work on older CLIs, but management/fork commands require compatible v4 queries.
CLI 0.16.9 on macOS is the tested baseline.

Background Bash tasks appear as task cards; background agents appear as
background delegations. They remain open after the spawning foreground turn
ends, refresh while running, and close when native state reports completion,
failure or cancellation. Native child failure closes pending cards as failed.
An idle release checks native work before detaching; use Stop to interrupt the
session and cancel its owned tasks. This does not add durable scheduling or a
complete child-session tree.

Provider commands appear in bb's command menu and `bb thread commands`:

| Command                              | Behavior                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `/zcode-tasks`                       | List task IDs and native statuses for this session                                                            |
| `/zcode-task-output <id>`            | Read up to 8 KiB of authorized native Bash output                                                             |
| `/zcode-task-stop <id>`              | Request cancellation of one active, cancellable task                                                          |
| `/zcode-file-preview [checkpoint]`   | Preview native file rollback for a turn; defaults to the latest stable reply                                  |
| `/zcode-file-rewind <preview-token>` | Apply the previewed file-only rollback in Full Access mode                                                    |
| `/zcode-check [providerId/modelId]`  | Run ZCode's native model connectivity test; one real model request                                            |
| `/zcode-plugin <action> [args]`      | Manage native ZCode plugins: list, install, update, uninstall, enable, disable, marketplace add/update/remove |

Management commands run when the foreground is idle and do not submit a model
prompt; `/zcode-check` is the exception in effect - it submits no session
prompt but does perform one real model request through ZCode. ZCode can
independently notify its model when background work completes
or is cancelled, which can produce an additional native turn and usage.
Agent output is available as task summaries; Bash output retrieval is scoped
by native session/work IDs, and never reads a caller-supplied filesystem path.

`/zcode-plugin` wraps ZCode's own plugin manager. Install, update and
marketplace operations mutate ZCode's configuration and run plugins inside
its trust boundary, exactly as if performed from ZCode itself; the bridge
adds no additional review and reports only what ZCode returns.

File rollback is separate from conversation rewind. Inspect the native preview
before applying it outside plan mode. Its session-specific token expires after
five minutes and can only be used once. History changes invalidate it, background work must
be stopped, and native file safety checks reject external modifications or
missing checkpoints. Native Bash edits are reported as ignored rather than
claimed as restorable. The bridge does not implement arbitrary filesystem undo.
