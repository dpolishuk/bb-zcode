# Icons

## zai-badge.svg

Store/marketplace badge: a cleaned vector reproduction of the official
Z.ai logo — the favicon served at
<https://z-cdn.chatglm.cn/z-ai/static/logo.svg> — a `#2D2D2D` rounded
square with a hairline white border and the white three-stroke "Z" mark.
The path data is taken verbatim from the official asset (Illustrator
styling removed). `package.json` (`bb.branding.icon`) references it, and
`npm run marketplace:build` carries it into `marketplace.json`.

The filename intentionally changes when the artwork changes: bb caches
catalog icons by asset URL, so a new filename is what refreshes the store
listing (see CHANGELOG 0.9.7 and 0.9.8).

## zcode.svg

Theme-aware provider mark shown inside bb next to the provider name. bb
draws provider marks with `currentColor`, so this file carries only the
official Z geometry (same source as the badge) as a monochrome glyph
fitted to a 24×24 viewBox. `server.ts` references it; it is read from the
installed plugin, so it refreshes on every plugin update without a URL
change.

## Trademarks

Z.ai, ZCode, and their logos are trademarks of Z.ai / Zhipu AI. They are
used here nominatively to identify the product this independent plugin
integrates; the plugin is not affiliated with or endorsed by Z.ai.
