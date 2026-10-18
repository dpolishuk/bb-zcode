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
  active model loop. Forks and injected bb tools/skills remain unsupported.
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
- Diagnose a stopped session by its native error. Never silently replace an
  unresumable session, replay a prompt after an uncertain timeout, or copy
  credentials out of ZCode to work around authentication.
