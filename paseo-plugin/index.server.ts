/**
 * Paseo provider plugin for the zcode-acp bridge (spec:
 * samuelchanx/zcode-acp#1).
 *
 * Registers the bridge as a Paseo provider through Paseo's official ACP
 * shim. The config-defined ACP path (`extends: "acp"`) discards the
 * spec-standard `usage_update` notification (Paseo issue getpaseo/paseo#1390
 * — `handleUsageUpdate` is a no-op there), so the context-window meter never
 * populates and a static `models` list replaces runtime model discovery,
 * hiding the reasoning-effort selector. The plugin path maps both: usage →
 * session.usage (the meter's feed) and the bridge's `thought_level` config
 * option → per-model thinking options with write-back through
 * session/set_config_option.
 *
 * Deliberately NO transformers: the bridge already speaks spec-clean ACP
 * (usage_update, config options for model/mode/thought_level, permission
 * requests, terminal output, slash commands). Any vendor adaptation would
 * belong here, but none is needed — a change needed here means the BRIDGE
 * regressed, and hiding that with a transformer would be wrong.
 *
 * The provider id reuses `zcode` on purpose: Paseo registers plugin
 * provider ids without namespacing and persisted agents validate their
 * provider id against registered providers, so existing conversations keep
 * their association and resume through the plugin. The `agents.providers`
 * entry with the same id must be DELETED from the daemon config before the
 * plugin can start — the daemon rejects any plugin provider id that exists
 * there (presence-based, `enabled: false` is not enough), at install time
 * and at every boot.
 */

import type { PluginServerContext } from "@getpaseo/plugin/server";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(
    runAcpProvider({
      id: "zcode",
      label: "ZCode",
      description:
        "ZCode harness for GLM models via the zcode-acp-server bridge — " +
        "runtime model catalog, reasoning-effort selection, and context-window " +
        "usage from your ~/.zcode credentials.",
      icon: "icon.svg",
      command: ["zcode-acp-server"],
    }),
  );
  return () => {};
}
