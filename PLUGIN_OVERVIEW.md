Keep ZCode coding conversations in bb, with streamed replies, native tool
activity, approval prompts, and saved sessions you can return to later.

## What you get

- Stream text and reasoning into a bb thread.
- Follow ZCode tool calls and results, and answer approvals and questions.
- Choose models and reasoning options from your ZCode configuration.
- Plan, stop, release, and resume saved conversations.

## Requirements

Install bb 0.46.1, Node.js 24+, and ZCode separately. Connect individual Coding
Plan in ZCode Desktop (Z.ai / BigModel), or configure a personal API provider.
Provider usage is subject to your plan or API charges.
The plugin is free under the MIT license and has no API-key settings.

ZCode CLI 0.16.9 has been verified on macOS with a local model fixture.
Live Z.ai Coding Plan account discovery was verified on macOS. Paid inference
and Linux/Windows operation remain unverified. Start Plan and Team plans are
not supported. Existing desktop sign-in is read locally; short-lived project
tokens stay in memory and raw child-protocol logging is disabled.

## Current limits

Tool results use generic rows. Attachments, live steering, forks, manual
compaction, and bb-injected tools are not implemented. Each session runs a
local ZCode process with the host account's permissions; approval modes are
not an OS sandbox.

This is an independent experimental integration. The marketplace installs
the repository's main branch through bb's native Git installer and updater.

See the [setup guide](https://github.com/dpolishuk/bb-zcode#quick-start) and
[validation record](https://github.com/dpolishuk/bb-zcode/blob/main/docs/validation.md).
