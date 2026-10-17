/**
 * Native usage source (Paseo 0.11+): feeds the Ollama Cloud windows into the
 * daemon's Usage screen. Companion to usage.ts (GLM) — same hand-rolled style
 * (no SDK runtime-helper imports, so older daemons that skip registration are
 * unaffected), same tone thresholds, mapping the SAME `zcode-acp quota --json`
 * spawn's `oc` result.
 *
 * Ollama Cloud is not a per-session-harness quota: the account backs every
 * `*:cloud` model routed through the local stack (claude-router's ollama
 * backend), so the card appears globally and on any session scope whose
 * provider hosts ollama traffic (the `router` provider) or whose model carries
 * the `:cloud` tag.
 */

import type {
  UsageBalance,
  UsageReport,
  UsageSourceRegistration,
  UsageWindow,
} from "@getpaseo/plugin/server";
import { z } from "zod";

import { fetchQuota } from "./quota";
import type { QuotaOutput } from "../shared/quota";

const inputSchema = z.object({}).strict();
type OllamaUsageInput = z.output<typeof inputSchema>;

const ACCOUNT: OllamaUsageInput = {};
/** The account card handed out for every matching scope. */
const ACCOUNT_CARD = { key: "ollama-cloud", harness: "Ollama", input: ACCOUNT } as const;

/** Providers whose sessions can draw on the shared Ollama Cloud identity. */
const OLLAMA_SESSION_PROVIDERS = new Set(["router"]);

function ocApplies(provider: string, model: string | undefined): boolean {
  if (OLLAMA_SESSION_PROVIDERS.has(provider)) return true;
  return (model?.includes(":cloud") ?? false);
}

/** Thresholds mirror the app's deriveTone (>90 danger, >=70 warning, else ok). */
function tone(usedPct: number): UsageWindow["tone"] {
  if (usedPct > 90) return "danger";
  if (usedPct >= 70) return "warning";
  return "ok";
}

function window(
  definition: { id: string; label: string; shortLabel: string; summary?: boolean },
  fraction: number,
  resetsAt: string | null,
): UsageWindow {
  // 2dp — fractions×100 carry float dust (0.6898×100 = 68.97999…).
  const used = Math.round(Math.max(0, Math.min(100, fraction * 100)) * 100) / 100;
  return {
    ...definition,
    usedPct: used,
    remainingPct: Math.round((100 - used) * 100) / 100,
    resetsAt,
    tone: tone(used),
  };
}

function iso(ms: number | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Exported for unit testing. */
export function ocReport(output: QuotaOutput): UsageReport {
  const oc = output.oc;
  if (oc.kind !== "success") {
    switch (oc.kind) {
      case "not_configured":
        return {
          status: "unavailable",
          problem: {
            kind: "no_quota",
            detail:
              "No Ollama Cloud quota source — sign in to a local Ollama or set OLLAMA_API_KEY.",
          },
        };
      case "auth_error":
        return {
          status: "unavailable",
          problem: {
            kind: "no_quota",
            detail: "Ollama API key rejected — regenerate it at ollama.com.",
          },
        };
      default:
        return {
          status: "error",
          error: output.error ?? "Ollama Cloud usage service unreachable.",
        };
    }
  }

  const windows: UsageWindow[] = [];
  if (typeof oc.session === "number") {
    windows.push(
      window({ id: "five-hour", label: "5-hour", shortLabel: "5h", summary: true }, oc.session, iso(oc.sessionResetAt)),
    );
  }
  if (typeof oc.weekly === "number") {
    windows.push(
      window({ id: "weekly", label: "Weekly", shortLabel: "wk", summary: true }, oc.weekly, iso(oc.weeklyResetAt)),
    );
  }
  if (typeof oc.monthly === "number") {
    windows.push(
      window({ id: "monthly", label: "Monthly", shortLabel: "mo", summary: true }, oc.monthly, iso(oc.monthlyResetAt)),
    );
  }
  if (windows.length === 0) {
    return {
      status: "error",
      error: "Ollama Cloud returned no usable quota windows. Try again later.",
    };
  }

  const balances: UsageBalance[] =
    oc.purchasedUsd !== undefined
      ? [
          {
            id: "ollama-credits",
            label: "Purchased credits",
            used: null,
            remaining: oc.purchasedUsd,
            limit: null,
            unit: "usd",
            tone: oc.purchasedUsd > 0 ? "ok" : "default",
          },
        ]
      : [];

  const planLabel = oc.plan ? `Ollama Cloud · ${oc.plan}` : "Ollama Cloud";
  return balances.length > 0 ? { status: "available", planLabel, windows, balances } : { status: "available", planLabel, windows };
}

/** Exported for unit testing. */
export function createOllamaUsageSource(): UsageSourceRegistration {
  return {
    id: "zcode-acp-ollama",
    label: "Ollama Cloud",
    icon: "icon.svg",
    input: inputSchema,
    async discover(scope) {
      const output = await fetchQuota("oc");
      // Mirror the GLM source: no card when the account can't be backed by a
      // credential chain (not configured → deliberate skip) or the bridge
      // itself is broken (unavailable with a bridge-level error); rate-limit
      // / network trouble keep the card so fetch() can explain the state.
      if (output.oc.kind === "not_configured") return [];
      if (output.oc.kind === "auth_error" || (output.oc.kind === "unavailable" && output.error !== undefined)) {
        return [];
      }
      if (scope.kind === "global") return [ACCOUNT_CARD];
      if (!ocApplies(scope.provider, scope.model)) return [];
      return [ACCOUNT_CARD];
    },
    async fetch(input) {
      inputSchema.parse(input);
      return ocReport(await fetchQuota("oc"));
    },
  };
}