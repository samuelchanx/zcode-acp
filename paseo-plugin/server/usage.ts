/**
 * Native usage source (Paseo 0.11+): feeds the GLM Coding Plan windows into
 * the daemon's Usage screen via `server.registerUsageSource`. Data comes from
 * the same `zcode-acp quota --json` spawn as the plugin RPC — one code path,
 * one cache — mapped onto Paseo's UsageWindow vocabulary with the SDK helpers
 * (windowFromUsedPct / toneFromUsedPct / unavailable).
 *
 * Only GLM is registered: it is the one provider Paseo can reason about
 * per-session (the zcode provider id). Opencode Go and Ollama Cloud stay in
 * the plugin's own Quota screen, where there is room for their windows and
 * per-model detail.
 */

import type {
  UsageReport,
  UsageSourceRegistration,
  UsageWindow,
} from "@getpaseo/plugin/server";
import { z } from "zod";

import { fetchQuota } from "./quota";

/** The provider id this plugin registers (see index.server.ts). */
const PROVIDER_ID = "zcode";

const inputSchema = z.object({}).strict();
type UsageInput = z.output<typeof inputSchema>;

const ACCOUNT: UsageInput = {};

/**
 * Window construction and tone by hand — deliberately NOT the SDK's
 * `@getpaseo/plugin/server/usage` runtime helpers, which would make this
 * module unloadable on Paseo 0.8–0.10. Thresholds mirror the app's
 * deriveTone (>90 danger, >=70 warning, else ok).
 */
function tone(usedPct: number): UsageWindow["tone"] {
  if (usedPct > 90) return "danger";
  if (usedPct >= 70) return "warning";
  return "ok";
}

function window(
  definition: { id: string; label: string; shortLabel: string; summary?: boolean },
  usedPct: number,
  resetsAt: string | null,
): UsageWindow {
  const used = Math.max(0, Math.min(100, usedPct));
  return {
    ...definition,
    usedPct: used,
    remainingPct: 100 - used,
    resetsAt,
    tone: tone(used),
  };
}

function iso(ms: number | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms)
    ? new Date(ms).toISOString()
    : null;
}

/** Exported for unit testing. */
export function glmReport(output: Awaited<ReturnType<typeof fetchQuota>>): UsageReport {
  if (output.glm.kind !== "success") {
    switch (output.glm.kind) {
      case "auth_error":
        return {
          status: "unavailable",
          problem: {
            kind: "no_quota",
            detail:
              "No usable GLM Coding Plan credentials in ~/.zcode — sign in from the ZCode app.",
          },
        };
      case "rate_limited":
        return {
          status: "unavailable",
          problem: {
            kind: "no_quota",
            detail: "GLM quota API rate-limited — try again shortly.",
          },
        };
      default:
        return {
          status: "error",
          error: output.error ?? "GLM quota service unreachable.",
        };
    }
  }

  const { level, items } = output.glm;
  const windows = items.flatMap((item) => {
    const definition =
      item.key === "token_5h"
        ? { id: "five_hour", label: "5-hour", shortLabel: "5h", summary: true }
        : item.key === "mcp"
          ? { id: "mcp", label: "Tool calls (MCP)", shortLabel: "mcp" }
          : item.key.startsWith("token_")
            ? { id: "weekly", label: "Weekly", shortLabel: "wk", summary: true }
            : null; // Unknown family — skip rather than mislabel it.
    if (!definition) return [];
    return [
      window(definition, item.usedPercent, iso(item.nextResetTime)),
    ];
  });

  if (windows.length === 0) {
    return {
      status: "error",
      error: "GLM returned no usable quota windows. Try again later.",
    };
  }

  return {
    status: "available",
    planLabel: level ? `GLM Coding Plan · ${level}` : "GLM Coding Plan",
    windows,
  };
}

export function createUsageSource(): UsageSourceRegistration {
  return {
    id: "zcode-acp",
    label: "GLM Coding Plan",
    icon: "icon.svg",
    input: inputSchema,
    async discover(scope) {
      const output = await fetchQuota("glm");
      // No card when there is no account behind it; rate limiting and
      // network trouble keep the card so fetch() can explain the state.
      if (
        output.glm.kind === "auth_error" ||
        (output.glm.kind === "unavailable" && output.error !== undefined)
      ) {
        return [];
      }
      if (scope.kind === "global") {
        return [{ key: "glm-coding-plan", harness: "ZCode", input: ACCOUNT }];
      }
      if (scope.provider !== PROVIDER_ID) return [];
      // One account backs every model on this provider.
      return [{ key: "glm-coding-plan", harness: "ZCode", input: ACCOUNT }];
    },
    async fetch(input) {
      inputSchema.parse(input);
      return glmReport(await fetchQuota("glm"));
    },
  };
}
