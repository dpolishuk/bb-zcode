# Native bb marketplace

This repository is both a plugin source and a bb marketplace. Its root
`marketplace.json` lists `zcode`, with native store branding, author metadata,
an overview, and a Git source pointing back to this repository's `main` branch.
Compatibility remains defined by the plugin's `package.json` engine ranges.

## Add and install

In **Settings → Marketplaces**, paste one of these into **Marketplace source**:

```text
https://raw.githubusercontent.com/dpolishuk/bb-zcode/main/marketplace.json
```

```text
git:https://github.com/dpolishuk/bb-zcode.git@main
```

Click **Add**, then find **ZCode [Experimental]** from **ZCode for bb** in the
plugin store and click **Install**. Review bb's resolved source confirmation.
The plugin runs code locally, just like a direct native plugin installation.

The equivalent CLI commands are:

```sh
bb marketplace add git:https://github.com/dpolishuk/bb-zcode.git@main
bb plugin search zcode
bb plugin install zcode@bb-zcode
```

Choose either the HTTPS catalog or Git source; they identify the same
`bb-zcode` marketplace and should not be added as separate catalogs.

## Why the repository page URL does not work

bb 0.46.1 interprets every plain `https://` marketplace source as a JSON
document. A GitHub repository page returns page data rather than a marketplace
manifest, so the plain repository URL is not accepted. This is bb's source
parser behavior and cannot be changed
by files in this repository. Use the raw JSON address or `git:` form above.

This differs from direct plugin installation, where bb accepts a GitHub page
URL without a prefix:

```sh
bb plugin install https://github.com/dpolishuk/bb-zcode
```

## Updates

Both catalog and plugin track `main`. A catalog refresh only updates listing
metadata; installing or updating the plugin is a separate native action.

```sh
bb marketplace refresh bb-zcode
bb plugin outdated
bb plugin update zcode
bb plugin source zcode
```

bb records the installed commit, checks engine compatibility, and builds the
plugin through its normal pipeline. A tagged release strategy can be adopted
later; this experimental catalog currently follows the main branch.

## Maintaining the catalog

Edit `PLUGIN_OVERVIEW.md` for the long description and `package.json` for the
plugin branding. Then run:

```sh
npm run marketplace:build
npm run check
```

The generator uses bb's version 2 marketplace format with inline overview
Markdown. `marketplace:check` prevents the generated catalog from drifting
from its source files. The live bb add/install flow is the compatibility check
for the actual installed host; see the [validation record](validation.md).
