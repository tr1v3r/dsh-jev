# @dsh-jev/mcp

MCP server (stdio) exposing the jev System One primitives (`choice` / `score`
/ `noul`) from `@dsh-jev/core` as MCP tools. Every tool degrades gracefully:
when the jev API is unreachable, timed out, or malformed, the tool still
returns the caller-supplied fallback and clearly marks `jev: degraded (reason)`.

## Tools

| Tool | Input | Behavior |
| --- | --- | --- |
| `jev_choice` | `question`, `options[]`, `fallbackPick?` | Picks one option; falls back to `fallbackPick` (default: first option). |
| `jev_score` | `subject`, `criteria[]`, `fallbackScore?` | One [0,1] score per criterion; falls back to a neutral score (default 0.5). |
| `jev_noul` | `prompt`, `fallbackText?` | Unconstrained reflection; falls back to given/empty text. |

Auth: set `JEV_API_KEY` in the server process environment (Bearer token).

## dsh wiring (`cordis.patch.yml`)

⚠️ New plugin instances MUST be declared under `- insert:` — a top-level
`- id:` only patches entries already present in the composed tree and is
silently dropped when the id does not exist.

Add to the target profile's `cordis.patch.yml` (e.g.
`~/.config/dsh/profiles/<name>/cordis.patch.yml`, or its `.tmpl` source, then
`chezmoi apply`):

```yaml
- insert:
    - id: dsh-jev-mcp
      config:
        command:
          # stdio command must be an absolute path in GUI/launchd contexts
          # (no fnm on PATH there). Adjust to your node location:
          command: /Users/you/.local/share/fnm/aliases/default/bin/node
          args:
            - /Users/you/workspace/opensource/dsh-jev/packages/jev-mcp/dist/index.js
          env:
            JEV_API_KEY: ${JEV_API_KEY}
```

> Do not hardcode your macOS username in public docs/configs — use chezmoi
> `{{ .chezmooi.homeDir }}` templating (source `.tmpl`) for real deployments.

Verify the composed tree picks it up:

```sh
dsh --profile <name> --dump-config | grep -A5 dsh-jev-mcp
# and confirm no `patch: entry "dsh-jev-mcp" not found` warning in the header
```

Remember `--dump-config` only validates composition; a real boot of the
profile is required to verify the plugin imports cleanly.

## Build & run

```sh
pnpm install && pnpm build
node dist/index.js   # speaks MCP over stdio
```
