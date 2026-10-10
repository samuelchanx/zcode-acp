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
 * Quota (2026-10): a `quota.get` RPC spawns `zcode-acp quota --json` (the
 * unified CLI bin — `zcode-acp-server` always starts the ACP server) and a
 * Paseo 0.11 usage source maps the GLM windows onto the native Usage screen.
 * The client entry adds the full-screen view (all providers + MCP detail).
 *
 * The provider id reuses `zcode` on purpose: Paseo registers plugin
 * provider ids without namespacing and persisted agents validate their
 * provider id against registered providers, so existing conversations keep
 * their association and resume through the plugin — after a ONE-TIME handle
 * migration (migrate-legacy-sessions.mjs): the config-defined path stored
 * the raw ACP session id, the plugin path requires the
 * `plugin:{"version":1,"data":…}` envelope, and unmigrated threads fail
 * resume/timeline with "Invalid plugin provider persistence handle". The
 * `agents.providers` entry with the same id must be DELETED from the daemon
 * config before the plugin can start — the daemon rejects any plugin
 * provider id that exists there (presence-based, `enabled: false` is not
 * enough), at install time and at every boot.
 */

import type { PluginServerContext } from "@getpaseo/plugin/server";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";

import { handleQuota } from "./server/quota";
import { createUsageSource } from "./server/usage";
import { quotaGet } from "./shared/quota";

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
      transformers: [
        {
          // Workaround for a plugin-SDK bug (getpaseo/paseo, ACP shim
          // `toolTimelineItem`): a failed tool call emits `error: snapshot.output`,
          // and when the bridge never attached an output that is `null` — which
          // violates the daemon's ToolCallFailedPayloadSchema (error must be
          // non-null when status is "failed"). Clients then reject the whole
          // fetch_agent_timeline_response and the session shows "Couldn't
          // refresh agent history" forever after. Synthesize a non-null error
          // so failed calls stay renderable. Runs on live updates AND on
          // session-load replay, so polluted timelines self-heal on resume.
          toolCall: (snapshot) => {
            if (
              snapshot.status === "failed" &&
              (snapshot.output === null || snapshot.output === undefined)
            ) {
              return { ...snapshot, output: { message: "Tool call failed" } };
            }
            return snapshot;
          },
        },
      ],
    }),
  );
  server.handle(quotaGet, handleQuota);
  // Usage sources arrived in Paseo 0.11; older daemons skip the native card.
  if (typeof server.registerUsageSource === "function") {
    server.registerUsageSource(createUsageSource());
  }
  return () => {};
}
