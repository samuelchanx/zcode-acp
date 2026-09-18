/**
 * Session-level model cache + initial usage emission.
 *
 * `currentModelCached` avoids a `session/read` round-trip on every usage_update
 * (a high-frequency path). `emitInitialUsage` sends one usage_update right
 * after resume/load so the editor shows the context bar immediately (only when
 * there's actual token data — resume before any turn has 0, which we skip).
 */

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type * as acp from "@agentclientprotocol/sdk";

import type { ZcodeReadResult } from "../backend/types.js";
import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER_ID,
  formatModelValue,
  loadAllModels,
  modelContextWindow,
  parseModelValue,
} from "./options.js";
import { log } from "../utils.js";
import type { ZcodeAcpServer } from "../server.js";
import { dispatchEvent } from "../handlers/dispatch.js";
import type { ProjectionDiffer } from "../translators/projection-differ.js";

/**
 * Read the session's current model as an encoded `"providerId\modelId"` string,
 * with a per-session cache. Returns the encoded form so callers can resolve the
 * provider (for context-window lookup / model switching) without a second read.
 */
export async function currentModelCached(
  server: ZcodeAcpServer,
  zcodeSid: string,
): Promise<string> {
  const cached = server.modelCache.get(zcodeSid);
  if (cached) return cached;
  let providerId = "";
  let modelId = DEFAULT_MODEL_ID;
  try {
    const read = await sessionRead(server, zcodeSid);
    const settings = (read.settings ?? {}) as Record<string, unknown>;
    const cur = (settings.model as { current?: { providerId?: string; modelId?: string } })
      ?.current;
    if (cur?.providerId) providerId = cur.providerId;
    if (cur?.modelId) modelId = cur.modelId;
  } catch (e) {
    log(`model-cache: session/read failed (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!providerId) {
    // Legacy session without a providerId — resolve to the first enabled provider.
    providerId = loadAllModels()[0]?.providerId ?? DEFAULT_PROVIDER_ID;
  }
  const encoded = formatModelValue(providerId, modelId);
  server.modelCache.set(zcodeSid, encoded);
  return encoded;
}

/**
 * Last completed turn's context size from the zcode store
 * (`~/.zcode/cli/db/db.sqlite`, override with `ZCODE_USAGE_DB`). The final
 * completed turn re-sent the entire context to the model, so its
 * `computed_total_tokens` (input + output) IS the current context usage.
 * Read-only + WAL: safe alongside a live backend. Returns 0 when the store is
 * missing, the runtime lacks `node:sqlite`, or the session has no turns yet.
 */
async function lastTurnContextUsed(zcodeSid: string): Promise<number> {
  const dbPath =
    process.env.ZCODE_USAGE_DB || path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");
  if (!existsSync(dbPath)) return 0;
  try {
    // Dynamic import: a runtime without `node:sqlite` must degrade to the old
    // "no bar until first turn" behavior, not fail the module load.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare(
          `SELECT computed_total_tokens AS total FROM turn_usage
           WHERE session_id = ? AND status = 'completed'
           ORDER BY started_at DESC LIMIT 1`,
        )
        .get(zcodeSid) as { total?: number } | undefined;
      return row?.total && row.total > 0 ? row.total : 0;
    } finally {
      db.close();
    }
  } catch (e) {
    log(`model-cache: turn_usage fallback failed (${e instanceof Error ? e.message : String(e)})`);
    return 0;
  }
}

/**
 * Emit an initial usage_update after resume/load so the editor shows the
 * context bar. Skips when there's no token data (resume before any turn → 0).
 * Also syncs the differ's usage baseline so the first turn won't re-emit it.
 *
 * Note: the backend's `projection.contextUsed` is 0 after resume — it only
 * updates after a new turn completes. The store's last completed turn
 * (`turn_usage.computed_total_tokens`) covers that gap: it is the context size
 * as of the end of the last turn, so a resumed session shows an accurate bar
 * immediately instead of waiting for the first post-resume message.
 */
export async function emitInitialUsage(
  server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpSid: string,
  zcodeSid: string,
  differ: ProjectionDiffer | undefined,
): Promise<void> {
  try {
    const read = await sessionRead(server, zcodeSid);
    const proj = (read.projection ?? {}) as { contextUsed?: number; contextWindow?: number };
    // Occupancy only (#228): totalTokenCount is lifetime consumption — never
    // a context meter. contextUsed absent/0 → fall back to the store's last
    // completed turn, which re-sent the full context (see lastTurnContextUsed).
    let used = proj.contextUsed ?? 0;
    if (!used) used = await lastTurnContextUsed(zcodeSid);
    if (!used) return; // resume before any turn: skip to avoid showing 0.
    // Configured limit wins over the projection's contextWindow — the
    // projection seeds a hardcoded 200K default for models without registry
    // metadata, config.json is the explicit per-model truth (same precedence
    // as dispatchUsageDelta, so the gauge never flip-flops between sources).
    const { providerId, modelId } = parseModelValue(await currentModelCached(server, zcodeSid));
    const size = modelContextWindow(providerId, modelId) || (proj.contextWindow ?? 0);
    await dispatchEvent(
      server,
      cx,
      acpSid,
      { kind: "UsageDelta", used, size },
      `init_${zcodeSid.slice(0, 8)}`,
    );
    differ?.setLastUsage(used);
  } catch (e) {
    log(`model-cache: emit_initial_usage failed (${e instanceof Error ? e.message : String(e)})`);
  }
}

async function sessionRead(server: ZcodeAcpServer, zcodeSid: string): Promise<ZcodeReadResult> {
  const backend = await server.ensureBackend();
  const resp = await backend.request(
    server.nextId(),
    "session/read",
    // messageLimit: callers read settings/projection only; the cap stops the
    // backend from serializing the session's whole message array for them.
    { sessionId: zcodeSid, messageLimit: 1 },
    5000,
  );
  if (resp.error) throw new Error(resp.error.message);
  return (resp.result ?? {}) as ZcodeReadResult;
}
