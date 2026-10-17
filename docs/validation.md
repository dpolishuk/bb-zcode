# Validation record

Verified locally on 2026-10-17, macOS. The checks below concern the source
checkout and an isolated bb installation, not a marketplace release.

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

## CONFIG_VALIDATED

`npm run check` runs TypeScript checking, 20 automated tests, and bb's plugin
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
- ZCode subscription-plan authentication is not implemented. The CLI asks its
  desktop host for signed runtime headers; the adapter reports that limitation
  explicitly and does not copy desktop credentials.
- Real native approval prompts are covered by synthetic protocol fixtures, not
  the live model fixture. Live mode changes were verified.
- Attachments, live steering, forks, manual compaction, and bb-injected tools
  and skill roots are outside this version's supported scope.
- ZCode's source labels this session API legacy. A future CLI update may require
  adapting to its newer desktop protocol.
- The plugin was installed in an isolated test instance. Publishing the source
  repository does not establish npm-package, marketplace, or tagged-release
  installation evidence.
