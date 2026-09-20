# @dsh-jev/effort

dsh Web-only plugin: [jev System One](https://typesafe.ai) lowers the
reasoning effort to `low` for simple turns, with a dismissible composer hint.

Modeled on the mature `dsh-quote-followup` plugin pattern:

- **Two halves.** The host face (`lib/index.js`) hooks the `agent/request`
  waterfall: before a turn's first request it asks jev `choice(keep|lower)`
  with the newest user text as context; a "lower" pick rewrites
  `reasoningEffort` to `low` (configurable via `targetEffort`). The browser
  face (`lib/client.js`, mounted via the package's `dsh.client`
  `platform: web` declaration) renders a lightweight, dismissible hint above
  the composer explaining the behavior.
- **Never touches provider/model.** Only `reasoningEffort` is rewritten —
  route selection is deliberately out of scope (that's `@dsh-jev/router`'s
  job, with its own registration gates). No LLM route is ever registered.
- **Silent fallback.** jev unreachable / timeout / non-2xx → the resolved
  config is returned unchanged (original effort kept), logged only. The
  listener never throws into the request path.
- **Composer hint is dismissible** (persisted in `localStorage`), localized
  via the injected DSH `locale` service with English fallback, and rendered
  as a plain sibling DOM node — no contenteditable or Lexical internals are
  touched (the two known contenteditable/paste footguns do not apply).
- **Hot-swap hardening.** Versioned global state + element ownership
  (`data-dsh-jev-effort-version`) so an old listener from a long-lived tab
  cannot tear down the new UI after a client bundle swap; old hosts without
  `locale` degrade to English copy, without a composer the hint stays hidden.

Known seam limitation (v1): the composer hint is informational — the dynamic
jev verdict lives host-side (visible in stdout logs), because the browser
must not hold the jev API key.

## Install into the Web profile

```sh
dsh plugin --profile web add dsh-jev-effort  # once published
```

or via the bundle patch in `cordis.patch.yml` (`- insert: - id: jev-effort`).

## Development

```sh
pnpm --filter @dsh-jev/effort test   # syntax checks + 11 vitest cases
```
