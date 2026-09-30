# zcode-acp Paseo provider plugin

Registers the zcode-acp-server bridge as a Paseo provider through Paseo's
official ACP shim (`runAcpProvider`). The whole plugin is one registration —
no transformers, no bridge changes.

## Why this exists

Paseo's config-defined ACP integration (`extends: "acp"` in
`~/.paseo/config.json`) has two gaps that are not fixable from the bridge:

1. **No context-window meter.** Its ACP session handler discards the
   spec-standard `usage_update` notification (`handleUsageUpdate` is a no-op;
   upstream issue getpaseo/paseo#1390), so the composer meter never gets
   data. The plugin path maps `usage_update` → `session.usage`, which feeds
   the meter.
2. **No reasoning-effort selector.** A static `models` list in the provider
   config replaces runtime model discovery and carries no thinking options.
   The plugin's catalog is derived from the bridge at runtime: the
   `thought_level` config option becomes per-model thinking options
   (low/high/max), and selections write back through
   `session/set_config_option`.

Bonus: the model list is always current with `~/.zcode` — including models
added in the desktop app after the provider was configured.

## Install (run these yourself, not from inside a Paseo-hosted agent)

Plugins are trusted, unsandboxed code in the daemon, and enabling them is
the operator's decision (`pluginsEnabled` in `~/.paseo/config.json`, applied
with `paseo reload`). A daemon restart interrupts agents — do it from a
plain terminal:

```bash
# 1. The bridge must be on the daemon's PATH.
zcode-acp-server --version   # or: npm i -g zcode-acp-server

# 2. Enable plugins once (root field in ~/.paseo/config.json):
#    { "pluginsEnabled": true, ... }
paseo reload

# 3. Install the plugin from this checkout (local-path source).
paseo plugin install "$(pwd)/paseo-plugin"

# 4. Disable the config-defined entry so exactly one ZCode provider exists
#    (agents.providers.zcode.enabled = false in ~/.paseo/config.json),
#    then reload again.
paseo reload
```

The provider id stays `zcode` (not namespaced): persisted conversations
keep their provider association and resume through the plugin. New agents
pick "ZCode" from the provider picker.

## Verifying

```bash
pnpm build   # the seam test drives dist/index.js
npx vitest run tests/paseo-plugin.test.ts
```

The default run is hermetic (synthetic `~/.zcode` config; the bridge's
`session/new` is lazy, so no backend or credentials are touched). To also
exercise the paths that need a real backend — thinking write-back and a
real model turn emitting usage (uses real quota):

```bash
ZCODE_ACP_PLUGIN_LIVE="$HOME" npx vitest run tests/paseo-plugin.test.ts
```

In Paseo after install: the composer shows the context meter during/after
turns, and each model carries a low/high/max effort selector.

## Development

- `pnpm typecheck` covers this directory via its own `tsconfig.json`
  (root `tsc` cannot include it — `rootDir` is `src`).
- `@getpaseo/plugin` is pinned to the daemon's version (0.9.2) as a root
  devDependency; Paseo supplies the runtime modules when the plugin loads,
  so consumers install nothing.
- Do not add transformers here: the bridge speaks spec-clean ACP, and a
  transformer would silently mask bridge regressions.
