# dsh-jev

jev (System One, `api.typesafe.ai`) × DeepSeek Harness (dsh) integration monorepo.

| Package | Purpose |
| --- | --- |
| [`packages/core`](packages/core) | TypeScript client for the jev System One HTTP API — `choice` / `score` / `noul` primitives with strict degrade-on-failure semantics (never throws). |
| [`packages/jev-mcp`](packages/jev-mcp) | MCP server exposing the core primitives as tools, with a dsh `cordis.patch.yml` `- insert:` config sample. |
| [`skills/jev`](skills/jev) | `SKILL.md` decision-gesture skill for in-conversation use. |

## Quick start

```sh
pnpm install
pnpm build
pnpm test        # vitest with mocked HTTP
```

## dsh wiring

See [`packages/jev-mcp/README.md`](packages/jev-mcp/README.md) for the
`- insert:` snippet to paste into a profile's `cordis.patch.yml` (new plugin
instances must use `- insert:`, not top-level `- id:` — id patches only match
existing tree entries).

## License

MIT
