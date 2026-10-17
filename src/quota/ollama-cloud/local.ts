/**
 * Local device-auth quota source (2026-10-17).
 *
 * A signed-in local Ollama (desktop app or `ollama serve`) authenticates to
 * ollama.com with its own device key (`~/.ollama/id_ed25519`), and the local
 * server answers two account endpoints itself — the same quota data the web
 * API-key path returns, plus exact reset timestamps:
 *
 *   GET  /api/balance → {"included":{"session":{"remaining_percent":68.25,
 *                       "resets_at":"2026-10-17T08:00:00Z"},"weekly":{…}},
 *                       "purchased":{"balance_usd":0}}
 *   POST /api/me      → {"id","email","plan":"pro",…}
 *
 * Verified live 2026-10-17 (Ollama 0.40.4, Pro). Two polarity flips versus the
 * web endpoint: `remaining_percent` runs 0..100 in the REMAINING direction
 * (the web shape is usage 0..1), and the reset timestamps are given instead of
 * derived. Undocumented — a foreign shape falls through to the API-key path,
 * never crashes.
 */

import process from "node:process";

import type { OcQueryResult } from "./types.js";

/** Localhost needs no generosity: a slow local server is an unusable one. */
const TIMEOUT_MS = 3_000;

export const BALANCE_PATH = "/api/balance";
export const ME_PATH = "/api/me";

/** The local server origin, honouring OLLAMA_HOST the way the CLI does. */
export function localOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.OLLAMA_HOST?.trim() || "127.0.0.1:11434";
  const stripped = raw.replace(/^https?:\/\//u, "").replace(/\/+$/u, "");
  return `http://${stripped}`;
}

/** Fetch the local balance JSON. Throws on network errors/timeout. */
export async function fetchLocalBalance(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ status: number; text: string }> {
  const resp = await fetchImpl(`${localOrigin(env)}${BALANCE_PATH}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { status: resp.status, text: await resp.text() };
}

/** Fetch the local /api/me account JSON. Same contract as the balance call. */
export async function fetchLocalMe(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ status: number; text: string }> {
  const resp = await fetchImpl(`${localOrigin(env)}${ME_PATH}`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { status: resp.status, text: await resp.text() };
}

/** One included window on the wire, keyed by its plan family. */
interface LocalWindow {
  remaining_percent: unknown;
  resets_at: unknown;
}

/**
 * Parse a balance body into a success-shaped {@link OcQueryResult}.
 *
 * `null` = the shape is not recognised (missing `included`, every window
 * malformed, or a remaining_percent outside [0, 100]) — the caller should fall
 * through to the API-key path instead of rendering garbage.
 */
export function parseLocalBalance(text: string, fetchedAt: number): OcQueryResult | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  const included = (body as { included?: unknown }).included;
  if (typeof included !== "object" || included === null) return null;

  const windows: Array<["session" | "weekly" | "monthly", number, number]> = [];
  for (const key of ["session", "weekly", "monthly"] as const) {
    const w = (included as Record<string, unknown>)[key] as LocalWindow | undefined;
    if (typeof w !== "object" || w === null) continue;
    const remaining = w.remaining_percent;
    if (typeof remaining !== "number" || !Number.isFinite(remaining) || remaining < 0 || remaining > 100)
      continue;
    if (typeof w.resets_at !== "string") continue;
    const resetAt = Date.parse(w.resets_at);
    if (!Number.isFinite(resetAt)) continue;
    windows.push([key, (100 - remaining) / 100, resetAt]);
  }
  if (windows.length === 0) return null;

  const purchased = (body as { purchased?: unknown }).purchased;
  const balanceUsd =
    typeof purchased === "object" && purchased !== null
      ? (purchased as { balance_usd?: unknown }).balance_usd
      : undefined;

  const result: OcQueryResult = {
    kind: "success",
    fetchedAt,
    ...(typeof balanceUsd === "number" && Number.isFinite(balanceUsd) && balanceUsd >= 0
      ? { purchasedUsd: balanceUsd }
      : {}),
  };
  const resetKeys = { session: "sessionResetAt", weekly: "weeklyResetAt", monthly: "monthlyResetAt" } as const;
  for (const [key, usage, resetAt] of windows) {
    (result as Record<string, unknown>)[key] = usage;
    (result as Record<string, unknown>)[resetKeys[key]] = resetAt;
  }
  return result;
}

/** Best-effort plan tier from the local /api/me (undefined on any failure). */
export async function lookupLocalPlan(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  try {
    const resp = await fetchLocalMe(fetchImpl, env);
    if (resp.status !== 200) return undefined;
    const parsed = JSON.parse(resp.text) as { plan?: unknown; Plan?: unknown };
    const plan = parsed.plan ?? parsed.Plan;
    return typeof plan === "string" && plan.length > 0 ? plan : undefined;
  } catch {
    return undefined;
  }
}