---
type: decision
title: ZCode Desktop host services cannot be proxied by attaching to the running app
description: Why "connect to the running ZCode Desktop over RPC" was investigated and rejected - ephemeral loopback ports, launch-scoped handles, peer validation - and what the open zcode --web / packages/server surface does and does not change (amended 2026-10-23).
status: stable
stale_after: 2027-01-23T00:00:00Z
tags: [decision, host-services, zcode-desktop, browser-control, zcode-web]
sources:
  - title: ZCode Desktop 3.16.2 app bundle, out/host/index.js and out/scheduler/index.js (listener construction, launch handles)
    resource: /Applications/ZCode.app/Contents/Resources/app.asar (extracted and inspected 2026-10-23)
  - title: Live process and socket inspection on macOS (pgrep/lsof, 2026-10-23)
    resource: local host inspection; only listener was the Chromium SingletonSocket
  - title: Host-service rejection gate in the bridge
    resource: ../../src/bridge.ts
  - title: Feature roadmap stage 5 and the bb host-service request
    resource: ./feature-roadmap.md
  - title: specs/zcode-unified-distribution.md on upstream main (zcode --web product rules)
    resource: https://github.com/zai-org/ZCode/blob/main/specs/zcode-unified-distribution.md
  - title: packages/services/src/node.ts createLocalServices (host-injection points for scheduler wake, browser executor, automation dispatch)
    resource: https://github.com/zai-org/ZCode/blob/main/packages/services/src/node.ts
  - title: packages/server/src (entry-http.ts, hostCapability.ts) and packages/services/src/zcode-agent/zcodeAgentService.ts
    resource: https://github.com/zai-org/ZCode/tree/main/packages/server
generated:
  by: zcode-agent/GLM-5.3
  at: 2026-10-23T12:15:40Z
verified:
  - by: zcode-agent/GLM-5.3
    at: 2026-10-23T12:15:40Z
  - by: zcode-agent/GLM-5.3
    at: 2026-10-23T13:05:00Z
---

# ZCode Desktop host services cannot be proxied by attaching to the running app

Decided 2026-10-23 after inspecting the installed ZCode Desktop 3.16.2 bundle
and the live process tree. Question under investigation: since ZCode Desktop
implements the host services the plugin rejects (`automation/*`, `offPeak/*`,
`interaction/browser*`, `mcp/ui*`), could the plugin simply connect to a
running Desktop instance and forward the native reverse RPCs to it?

**Conclusion: no.** Desktop exposes no RPC endpoint for external clients, by
design. Unblock paths: the bb host-service channel
([get-bb/bb#6008](https://github.com/get-bb/bb/issues/6008)), a documented
public host API from Z.ai, or plugin-side assembly of the open
`packages/services` host implementations - see the amendment section below.

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

## The open server surface: `zcode --web` and packages/server (amendment 2026-10-23)

The first version of this document missed that upstream also ships a
product-grade server surface; recorded here after re-reading the repository
tree (user-reported gap):

- `zcode --web` (unified distribution, spec
  `specs/zcode-unified-distribution.md`) starts a local HTTP/WebSocket
  server (default port 3030/auto, loopback default, `--token` required for
  non-loopback) with bundled Web assets and its own Agent process over the
  same `app-server --stdio` lifecycle the plugin uses.
- The host side of the protocol is **open source** in `packages/services`:
  `zcodeAgentService.ts` answers `interaction/browserList|Execute`, Off-Peak
  and automation methods, with reusable `AutomationService`/`AutomationRepo`
  and `OffPeakTaskService`/`OffPeakTaskRepo` implementations.
- Assembly is the host's job (`createLocalServices` injection points in
  `packages/services/src/node.ts`): `browserControlExecutor` is injected by
  the desktop host ("host→main WebContentsView+CDP; …缺省则 browser 不可用"
  - absent means browser unavailable); `onOffPeakSchedulerWakeRequested` is
    a desktop-host parentPort forwarding (the scheduler loop itself lives in
    the host process - Desktop runs a dedicated `zcode-cron-scheduler`
    child); `onAutomationManualRunRequested` likewise describes desktop-host
    dispatch. `packages/server/src/hostCapability.ts` issues single-use
    30-second capabilities granting a "trusted-host" role - the mechanism by
    which a Desktop attaches itself to a server, not a public endpoint.
- Net: the HTTP server product covers sessions, workspaces, topics and
  storage; the browser executor and the scheduler loop still come from a
  Desktop-grade host. `zcode --web` without Desktop attached does not give
  the plugin the missing host services.

## Consequences

- Attaching to a **running Desktop** remains impossible (sections above);
  that part of the original decision stands.
- The original claim that only bb#6008 or a public Z.ai API could unblock
  host services was **incomplete**. Plugin-side implementation is a real
  third path now that `packages/services` provides open reference
  implementations: automation/Off-Peak could be assembled inside the plugin
  (roadmap stage 6's "persist schedules in plugin storage" option), and
  browser control remains gated on the self-hosted CDP decision. A fourth,
  architectural option is running `zcode --web` and attaching as its client
  (`packages/client`), but that redefines the provider (the server owns
  sessions and lifecycle) and still lacks browser/scheduler without a
  Desktop host.
- The v0.9.1 rejection gate in `src/bridge.ts`
  (`hostServiceUnavailable`) remains correct until one of those paths is
  deliberately chosen; roadmap stages 5-7 stay blocked on a decision, not
  merely on bb.

## Re-verify

Re-check on any ZCode Desktop update (or when `stale_after` passes): extract
`app.asar`, confirm how `out/host`/`out/scheduler` bind and whether a
documented external host API or stable socket has appeared; also re-check
`lsof -nP -iTCP -sTCP:LISTEN` plus unix sockets on a running instance. If
Z.ai publishes a supported host-service endpoint, revisit this decision and
the roadmap stages in the same change.
