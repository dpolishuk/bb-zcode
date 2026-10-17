# Contributing

Thanks for helping improve the ZCode provider for bb.

## Working locally

Use Node.js 24+ and bb 0.46.1. Fork and clone the repository, then run:

```sh
npm ci --ignore-scripts
npm run check
npm run format:check
```

The synthetic tests do not need ZCode or model credentials. Building requires
bb's CLI. On a machine without the desktop app, install the pinned builder with
`npm install --no-save --ignore-scripts bb-app@0.46.1`.

## Making a change

- Keep plugin code on the published SDK's public import surfaces.
- Add focused tests for protocol translation, lifecycle, or approval changes.
- Keep unsupported capabilities explicit in the declaration and documentation.
- Run `npm run check` and `npm run format:check` before opening a pull request.
- Explain the problem, the changed behavior, and the checks you ran.

`npm run test:live` exercises an installed ZCode CLI against an isolated local
model fixture. It is optional for documentation changes. Never use a normal bb
profile for the optional full bb smoke; see [configuration](docs/configuration.md).

## Reporting a problem

Include your OS, Node, bb, and ZCode versions, a minimal reproduction, and the
relevant error. Redact credentials, private prompts, and private file contents.
Distinguish failures with the local fixture from failures with a real provider.

Contributions are licensed under the repository's [MIT license](LICENSE).
