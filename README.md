# dsh-jev

jev (System One, `api.typesafe.ai`) × DeepSeek Harness (dsh) integration monorepo.

| Package | npm | Purpose |
| --- | --- | --- |
| [`packages/core`](packages/core) | `@dsh-jev/core` | TypeScript client for the jev System One HTTP API — `choice` / `score` / `noul` primitives with strict degrade-on-failure semantics (never throws). |
| [`packages/jev-mcp`](packages/jev-mcp) | `@dsh-jev/mcp` | MCP server (stdio, bin `dsh-jev-mcp`) exposing the core primitives as tools, with a dsh `cordis.patch.yml` `- insert:` config sample. |
| [`packages/router`](packages/router) | `@dsh-jev/router` | dsh cordis plugin: per-turn jev complexity routing between already-registered LLM routes (shadow-run by default). |
| [`packages/effort`](packages/effort) | `@dsh-jev/effort` | dsh Web-only plugin: jev lowers `reasoningEffort` to `low` for simple turns, with a dismissible composer hint. |
| [`skills/jev`](skills/jev) | — | `SKILL.md` decision-gesture skill for in-conversation use. |

## Install (published packages)

All four packages are published to npm (0.1.1):

```sh
npm i @dsh-jev/core          # library client
npm i -g @dsh-jev/mcp        # installs the `dsh-jev-mcp` stdio server binary
npm i @dsh-jev/router        # dsh cordis plugin
npm i @dsh-jev/effort        # dsh web plugin
# or one-off: npx -p @dsh-jev/mcp dsh-jev-mcp
```

Auth for every package: set `JEV_API_KEY` (Bearer token) in the process
environment. Non-default endpoint / timeout are per-package config options
(not env vars).

## dsh wiring

Each package README has the ready-to-paste `- insert:` snippet for a profile's
`cordis.patch.yml` (new plugin instances must use `- insert:`, not top-level
`- id:` — id patches only match existing tree entries):

- [`packages/jev-mcp/README.md`](packages/jev-mcp/README.md)
- [`packages/router/README.md`](packages/router/README.md)
- [`packages/effort/README.md`](packages/effort/README.md)

## Development

```sh
pnpm install
pnpm build
pnpm test        # vitest with mocked HTTP (all packages)
```

CI (GitHub Actions): lint/typecheck/build/test on Node 20/22/24 —
`.github/workflows/ci.yml`.

## License

MIT
