# Changelog

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
