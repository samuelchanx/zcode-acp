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

## Quota

Two surfaces, one data path — the plugin daemon-side spawns
`zcode-acp quota --json` (the unified CLI bin; `zcode-acp-server` always starts
the ACP server and is never used for this):

1. **Native Usage card (Paseo 0.11+).** A usage source maps the GLM Coding
   Plan windows (5-hour, weekly, MCP tool calls) onto Paseo's built-in Usage
   screen, with tone thresholds and reset times. Registered defensively, so
   older daemons just skip it. A second usage source maps Ollama Cloud windows
   (local device-auth balance, plus purchased credits).
2. **Quota screen — DORMANT.** The custom sidebar footer screen
   (`client/quota.tsx`) was retired in commit `0691686`: Paseo's native Usage
   screen (#1) replaced it. The client entry is a no-op; the file is kept
   dormant for a possible comeback — don't re-register it.

> **Merge warning (2026-10-17 incident).** Upstream's quota CLI has no
> `--json` mode and silently ignores unknown flags, so an upstream merge that
> drops the fork's flag makes every RPC return the human-readable card instead
> of JSON: both usage sources die and `paseo plugin logs zcode-acp` fills with
> `quota RPC failed: Unexpected token 'G', "GLM Coding"... is not valid JSON`
> while all unit tests stay green. The contract test in
> `tests/cli-quota.test.ts` (`quota --json contract (paseo-plugin RPC)`)
> guards this — run it after every upstream merge. See AGENTS.md
> "Fork-only features" for the full survival checklist.

Binary resolution for the spawn: `ZCODE_ACP_QUOTA_BIN` override, then
`zcode-acp` on the daemon's PATH, then `~/.local/bin`, `/opt/homebrew/bin`,
`/usr/local/bin`. Errors degrade to typed unavailable states, never a crash.
Fixing the bin needs only `pnpm build` — the plugin spawns it per RPC call; a
`paseo plugin reload zcode-acp` is required only when `paseo-plugin/` sources
change (and it kills running zcode agents — do it from a plain terminal, never
from inside a Paseo-hosted session).

Install (run these yourself, not from inside a Paseo-hosted agent)

Plugins are trusted, unsandboxed code in the daemon, and enabling them is
the operator's decision (`pluginsEnabled` in `~/.paseo/config.json`, applied
with `paseo reload`). A daemon restart interrupts agents — do it from a
plain terminal. **The same applies to `paseo plugin reload zcode-acp`**: any
Paseo agent running on this provider (including one you asked to make the
change) loses its connection mid-reload. Agents may edit source, typecheck,
and run tests; install/reload is the operator's step.

**Order matters.** The daemon refuses to start a plugin whose provider id is
already present under `agents.providers` ("Plugin … cannot register
configured provider ID") — the check keys on the entry's EXISTENCE, so
`enabled: false` is not enough, and the entry must be deleted BEFORE the
plugin can start. Do NOT re-add the entry later either: the same check runs
at every daemon boot and the plugin would stop starting.

```bash
# 1. The bridge must be on the daemon's PATH.
zcode-acp-server --version   # or: npm i -g zcode-acp-server

# 2. Enable plugins once (root field in ~/.paseo/config.json):
#    { "pluginsEnabled": true, ... }

# 3. DELETE the whole "zcode": { ... } object under "agents.providers"
#    in ~/.paseo/config.json (keep a backup of the file first). This is
#    what frees the provider id for the plugin.

# 4. Install the plugin from this checkout (local-path source), then reload.
paseo plugin install "$(pwd)/paseo-plugin"
paseo reload
```

Existing conversations need a ONE-TIME migration. The provider id stays
`zcode` (not namespaced), so persisted agents still validate against the
plugin-registered provider — but the persisted HANDLE format differs: the
config-defined path stored the raw ACP session id, while the plugin path
decodes `plugin:{"version":1,"data":{"sessionId":…}}` (daemon
`PluginAgentClient.decodePersistence`). Without migration, every pre-plugin
thread fails resume/timeline with `Invalid plugin provider persistence
handle`. Fix it with the bundled script (rewrites the handles in place,
per-file backup under `~/.paseo/agents-backup-pre-plugin-migration/`):

```bash
node paseo-plugin/migrate-legacy-sessions.mjs --dry-run   # inspect first
node paseo-plugin/migrate-legacy-sessions.mjs
```

The daemon caches agent records in memory (agent-storage `cache` Map,
populated at boot), so restart the daemon AFTER migrating — the threads
resurface on the next boot; the bridge's `session/load` replay finds the same
backend sessions. New agents pick "ZCode" from the provider picker. If you
ever want the config-defined path back, uninstall/disable the plugin first —
both cannot own `zcode` at once.

**If a previous install attempt failed** with `cannot register configured
provider ID "zcode"`: the plugin entry is already recorded (`plugins` in
the daemon config) and only its start failed. Delete the provider entry as
above, then `paseo reload` followed by `paseo plugin reload zcode-acp` —
or just restart the daemon, which retries enabled plugins at boot.

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
