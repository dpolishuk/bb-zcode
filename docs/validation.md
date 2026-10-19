# Validation record

Verified locally on 2026-10-17 through 2026-10-19, macOS. The checks below cover the source
checkout, an isolated real-CLI smoke, and installation from the published
marketplace. Model connectivity remains a separate verification boundary.

## Versions and contracts

| Component                           | Verified version          |
| ----------------------------------- | ------------------------- |
| bb desktop / bundled plugin builder | 0.46.1                    |
| Published `@get-bb/plugin-sdk`      | 0.6.49                    |
| Installed ZCode CLI                 | 0.16.9                    |
| ZCode protocol reported by the CLI  | ZCode Protocol, version 1 |
| bb bridge / deltas                  | Protocol 2 / grammar 3    |
| Node used for the full bb smoke     | 26.5.0                    |

The real CLI client/bridge smoke was also run with Node 24. The full bb test
used Node 26.5.0. Linux and Windows runtime behavior remains unverified.

Reference source snapshots:

- [bb commit 6a639cf](https://github.com/get-bb/bb/tree/6a639cfc0d66e0c789a1bd7309266973228d1a80)
- [ZCode commit aac4755](https://github.com/zai-org/ZCode/tree/aac4755666d09fdcd70272fcf063c077a639015f)

The published SDK and installed applications, rather than an assumed source
build, were used for the runtime checks.

## v0.5.0: background management and history controls

The candidate passed **138 automated tests across 11 files**, including bb's
canonical bridge conformance, plus formatting, marketplace consistency,
TypeScript checking and the plugin build. A disposable bb 0.46.1 server/daemon
explicitly reinstalled the candidate's immutable build before executing native
checkpoint forks, edit-message/rewind and background list/output/cancel commands.
The full fixture reported `RUNTIME_VERIFIED`, `bbThreadVerified: true`, 43
synthetic model requests and one native background notification follow-up.
Existing tool/skill/custom-agent, attachment, queue, context and compaction
checks also passed. These installed candidate checks are distinct from a
published Git-cache installation; release notes record published-source proof.

On 2026-10-19, the real ZCode CLI 0.16.9 fixture verified completed-turn
checkpoints, conversation-only forks with a continued child model turn, and a
cold fork from an earlier checkpoint after later parent work. Native background
Bash runs survive the foreground turn, expose bounded output, accept scoped
cancellation, and settle their task cards. ZCode independently generated a
model follow-up after background settlement; management commands themselves do
not call `session/send`.

The native file fixture uses Write on a temporary file twice, inspects the
native file-rewind preview, applies its explicit token, then verifies that the
file contains its previous contents. Automated cases cover external-modification
previews, single-use/session-bound tokens, revision drift, missing/foreign/changed
checkpoints, paginated target lookup, stale/rejected/invalid acknowledgements,
restart epoch rebinding, active-tip rejection, different target workspaces,
release-before-notification and interrupt/crash settlement. Background agent
delegation mapping has synthetic projection coverage; the real background-work
fixture uses Bash. Native bb rewind is tested as a staged checkpoint fork
followed by a tip fork into the original idle bb thread.

The v0.5.0 adapter uses read-only v4 row queries and compare-and-swap commands;
it keeps legacy session streaming for model turns. Checkpoint persistence is
based on canonical native entity identity and content hash, with fresh row IDs
and watermarks after native restart. No full v4 fragmented subscription decoder
or physical replay transport is claimed.

Source contracts were refreshed against [ZCode 0a1fc56](https://github.com/zai-org/ZCode/tree/0a1fc56d279fd1001f78387bd81aec1c26767411)
and [bb 9937c46](https://github.com/get-bb/bb/tree/9937c46f5c7e369de3563eb864c8cbc4c3b9c231).
The runtime checks use the installed versions listed above, deterministic
loopback model/account services and isolated temporary workspaces. Paid
production inference and other operating systems remain **UNVERIFIED**.

## v0.4.0: bb extensions and custom subagents

On 2026-10-18, **96 automated tests**, formatting, marketplace consistency,
TypeScript checking and the plugin build passed. Tests include bb tool
forwarding, text/image responses, failures, unauthenticated and unknown calls,
stop/crash settlement order, duplicate/denied tools, default MCP inheritance,
skill catalog validation/resume, subagent configuration and startup identity,
nested tool references, streamed input reconstruction and command output.

The expanded real ZCode CLI 0.16.9 fixture exercises the authenticated local
MCP bridge, a native custom subagent asking a question through bb, native Read
loading a bb skill after cold resume, and a Bash command whose final output is
retained in bb's command row. It also repeats the existing attachments,
follow-up queue, usage/context, compaction, configured stdio MCP, account-auth
fixtures and cold-resume checks.

A fresh disposable bb 0.46.1 instance installed the v0.4.0 candidate and a
synthetic companion plugin. Its native dispatcher executed that plugin's tool,
loaded its selected skill file, and created a configured custom subagent. The
full run reported `RUNTIME_VERIFIED`, `bbThreadVerified: true`, 30 model
requests, one installed tool result, one installed skill read and three
custom-agent model requests (direct and installed checks combined).

The bb tool bridge is opt-in. The default preserves native CLI MCP inheritance;
when enabled, the host-supplied MCP list replaces that CLI list. Additional
custom servers must be listed in the plugin's MCP setting. Native plugin MCP
servers are still composed by ZCode. Skill support is a catalog of original
files read by native tools, not insertion into ZCode's native Skill registry.

All model and account services in these fixtures are synthetic. Production
inference, official MCP access, native memory behavior, all subagent profile
options, full background-task lifecycle, forks/rewind and browser host services
remain **UNVERIFIED** or unsupported as described in the capability audit.

## v0.3.0: priority capability expansion

On 2026-10-18, all **80 automated tests**, TypeScript checking, formatting,
marketplace consistency and the plugin build passed. The new tests exercise
queued delivery, stale-turn recovery, stop/crash cancellation, replay
deduplication, file/image inputs, bounded HTTPS images, reference preservation,
native compaction, usage/cache accounting, cold-resume totals, saved model
options, MCP startup configuration and official MCP credential scope.

The real ZCode CLI 0.16.9 smoke also passed with isolated data and synthetic
model/account services. It verified PNG and text-file attachments, two queued
follow-ups, usage/context deltas, compaction completion, stdio MCP startup and
actual MCP tool execution, release and cold resume.

A fresh disposable bb 0.46.1 server/daemon installed and loaded the v0.3.0
candidate. The full check used bb's native CLI to create a thread, submit a
follow-up while it was running, correlate both accepted inputs and completions,
upload an image and text file, compact the thread and read its context meter.
The final smoke reported `bbThreadVerified: true` with 13 synthetic model
requests. These checks used loopback ports 56392/56393 and a separate data
directory. They did not send a production inference request.

Official MCP authentication has encrypted Z.ai/BigModel credential fixtures,
destination-origin checks, workspace isolation and logout/account-change
coverage. Production official MCP access, custom service origins and Team plans
remain unverified or unsupported as documented. The memory/search settings are
validated as runtime preferences; production memory extraction/recall is not
certified by enabling them.

## CONFIG_VALIDATED

`npm run check` runs TypeScript checking, 80 automated tests, and bb's plugin
builder. The suite covers:

- The published SDK's bridge conformance suite and public-SDK-only import scan.
- Session identity, text/reasoning/tool deltas, prompt rejection, and events
  arriving before the native send acknowledgment.
- Approval allow/deny and user-question round trips.
- Stop ordering, terminal boundaries, release, cold resume, and process failure.
- Split UTF-8 frames, malformed/oversized frames, and bounded request timeouts.
- Native model defaults, model IDs, and launch arguments containing spaces or
  shell metacharacters.

The synthetic process tests validate adapter behavior, not the native CLI's
approval engine. CI is configured in `.github/workflows/ci.yml`; per-commit
results are available in [GitHub Actions](https://github.com/dpolishuk/bb-zcode/actions).
Hosted CI does not run the installed native CLI smoke.

Formatting checks passed, both built modules imported without starting a CLI
process, and `npm audit` reported zero known dependency vulnerabilities.

## RUNTIME_VERIFIED: real CLI with a synthetic model

`npm run test:live` starts the installed ZCode CLI with an isolated HOME,
provider configuration, workspace, and a deterministic Anthropic-compatible
SSE fixture bound to loopback. It verifies native session creation,
subscription, mode changes, a streamed turn, process shutdown, and cold resume.
It repeats prompt/streaming/release/resume through the plugin bridge and checks
that an empty session is not advertised as durable.

A separate bb server/daemon was started on loopback ports 49836/49837 with its
own data directory. The plugin was built, installed, and loaded there with
status `running`. The optional full bb smoke verified:

1. Changing plugin launch settings reaches sessionless model discovery.
2. bb receives the native `bb-smoke/fixture` model and reasoning choices.
3. bb creates a project and ZCode thread and completes a turn through the plugin.
4. `bb thread output` returns exactly `Hello from the local fixture.`

Final observed smoke summary:

```json
{
  "status": "RUNTIME_VERIFIED",
  "protocol": { "name": "ZCode Protocol", "version": 1 },
  "modelCount": 1,
  "modelRequests": 3,
  "bbThreadVerified": true,
  "modelBackend": "synthetic loopback fixture",
  "realProviderAuthenticationTested": false
}
```

To repeat the full bb check with a disposable instance on these ports, replace
the data-directory placeholder with that instance's absolute path:

```sh
BB_HOST_DAEMON_PORT=49837 \
BB_SMOKE_SERVER_URL=http://127.0.0.1:49836 \
BB_SMOKE_DATA_DIR=/absolute/path/to/disposable-bb-data \
npm run test:live
```

That bb instance was disposable. The opt-in test changes its ZCode executable
setting; do not use a normal bb profile for this command. The test prints its
isolated evidence directory and retains it locally for inspection.

## UNVERIFIED and current limits

The isolated bb server and daemon were stopped after validation; neither test
port was listening afterward. Retained temporary directories are evidence only.

- Personal provider authentication, paid model connectivity, and real coding
  tool execution have not been exercised against a production model.
- Individual Coding Plan account discovery is verified as described below;
  paid inference, Start Plan, and Team-plan authentication are not verified.
- Real native approval prompts are covered by synthetic protocol fixtures, not
  the live model fixture. Live mode changes were verified.
- Forks, in-flight guidance, rich tool views, bb-injected tools/skills, browser
  host control, interactive plugin UI, and workflow/scheduler services remain
  outside this version's supported scope. Queued follow-ups and manual
  compaction are supported in v0.3.0.
- ZCode's source labels this session API legacy. A future CLI update may require
  adapting to its newer desktop protocol.
- No npm package or tagged-release installation has been verified.

## v0.2.0: individual Coding Plan and reasoning

On 2026-10-18, the installed macOS ZCode CLI 0.16.9 completed account discovery
using the existing encrypted Z.ai Desktop sign-in. The plugin successfully
resolved a short-lived project token, verified the active subscription, pushed
the account overlay, and received GLM-5.3 and GLM-5.3-Flash with `low`, `high`,
and `max` reasoning (`max` as the native default). No production model prompt
was sent. BigModel's corresponding API flow is covered by fixtures only.

The 45-test suite includes encrypted credentials, fixed endpoint/header rules,
token expiry and rejection, concurrent refresh, cancellation, logout/account
switches, session/provider/model/scope mismatches, missing keys, invalid
subscriptions, oversized/failed responses, safe diagnostics, and continued
personal-provider operation when account initialization fails.

`npm run test:live` also runs a real native Coding Plan session against a
synthetic account API and HTTPS loopback inference endpoint. It verifies the
account overlay, runtime-auth reverse RPC, credential delivery, native effort
selection, and streamed completion. OpenSSL is required to create the fixture's
temporary TLS certificate; only the test child trusts that certificate.
The synthetic signing endpoint returns HTTP 503, exercising ZCode's own
unsigned fallback. This does **not** verify production gateway signatures or
paid inference. No production credentials enter this fixture.

The local runtime run observed efforts `disabled`, `high`, `high` across the
direct CLI, personal-provider bridge, and Coding Plan bridge turns. One account
authorization and one authenticated model request completed. Raw child-I/O
recording is disabled in the plugin to keep auth responses out of bb traces.

## RUNTIME_VERIFIED: published native marketplace

On 2026-10-17, a fresh isolated bb 0.46.1 server/daemon accepted the published
Git source `git:https://github.com/dpolishuk/bb-zcode.git@main`, resolved commit
`20634f1da5c6a94b62c51c8b8f65c3ca68b51e3b`, and reported one catalog entry with
no refresh error.

After removing that test catalog, the HTTPS source was added through bb's
**Settings → Plugin marketplaces** UI:

```text
https://raw.githubusercontent.com/dpolishuk/bb-zcode/main/marketplace.json
```

Native search reported `zcode@bb-zcode` as compatible, with its author,
overview, and resolved Git source. Running `bb plugin install zcode@bb-zcode`
through the native CLI downloaded and built the published commit into bb's
managed cache. The result reported:

```json
{
  "id": "zcode",
  "version": "0.1.0",
  "provenance": "catalog",
  "catalogEntryId": "zcode",
  "catalogMarketplaceName": "bb-zcode",
  "enabled": true,
  "status": "running",
  "providerIds": ["zcode"]
}
```

The ordinary repository-page URL was also tested and rejected with HTTP 422:
GitHub page data is not a bb marketplace manifest. This confirms the need for
the raw manifest URL or `git:` form on bb 0.46.1.

These are published-source catalog and managed-install checks. They do not
change the model-authentication limits documented above, and they did not
install or reconfigure the user's normal bb profile.
