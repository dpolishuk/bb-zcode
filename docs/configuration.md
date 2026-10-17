# Configuration

## Launch settings

| Setting          | Default     | Purpose                                                             |
| ---------------- | ----------- | ------------------------------------------------------------------- |
| `executable`     | Auto-detect | Native executable or `.cjs` / `.mjs` / `.js` CLI path               |
| `nodeExecutable` | `node`      | Node.js 24+ executable for a JavaScript CLI bundle                  |
| `args`           | `[]`        | JSON array of arguments before `app-server`, passed without a shell |

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

ZCode's own configuration environment is inherited. Arguments are passed as
an argv array; there is no shell interpolation.

## Models

Model IDs use `providerId/modelId`; model and reasoning options come from
ZCode. Unsupported or stale reasoning choices fall back to a native model
default, as required by bb's bridge contract.

The fallback **ZCode models unavailable** entry appears while the catalog is
unavailable. It does not prove that a provider is authenticated. Likewise,
health checks verify protocol/catalog availability, not model connectivity.

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
