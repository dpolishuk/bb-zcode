---
okf_version: "0.2"
id: marketplace-submission
title: Community marketplace submission runbook
status: stable
verified:
  - basis: Live submission PR get-bb/marketplace#724 (branch dpolishuk:submit-zcode, upstream fb0dd4e), CI validate green, 2026-10-28
    date: 2026-10-28
stale_after: "90d"
---

# Community marketplace submission runbook

How the plugin is submitted to the reserved `bb-community` marketplace
(get-bb/marketplace). Read the skill `submit-a-plugin` in bb for the full
contract; this records what a completed submission looked like and the
gotchas that cost time.

## Facts

- Entry: `entries/zcode.json`, id `zcode` (derive via
  `scripts/derive-plugin-id.mjs`), category `agents-and-providers`,
  secondary `tasks-and-workflows`, icon `icons/zcode-f8cd1ca5.svg`,
  overview `overview/zcode.md` copied from `PLUGIN_OVERVIEW.md`,
  source `{"git":{"url":"https://github.com/dpolishuk/bb-zcode.git","range":"^0.14.1"}}`.
- `npm run build` in the marketplace repo derives `publishedAt` from the
  first commit that adds the entry file — commit the four files BEFORE
  running the build, or it fails with "The Git history has no first
  addition date".
- Validation set: `npm ci --ignore-scripts`, `npm run build`, `npm test`,
  `npm run gate:v1` (new entries pass without the `v1-change` label),
  `npm run check` (liveness re-checks the Git source). Push the fork branch
  `submit-zcode`, PR into `get-bb/marketplace:main` with the seven required
  body points; the `validate` workflow is the gate.
- Update path: a new marketplace PR is required for any source, name, or
  brand change; `author.github` (`dpolishuk`) owns later entry changes.

## Screenshot procedure without computer use

- `bb thread spawn --provider zcode --permission-mode full --title ...`
  creates a clean showcase thread (a 3-agent `demo-pipeline` workflow); the
  thread title carries into the card header with the model chip
  (`glm-5.3`).
- `bb thread open <id> --split replace` surfaces it in the connected app;
  `open -a bb` then `screencapture -x` frames it. The user machine may have
  overlays (notifications, other apps): take spaced captures and gate each
  with a vision pass before cropping.
- Crop with Python PIL (`sips` cannot offset-crop and `screencapture -R`
  fails on this host with "could not create image from display").
  Marketplace rules: >=1200 px wide, <=2 MiB, PNG/JPEG/WebP, no tokens,
  emails, /Users paths, or unrelated thread text; the timeline column
  (excluding the sidebar) of a maximized window is ~2590 px wide.

## Why the causality graph never shows in screenshots

`experimental_timelineRenderer` (verified in bb 0.46.1 and 0.47.1 bundles)
draws the EXPANDED body of a timeline row: the causality graph SVG in
`app.tsx` is visible only when a row is expanded (a click). A fresh capture
of a thread shows collapsed rows — the workflow run renders as the
bb-native text row "Ran workflow: ... (3/3 agents)". No CLI surface (`bb
thread open/tabs`, `bb settings ui`, `bb://` deep links) can expand a row,
switch to the Workflows navPanel, or select the thread-panel
`workflow-runs` tab, so the graph and hub surfaces need either computer
use or a user-provided screenshot. bb 0.47.1 keeps the renderer API and
`extensionKinds` contract from 0.46.x; the 0.13.0 live verification
carried over, and a 2026-10-28 demo run re-confirmed run rows and run
history on 0.47.1.
