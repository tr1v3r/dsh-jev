# @dsh-jev/router

dsh (DeepSeek Harness) cordis plugin: per-turn model routing decided by
[jev System One](https://typesafe.ai) via `@dsh-jev/core`.

Before each turn's first model request, the plugin asks jev to classify the
turn's complexity:

- **heavy** (multi-step coding, debugging, architecture) → `deepseek-official`
- **light** (simple Q&A, formatting) → `zai-coding-cn` / `glm-5.3-flash`

## Safety design

- **Never registers or modifies LLM routes.** Route registration belongs to
  `dsh-llm-deepseek` / `dsh-llm-pi-ai` / `dsh-auth`; cross-plugin registration
  conflicts are a known dsh footgun. This plugin only *selects* between routes
  already present in `ctx.llm`, via the `agent/request` waterfall — and only
  after double-checking the target provider is actually registered
  (`ctx.llm.listProviders()`). An unregistered target keeps the default route.
- **Shadow-run by default.** Decisions are logged to stdout
  (`[dsh-jev-router] turn=… picked=… target=… shadow`) and nothing changes.
  Set `mode: enforce` in the plugin config to actually switch.
- **Degrades, never breaks.** jev unreachable / timeout / non-2xx → the
  resolved config is returned untouched (default route is kept) and the
  degrade reason is logged. The listener itself never throws.

## Install into a dsh profile

```yaml
# <profile>/cordis.patch.yml
- insert:
    - id: dsh-jev-router
      path: /Users/you/workspace/opensource/dsh-jev/packages/router/dist/index.js
      config:
        mode: shadow # shadow | enforce
        heavy: { provider: deepseek-official, model: deepseek-flash }
        light: { provider: zai-coding-cn, model: glm-5.3-flash }
```

All config keys are optional; `JEV_API_KEY` / `JEV_ENDPOINT` env vars are
honored via `@dsh-jev/core`.

## Development

```sh
pnpm --filter @dsh-jev/router build
pnpm --filter @dsh-jev/router test   # 13 tests: routing, fallback, shadow vs enforce
```
