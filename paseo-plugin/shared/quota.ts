/**
 * Zod contract for the quota RPC — a mirror of the bridge's `zcode-acp quota
 * --json` output (CombinedResult: src/quota/types.ts, opencode-go/types.ts,
 * ollama-cloud/types.ts). Zod strips unknown keys, so bridge-side additions
 * stay forward-compatible; the client renders only what it knows.
 */

import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const glmDetailSchema = z.object({
  modelCode: z.string(),
  usage: z.number(),
});

const glmItemSchema = z.object({
  /** Stable key derived from type+number, e.g. "token_5h" / "token_1" / "mcp". */
  key: z.string(),
  /** The bridge's card label — informational only; the UI uses its own. */
  label: z.string(),
  /** Used percentage, clamped to [0, 100] by the bridge. */
  usedPercent: z.number(),
  leftPercent: z.number(),
  usedCount: z.number().optional(),
  totalCount: z.number().optional(),
  /** Reset timestamp in epoch ms. */
  nextResetTime: z.number().optional(),
  /** Per-model MCP usage breakdown, when the API provides one. */
  detail: z.array(glmDetailSchema).optional(),
});

const glmResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("success"),
    level: z.string(),
    items: z.array(glmItemSchema),
  }),
  z.object({ kind: z.literal("auth_error") }),
  z.object({ kind: z.literal("rate_limited") }),
  z.object({ kind: z.literal("unavailable") }),
]);

const goWindowSchema = z.object({
  usagePercent: z.number(),
  /** Seconds until this window resets (relative countdown). */
  resetInSec: z.number(),
});

const goResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("success"),
    rolling: goWindowSchema,
    weekly: goWindowSchema,
    monthly: goWindowSchema.nullable(),
    fetchedAt: z.number(),
  }),
  z.object({ kind: z.literal("not_configured") }),
  z.object({ kind: z.literal("auth_error") }),
  z.object({ kind: z.literal("unavailable") }),
]);

/** Oc fractions are in [0, 1]; reset moments are bridge-derived epoch ms. */
const ocResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("success"),
    session: z.number().optional(),
    weekly: z.number().optional(),
    monthly: z.number().optional(),
    sessionResetAt: z.number().optional(),
    weeklyResetAt: z.number().optional(),
    monthlyResetAt: z.number().optional(),
    /** Plan tier (e.g. "pro") — carried by the local device-auth source. */
    plan: z.string().optional(),
    /** Purchased credit balance in USD, when the source exposes one. */
    purchasedUsd: z.number().optional(),
    fetchedAt: z.number(),
  }),
  z.object({ kind: z.literal("not_configured") }),
  z.object({ kind: z.literal("auth_error") }),
  z.object({ kind: z.literal("unavailable") }),
]);

/**
 * The bridge's own JSON shape (`zcode-acp quota --json`) — no queriedAt; the
 * handler stamps it. Kept separate so validation passes before stamping.
 */
export const bridgeQuotaSchema = z.object({
  glm: glmResultSchema,
  go: goResultSchema,
  oc: ocResultSchema,
  /** Set only when the bridge itself could not be queried at all. */
  error: z.string().optional(),
});

export type BridgeQuota = z.output<typeof bridgeQuotaSchema>;

/** RPC output = the bridge shape plus the handler's query timestamp. */
export const quotaOutputSchema = bridgeQuotaSchema.extend({
  queriedAt: z.number(),
});

export type QuotaOutput = z.output<typeof quotaOutputSchema>;

export const quotaProviderSchema = z.enum(["all", "glm", "go", "oc"]);
export type QuotaProvider = z.output<typeof quotaProviderSchema>;

export const quotaGet = defineRpc({
  name: "quota.get",
  input: z.object({ provider: quotaProviderSchema.optional() }),
  output: quotaOutputSchema,
});
