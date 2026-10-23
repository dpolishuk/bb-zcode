---
type: decision
title: ZCode Desktop host services cannot be proxied by attaching to the running app
description: Why "connect to the running ZCode Desktop over RPC" was investigated and rejected as an alternative to the missing bb host-service channel - ephemeral loopback ports, launch-scoped handles, peer validation.
status: stable
stale_after: 2027-01-23T00:00:00Z
tags: [decision, host-services, zcode-desktop, browser-control]
sources:
  - title: ZCode Desktop 3.16.2 app bundle, out/host/index.js and out/scheduler/index.js (listener construction, launch handles)
    resource: /Applications/ZCode.app/Contents/Resources/app.asar (extracted and inspected 2026-10-23)
  - title: Live process and socket inspection on macOS (pgrep/lsof, 2026-10-23)
    resource: local host inspection; only listener was the Chromium SingletonSocket
  - title: Host-service rejection gate in the bridge
    resource: ../../src/bridge.ts
  - title: Feature roadmap stage 5 and the bb host-service request
    resource: ./feature-roadmap.md
generated:
  by: zcode-agent/GLM-5.3
  at: 2026-10-23T12:15:40Z
verified:
  - by: zcode-agent/GLM-5.3
    at: 2026-10-23T12:15:40Z
---

# ZCode Desktop host services cannot be proxied by attaching to the running app

Decided 2026-10-23 after inspecting the installed ZCode Desktop 3.16.2 bundle
and the live process tree. Question under investigation: since ZCode Desktop
implements the host services the plugin rejects (`automation/*`, `offPeak/*`,
`interaction/browser*`, `mcp/ui*`), could the plugin simply connect to a
running Desktop instance and forward the native reverse RPCs to it?

**Conclusion: no.** Desktop exposes no RPC endpoint for external clients, by
design. The only viable unblock paths remain the bb host-service channel
([get-bb/bb#6008](https://github.com/get-bb/bb/issues/6008)) or a documented
public host API from Z.ai.

## Observed topology (Desktop 3.16.2, macOS)

- Host services live in private child processes of the app: `out/host`
  (browser control, automation host) and `out/scheduler` (the automation /
  Off-Peak scheduler). They are not part of the CLI the plugin launches.
- Both bind loopback with an **ephemeral port** (`listen(0, "127.0.0.1")`,
  `listen({host: "127.0.0.1", port: 0})`), so the address changes on every
  app start. Nothing listens on a stable TCP port or named socket.
- The address is handed only to sessions Desktop itself launches, through a
  private handle carrying `socketPath`/`launchSocketPath` plus
  `pluginAuthority`, `helperAppPath`, `bundleId` and `pid` - the connection
  is scoped to one launch of one signed app.
- Peer identity is validated on the machine: CLI children run with
  `MACH_PORT_RENDEZVOUS_PEER_VALIDATION=1`, and the bundle contains dev-only
  overrides (`ZCODE_CUA_BROKER_ALLOW_ANY_PEER`, `ZCODE_CUA_DEV_EXPOSE_BROKER`,
  `ZCODE_CUA_DEV_MODE`). The existence of allow-any-peer dev flags implies
  production rejects unknown peers.
- Live check on a running Desktop: its only listener is the Chromium
  `SingletonSocket` (single-instance lock), not an RPC surface.

## Why forwarding would not work even with a socket

- The plugin's child CLI processes send `automation/*`/`offPeak/*` **over
  their own stdio to whoever launched them** - the plugin - not to a global
  Desktop service. Proxying would additionally require Desktop to accept a
  foreign session as its own: foreign working directories, workspace-scoped
  official MCP auth, and its scheduler's own state model.
- Desktop deliberately shares state through files, and the plugin already
  consumes exactly that surface: Coding Plan sign-in read from `~/.zcode`
  (`src/coding-plan.ts`), MCP server config inherited from
  `~/.zcode/cli/config.json` when `mcpServers` is empty.
- Building on the `ZCODE_CUA_DEV_*` flags is out of the question: they are
  ZCode's internal development surface, undocumented and unstable, and
  bypassing a signed app's peer validation is a trust-boundary violation of
  the same category the plugin already forbids for credentials.

## Consequences

- The v0.9.1 rejection gate in `src/bridge.ts`
  (`hostServiceUnavailable`) remains the correct behavior: fail those native
  ports with an actionable message pointing at ZCode Desktop.
- Feature roadmap stages 5-7 stay blocked on bb; there is no ZCode-side
  shortcut that does not violate the host boundary.

## Re-verify

Re-check on any ZCode Desktop update (or when `stale_after` passes): extract
`app.asar`, confirm how `out/host`/`out/scheduler` bind and whether a
documented external host API or stable socket has appeared; also re-check
`lsof -nP -iTCP -sTCP:LISTEN` plus unix sockets on a running instance. If
Z.ai publishes a supported host-service endpoint, revisit this decision and
the roadmap stages in the same change.
