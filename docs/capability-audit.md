# ZCode capability audit

Research date: **2026-10-18**. Audited plugin: **v0.2.0**, commit
`7e8ce2d46976e6574e9136ce608d4c2182f824db`.

**The plugin does not support all ZCode capabilities.** It implements the core
text-session workflow, native model/reasoning discovery, and individual Coding
Plan authentication. Several runtime features are disabled, host-dependent
tools have no implementation, and much of ZCode's session and presentation
protocol is not mapped into bb.

This is a source and contract audit with synthetic probes. It is not proof that
every native tool works against a production model. A coverage percentage would
be misleading: native CLI behavior, host services, and desktop UI features have
different integration requirements.

## Re-verification: unchanged upstream surface and remaining gaps (2026-10-20)

The upstream protocol surface was re-diffed against the v0.5.0 refresh pin
[ZCode 0a1fc56][zcode-tree] as of 2026-10-20 ([main @ 3c5b227][zcode-main]):
the 110 protocol methods and the v4 command set are unchanged (nothing added
or removed), so the baseline matrix below is still current and there are no
unaudited native features. The adapter itself uses roughly twenty of those
methods; the missing groups below were re-confirmed in the v0.5.0 source at
commit `5dbed52`.

| Gap group                   | Detail                                                                                                                                                                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host reverse-RPC services   | `interaction/browserList` / `interaction/browserExecute`, `bot/channel/reply` - rejected; `automation/*` (5 methods) served locally since v0.10.0; `offPeak/*` (2) served via the Z.ai gateway since v0.11.0                                                               |
| MCP Apps / Gen UI           | All 16 `mcp/ui*` methods (sampling, app instances, page tools) have no bridge                                                                                                                                                                                              |
| Process telemetry           | `process/*` (7 methods: networkCapture, resourceSample, toolExecResource, …) not forwarded                                                                                                                                                                                 |
| Native ZCode plugin manager | All 20 `plugins/*` methods (install/update/marketplace/referenceCatalog/…) remain outside the bridge                                                                                                                                                                       |
| Session and product gaps    | `session/goal` (the bridge answers `threadGoalClear: false`), Highspeed and Start/Team execution modes, rich diffs (generic rows), full subagent tree, archive/rename, service tier, billing cost, and `provider/testModelConnectivity` (health is not model connectivity) |

These rows confirm the existing matrix sections below, which remain the
authoritative baseline inventory together with the reproduced dispatch-level
probes.

## Implementation update: v0.5.0

The background-task and history priorities now have a bounded implementation:

| Audited gap                | v0.5.0 status                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Background work            | Thread-scoped Bash task cards and agent delegations survive foreground settlement; native polling/events update terminal states |
| Task management            | Native task list, bounded Bash output and scoped per-task cancellation; idle release guard and interrupt/crash settlement       |
| Native bb forks and rewind | Completed-turn checkpoints, exact historical/tip fork and cold native resume in an independent child session                    |
| Persistent targets         | Native message identity and content hash verified after restart; current revision/epoch CAS; no later-checkpoint fallback       |
| Workspace file rewind      | Separate native preview/apply commands; expiring single-use preview, Full Access gate, native conflict checks                   |
| Protocol migration         | Read-only v4 history negotiation and bounded control commands alongside the existing legacy prompt/event lane                   |

This is a control adapter, not a complete v4 subscription/fragment transport
migration. Full child-session trees, rich file/plan views, browser host services,
workflows/scheduling and remaining account plans still need work. Native
background notifications can independently trigger model turns. Real-CLI
verification uses deterministic loopback inference and temporary files; paid
production inference remains unverified. See the [validation record](validation.md).

## Implementation update: v0.4.0

The next ecosystem priority adds:

| Audited gap             | v0.4.0 status                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bb-injected tools       | Opt-in session-scoped authenticated MCP handoff to bb's tool dispatcher; schemas, presentation, text/images, errors, stop/crash cancellation and resume |
| bb-injected skill roots | Catalog of original SKILL.md paths; native Read loads the files. Not a native Skill-registry injection                                                  |
| Custom subagents        | Validated native configuration snapshots, built-in/plugin model overrides and startup callback with session identity checks                             |
| Nested tool activity    | Parent references retained; Bash command rows and bounded output snapshots/final output                                                                 |
| Child interactions      | Real native custom-agent question round-trip verified against deterministic fixtures; production accounts remain separate                               |

This completes the bounded tools/skills/configuration portion of priority 4.
Full subagent trees, background-task lifecycle and rich diffs still need work.
Browser control still needs a browser host provider; forks/rewind require the
current-protocol adapter described in priority 5. Larger account/desktop host
features remain separately scoped. See the [validation record](validation.md).

## Implementation update: v0.3.0

The original matrix below is pinned to v0.2.0. The v0.3.0 update implements the
first priorities and several adjacent gaps:

| Audited gap                   | v0.3.0 status                                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Queued follow-ups             | Implemented FIFO delivery, stop cancellation, replay deduplication and no-active-turn recovery; bb owns expected-turn validation |
| Attachments                   | Local images/files, data-URL images and bounded HTTPS images; real native fixture covers PNG and text files                      |
| Structured mentions           | Reference metadata is preserved as model-visible text; cross-thread/project content is not automatically retrieved               |
| Manual compaction             | Native operation, with event and state-update completion handling                                                                |
| Usage/context                 | Native token/cache/reasoning totals and estimated context meter; saved totals restored on resume; billing cost still absent      |
| Other saved model options     | Preserved while changing reasoning; no new model-options UI                                                                      |
| Configured MCP servers        | Native startup injection on create/resume; real native stdio tool execution tested                                               |
| Official Coding Plan MCP auth | Default-origin, workspace/account-scoped identity headers; synthetic fixtures only                                               |
| Memory and enhanced search    | User-configurable settings, off by default; native memory extraction/recall remains unverified                                   |

Browser control, forks/rewind, rich tool views, bb tools/skills, advanced account
plans, interactive plugin UI, workflows and scheduling remain follow-up work.
See [configuration](configuration.md) and the [validation record](validation.md)
for the supported subset and evidence boundaries.

## Baseline and evidence

| Component                  | Audited baseline                                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| bb-zcode                   | [v0.2.0 source][plugin-tree]                                                                                                     |
| ZCode upstream             | [aac4755][zcode-tree], verified against GitHub `main` on the research date                                                       |
| bb upstream contracts      | [46da846][bb-tree], fetched on the research date; provider docs and SDK paths were unchanged from the earlier inspected snapshot |
| Installed runtime baseline | ZCode CLI 0.16.9; bb 0.46.1 and SDK 0.6.49 used for the existing release validation                                              |
| Fresh local check          | `npm test`: **45/45 tests passed** on macOS / Node 26.5.0                                                                        |
| Published commit CI        | [Successful run for 7e8ce2d][ci], status rechecked                                                                               |

Evidence labels used below:

- **Implemented:** an explicit bridge path exists and is covered by existing
  tests or release validation. This does not imply production model verification.
- **Partial:** only part of the native behavior is bridged.
- **Missing / Disabled:** the path is absent, rejected, or explicitly switched off.
- **Inherited / UNVERIFIED:** ZCode can provide this internally; the bridge does
  not independently implement it, and the feature has not been exercised through bb.
- **Host integration:** requires additional host services or UI, beyond forwarding
  a model prompt.

The [validation record](validation.md) documents earlier real-CLI tests with
synthetic inference, native marketplace installation, and live Z.ai account/model
discovery. Those runs were not repeated for this audit. Paid inference and
production gateway signing remain **UNVERIFIED**; the Coding Plan fixture used
ZCode's unsigned fallback after a synthetic signing-service HTTP 503.

## Core sessions and model configuration

| Capability                                      | Status                             | Evidence and practical limit                                                                                                                                                                                                                                       |
| ----------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Start a local coding session                    | Implemented                        | Creates a native session in bb's working directory and subscribes to its events. [Bridge][bridge-create]                                                                                                                                                           |
| Text prompts and streamed answers               | Implemented                        | Maps text, reasoning, turn start/end, and error events. [Send][bridge-send], [timeline][timeline]                                                                                                                                                                  |
| Native model list and reasoning effort          | Implemented                        | Uses each available model's advertised reasoning levels and default; forwards `reasoningLevel` per turn. The existing Coding Plan validation found GLM-5.3 / GLM-5.3-Flash with low/high/max. [Model selection][protocol-model], [validation](validation.md)       |
| Other native model/session options              | Partial                            | The model-selection object is rebuilt with reasoning only; no bb session-option catalog is published. Service tiers are declared unsupported. Do not assume other saved selection options survive. [Model selection][protocol-model], [registration][registration] |
| Personal API providers                          | Implemented, production UNVERIFIED | Uses the native configured catalog/runtime. Real CLI + loopback model tested; production personal-provider authentication has not been exercised. [Validation](validation.md)                                                                                      |
| Individual Coding Plan                          | Implemented, bounded               | Existing Desktop sign-in, entitlement, scoped runtime auth, token refresh and account-change handling. Z.ai discovery was live; BigModel flow has fixture coverage. No login UI inside bb. [Account host][account], [validation](validation.md)                    |
| Start Plan / Team plans                         | Missing                            | Account-access schema accepts only `individual-coding-plan`. [Account schema][account-schema]                                                                                                                                                                      |
| Highspeed / Off-Peak access and execution modes | Missing                            | No corresponding execution metadata, account-mode flow, or tool gate is forwarded. Native contracts expose these separately from reasoning effort. [Native commands][native-commands], [native startup][native-startup]                                            |
| Plan/build/yolo modes                           | Partial                            | Plan maps to `plan`, full access to `yolo`, and both bb `auto` and `accept-edits` map to `build`. The two bb policies do not receive distinct native mappings. [Mode mapping][bridge-methods]                                                                      |
| Approval prompts and questions                  | Implemented, partial fidelity      | Single-use allow/deny and user answers are translated. Persistent grants, richer native choices, and question auto-resolution are not exposed. [Interactions][bridge-interactions], [preferences][preferences]                                                     |
| Tool denylist / initial bb instructions         | Partial                            | Denylist reaches native creation/resume. Instructions are prepended to the first fresh input; there is no separate native system-instruction mapping. [Creation][bridge-create], [send][bridge-send]                                                               |
| Stop, release, cold resume                      | Implemented                        | Stops/releases the child and resumes the saved native session. bb owns its existing transcript; arbitrary ZCode history is not imported into a new bb timeline. [Lifecycle][bridge-create]                                                                         |
| Images and file attachments                     | Missing, rejected                  | Any non-text input is rejected, including SDK-valid `image`, `localImage`, and `localFile`. Native ZCode accepts attachment material. [Send][bridge-send], [native commands][native-commands]                                                                      |
| Structured mentions / quoted context            | Missing                            | Text bodies are concatenated; mention metadata is not translated. Native browser context, conversation quotes, and imported context references have no mapping. [Send][bridge-send], [native commands][native-commands]                                            |
| Follow-up while a turn is running               | Missing, contract mismatch         | Handshake says `steerMode: "queue"`, but every valid `turn/steer` request is rejected. bb does not implement that queue on the bridge's behalf. [Handshake][handshake], [handler][steer], [bb semantics][bb-steer]                                                 |
| Manual compaction                               | Missing                            | Declared false; no special `/compact` mapping. bb expects the bridge to translate the normal `/compact` prompt into a provider command. [Registration][registration], [bb compact contract][bb-compact]                                                            |
| Automatic native compaction                     | Inherited / UNVERIFIED             | The bridge does not implement or validate native automatic context management. Its lack of a manual compact button does not establish that native automatic compaction is disabled.                                                                                |
| Fork, edit/retry, rewind/checkpoints            | Missing                            | No fork handler; no translation of native edit/retry/file rewind operations or checkpoint presentation. [Handshake][handshake], [native commands][native-commands]                                                                                                 |
| Goals and goal lifecycle                        | Missing                            | No structured goal command/clear/status integration. Sending literal slash-command text has not been verified as a substitute. [Handshake][handshake], [native commands][native-commands]                                                                          |
| Archive / rename synchronization                | Missing                            | Both declared unsupported; native title generation is disabled. bb may still manage its own local labels. [Registration][registration], [creation][bridge-create]                                                                                                  |

## Tools, context, skills, and extensions

| Capability                                                    | Status                         | Evidence and practical limit                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native file/shell/search tools                                | Inherited / partially verified | Executed by ZCode; generic tool events and approvals are bridged. Existing tests exercise event handling, not a complete production coding-tool run. [Timeline][timeline], [validation](validation.md)                                                                                                                            |
| Rich diffs, file/search cards, plans, incremental tool output | Partial                        | Tool start/result/error becomes a generic row. There are no specialized diff, plan-step, delegation, or background-task renderers. [Timeline][timeline]                                                                                                                                                                           |
| Token usage, context meter, cost                              | Missing                        | No bb `usage` or `contextWindow` deltas, no usage query integration; provider usage maintenance is disabled. Native usage surfaces and bb rendering contracts already exist. [Timeline][timeline], [registration][registration], [native registry][native-registry], [bb usage][bb-usage]                                         |
| Persistent memory                                             | Disabled                       | `memoryEnabled: false` is returned to the runtime, which overrides memory configuration. This is separate from saved conversation/resume support. [Preferences][preferences], [native startup][native-startup]                                                                                                                    |
| Enhanced native search                                        | Disabled subset                | `nativeSearchEnhancementsEnabled: false` disables the enhanced find/grep path. This does not disable every ordinary search tool or establish whether WebSearch works. [Preferences][preferences], [native tool execution][native-search]                                                                                          |
| Native skills and content plugins                             | Inherited / UNVERIFIED         | ZCode loads its configured skills and plugin content. A skill can still reference a missing host service; loading its text does not prove it can complete its task. [CLI plugin guide][cli-plugins], [native app composition][native-app]                                                                                         |
| bb-injected skill roots                                       | Missing                        | `skills.configure: false`; no `skills/configure` implementation. The plugin's own packaged bb skill is not automatic forwarding of all bb skills. [Handshake][handshake], [bb skill contract][bb-skills]                                                                                                                          |
| bb-injected tools                                             | Missing                        | `dynamicTools` is not used and the bridge never calls bb's `item/tool/call`. Native tools do not substitute for tools supplied by other bb plugins. [Creation][bridge-create], [bb tool contract][bb-tools]                                                                                                                       |
| CLI-configured MCP servers                                    | Inherited / UNVERIFIED         | Native `~/.zcode/cli/config.json` and enabled plugin MCP configuration may load. No complete MCP transport/auth/resource suite has been run through bb. [CLI MCP guide][cli-mcp], [native app composition][native-app]                                                                                                            |
| ZCode Desktop MCP settings                                    | Missing handoff                | App-server does not read Desktop's MCP store itself. The host must provide resolved `mcpServers` at create/resume; bb-zcode supplies none. [Native startup][native-startup], [creation][bridge-create]                                                                                                                            |
| Official Coding Plan MCP authentication                       | Missing, rejected              | `interaction/requestOfficialMcpAuthHeaders` has no handler. Its native payload is workspace-scoped, so the bridge's generic session check rejects it before the unknown-method branch. Model authentication support does not cover this separate auth flow. [Native auth port][official-mcp], [interactions][bridge-interactions] |
| Browser Use                                                   | Missing host service           | Native browser control calls `interaction/browserList` / `interaction/browserExecute`; both are rejected. Browser Use content is bundled and default-enabled upstream, making this a likely user-visible failure. [Browser broker][browser], [CLI plugin guide][cli-plugins]                                                      |
| Default subagents                                             | Inherited / UNVERIFIED         | Native Agent execution can remain available. Upstream reroutes child approvals and provider auth through the parent, so root-session validation alone is not evidence that subagents are broken. [Child ports][child-ports], [native subagent][native-subagent]                                                                   |
| Custom subagent settings, tree, per-task lifecycle            | Partial / Missing              | Custom runtime-config lookup is explicitly disabled. No child-session discovery, nested delegation view, or specific background-work cancellation is mapped. Mirrored child tool rows may still appear as generic rows. [Preferences][preferences], [timeline][timeline], [native registry][native-registry]                      |
| Hooks                                                         | Inherited / UNVERIFIED         | CLI-configured hooks can be loaded natively; no bb controls or explicit workspace hook-trust flow are implemented. Do not promise all workspace hooks execute. [CLI hooks guide][cli-hooks], [native startup][native-startup]                                                                                                     |
| ZCode plugin/MCP management                                   | Missing controls               | No bridge/UI for native plugin discovery, install/configure/update, MCP resources, or plugin reference catalogs. bb's marketplace installs **bb-zcode**; it does not implement ZCode's separate marketplace. [Native registry][native-registry]                                                                                   |
| MCP Apps / Gen UI                                             | Missing host integration       | No app-instance, sampling, resource subscription, page-tool, or generated-HTML bridge. Upstream itself limits interactive pages to local ZCode Desktop workspaces. [Official UI plugin guide][ui-plugins]                                                                                                                         |

## Host and product features

| Capability                                                                        | Status                                                  | Evidence and practical limit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheduled jobs / automation                                                       | Implemented (v0.10.0, review fixes in v0.10.1), bounded | With `automationsEnabled` the bridge answers the native `automation/*` ports from a workspace-scoped local store, runs schedules while bb is open (cold-resume of the bound session with the saved model/mode and the native automation marker), and exposes `/zcode-automations`. Off by default; busy threads defer instead of failing; missed runs while bb is closed are skipped; runs are at-least-once across worker restarts. Off-Peak tasks ship in v0.11.0 behind `offPeakTasksEnabled`: the bridge hosts the Z.ai ticket gateway flow (create/poll/settle) and runs ready tasks with the plan's idle-time provider; workspace-scoped store, 3102 continuation, fixture coverage only (live gateway unverified). [Automation host](https://github.com/dpolishuk/bb-zcode/blob/main/src/automations.ts), [Automation port][automation] |
| Dynamic workflows                                                                 | Implemented (v0.12.0), bounded                          | `dynamicWorkflowsEnabled` (off by default) opens the native fail-closed gate with an explicit boolean on create and resume; the tool family, skill gate, approval, runs and `<task-notification>` wake turns are native, POC-verified on CLI 0.17.0 ([workflow contract](https://github.com/dpolishuk/bb-zcode/blob/main/knowledge/contracts/dynamic-workflow-protocol.md)). Rich timeline rendering (stage 9) is not built; the tool row shows the text summary. [Native startup][native-startup], [native commands][native-commands], [native registry][native-registry]                                                                                                                                                                                                                                                                     |
| Topic resources / bot replies                                                     | Missing host service                                    | Native topic/channel port needs host reverse requests absent from the bridge. [Topic port][topics]                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Connectivity / account health / quotas                                            | Partial                                                 | Health verifies protocol response and model availability, explicitly not model connectivity. Plan details, quotas, account identity, and installation version are not returned. [Health][health]                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Runtime installation and update                                                   | Missing management                                      | bb can install/update this plugin, but the plugin does not install/update ZCode or Node. [Registration][registration]                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Desktop browser panels, GUI computer use, workspace UI, remote SSH/WSL management | Separate host integrations                              | Launching the local CLI does not reproduce ZCode Desktop's host services. Running the plugin on a bb remote host may be possible but is unverified; native remote workspace identities are not forwarded. [Launch][launch], [ZCode overview][zcode-tree]                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Other operating systems                                                           | UNVERIFIED                                              | Launch discovery includes platform handling; only macOS has the documented live validation. [Validation](validation.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## Reproduced gaps

An in-process synthetic peer was injected through `createBridge`'s test seam,
with a synthetic account host. No real account state, credentials, model API,
browser, or scheduler was used. bb prompt payloads were validated with the
installed SDK schemas before dispatch.

| Probe                                                                       | Observed result                                                                                                                              |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `image`, `localImage`, `localFile` through `turn/start`                     | All rejected with `-32602`: attachments unsupported                                                                                          |
| `turn/steer` after session creation                                         | `-32000`: live steering unsupported, despite `queue` handshake                                                                               |
| Browser list / execute callbacks                                            | Both rejected with `-32601`: host capability not implemented                                                                                 |
| Workspace-scoped official MCP auth callback                                 | `-32602`: session mismatch; no auth handler                                                                                                  |
| Sessionless `automation/list` callback                                      | v0.10: automation ports need a session (workspace-scoped answers); sessionless calls ask for a session; without the setting, disabled errors |
| Runtime-preferences callback                                                | Memory, enhanced search, custom subagent runtime configuration, and question auto-resolution all false                                       |
| `session.updated`, `checkpoint.created`, `part.upserted` passed to timeline | No deltas emitted                                                                                                                            |

These are dispatch-level reproductions and translator probes, not end-to-end
native executions of those tools. The initial probe was corrected to use the
SDK's required `clientRequestId` format before results were recorded.

## Recommended implementation order

1. **Make unsupported behavior predictable.** Implement actual queued follow-up
   delivery with acceptance, ordering, cancellation, and stale-turn recovery.
   Add capability checks and actionable errors for host-dependent tools; where
   possible, omit unavailable tool capabilities from the model's tool surface.
   Do not weaken session/auth checks to make unknown callbacks pass.
2. **Complete ordinary coding-session UX.** Add attachments and structured
   references, usage/context reporting, explicit manual compaction, and useful
   file/command/plan presentations. Map bb's existing `/compact` pipeline; do not
   invent a new bb compact RPC. Expose memory as a deliberate setting with
   verified persistence and isolation.
3. **Complete the Coding Plan tool path.** Implement official MCP auth with its
   own origin/plugin/account validation. Resolve and inject intended MCP
   configuration. Add browser host control only with an actual browser provider
   and permission/lifecycle implementation; installing the browser skill alone
   is insufficient.
4. **Integrate extension and agent ecosystems.** Forward bb dynamic tools and
   skill roots, expose custom subagent settings, then map nested activity and
   background-task lifecycle. Verify child auth, approvals, failure, cancellation,
   and resume against the real native runtime with deterministic fixtures.
5. **Extend lifecycle support on the current native protocol.** ZCode labels
   `session/send` and `session/stop` compatibility paths deprecated, while its
   current v4 commands cover queueing, forks, edit/retry, rewind and background
   work. Establish supported CLI versions and a capability-negotiated adapter
   before expanding those features. Current attachment/compact paths do not
   require waiting for a wholesale protocol rewrite. [Legacy status][native-registry],
   [v4 command contract][native-commands]
6. **Scope larger host features separately.** Start/Team/Highspeed/Off-Peak,
   scheduling, workflows, MCP Apps, Gen UI and desktop/remote services each need
   their own host integration and acceptance tests. They should not be implied by
   a general claim of full ZCode support.

For each implemented feature, require SDK contract tests, real native-runtime
fixture tests, and a fresh installed-plugin bb check. Keep optional production
model/account tests separately labeled. A broad support claim should wait until
the feature matrix and those verification results agree.

## Audit limitations

This inventory groups user-facing capabilities across the native protocol,
runtime startup, reverse host requests, official CLI/extension docs, and bb's
provider contracts. It is not an enumeration or runtime certification of every
native tool, model, plugin, feature flag, or desktop setting. Upstream source can
also contain gated features unavailable to a particular account or installed
release. The pinned sources make the conclusions reviewable as those surfaces
change.

[plugin-tree]: https://github.com/dpolishuk/bb-zcode/tree/7e8ce2d46976e6574e9136ce608d4c2182f824db
[zcode-tree]: https://github.com/zai-org/ZCode/tree/aac4755666d09fdcd70272fcf063c077a639015f
[zcode-main]: https://github.com/zai-org/ZCode/tree/3c5b227649371507ddc4eb46ac5133afe6db1cab
[bb-tree]: https://github.com/get-bb/bb/tree/46da8461c107ee9dc95480a16fa17decaca2cc5d
[ci]: https://github.com/dpolishuk/bb-zcode/actions/runs/39071157771
[registration]: https://github.com/dpolishuk/bb-zcode/blob/7e8ce2d46976e6574e9136ce608d4c2182f824db/server.ts#L59-L83
[bridge-methods]: https://github.com/dpolishuk/bb-zcode/blob/7e8ce2d46976e6574e9136ce608d4c2182f824db/src/bridge.ts#L66-L83
[bridge-interactions]: https://github.com/dpolishuk/bb-zcode/blob/7e8ce2d46976e6574e9136ce608d4c2182f824db/src/bridge.ts#L231-L359
[bridge-create]: https://github.com/dpolishuk/bb-zcode/blob/7e8ce2d46976e6574e9136ce608d4c2182f824db/src/bridge.ts#L361-L509
[bridge-send]: https://github.com/dpolishuk/bb-zcode/blob/7e8ce2d46976e6574e9136ce608d4c2182f824db/src/bridge.ts#L511-L560
[handshake]: https://github.com/dpolishuk/bb-zcode/blob/7e8ce2d46976e6574e9136ce608d4c2182f824db/src/bridge.ts#L647-L663
[steer]: https://github.com/dpolishuk/bb-zcode/blob/7e8ce2d46976e6574e9136ce608d4c2182f824db/src/bridge.ts#L800-L804
[health]: https://github.com/dpolishuk/bb-zcode/blob/7e8ce2d46976e6574e9136ce608d4c2182f824db/src/bridge.ts#L714-L730
[protocol-model]: https://github.com/dpolishuk/bb-zcode/blob/7e8ce2d46976e6574e9136ce608d4c2182f824db/src/protocol.ts#L54-L78
[preferences]: https://github.com/dpolishuk/bb-zcode/blob/7e8ce2d46976e6574e9136ce608d4c2182f824db/src/protocol.ts#L114-L119
[timeline]: https://github.com/dpolishuk/bb-zcode/blob/7e8ce2d46976e6574e9136ce608d4c2182f824db/src/timeline.ts
[account-schema]: https://github.com/dpolishuk/bb-zcode/blob/7e8ce2d46976e6574e9136ce608d4c2182f824db/src/coding-plan.ts#L12-L23
[account]: https://github.com/dpolishuk/bb-zcode/blob/7e8ce2d46976e6574e9136ce608d4c2182f824db/src/coding-plan.ts
[launch]: https://github.com/dpolishuk/bb-zcode/blob/7e8ce2d46976e6574e9136ce608d4c2182f824db/src/launch.ts
[native-registry]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/packages/shared/src/zcode-protocol/index.ts#L4074-L4205
[native-commands]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/packages/shared/src/zcode-protocol-v4/command.ts#L46-L287
[native-startup]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts#L3365-L3457
[native-search]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts#L431
[native-app]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/bootstrap/src/app/create-app.ts
[official-mcp]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/official-mcp-auth-port.ts#L40-L75
[browser]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/browser-control-broker.ts#L95-L157
[child-ports]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/runtime/helpers/child-client-ports.ts#L32-L78
[native-subagent]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts#L211-L230
[automation]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/automation-port.ts
[topics]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/topic-resource-port.ts
[cli-plugins]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/README.md#L41-L58
[cli-mcp]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/README.md#L162-L203
[cli-hooks]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/README.md#L205-L220
[ui-plugins]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/UI_PLUGIN.en.md#L16-L32
[bb-steer]: https://github.com/get-bb/bb/blob/46da8461c107ee9dc95480a16fa17decaca2cc5d/docs/provider-bridge-protocol.md#L74-L79
[bb-compact]: https://github.com/get-bb/bb/blob/46da8461c107ee9dc95480a16fa17decaca2cc5d/docs/provider-bridge-protocol.md#L114-L118
[bb-usage]: https://github.com/get-bb/bb/blob/46da8461c107ee9dc95480a16fa17decaca2cc5d/docs/provider-bridge-protocol.md#L170-L211
[bb-tools]: https://github.com/get-bb/bb/blob/46da8461c107ee9dc95480a16fa17decaca2cc5d/docs/provider-bridge-protocol.md#L240-L245
[bb-skills]: https://github.com/get-bb/bb/blob/46da8461c107ee9dc95480a16fa17decaca2cc5d/docs/provider-bridge-protocol.md#L294-L305
