/**
 * Daemon-side quota fetch: spawn the bridge's `zcode-acp quota --json` (the
 * same credentials and cache the /quota slash command uses — no zcode
 * subprocess involved), validate it against the shared contract, and cache
 * briefly so the Usage screen's polling and the plugin screen share results.
 *
 * Binary resolution: `zcode-acp` (the unified CLI bin — NOT `zcode-acp-server`,
 * which always starts the ACP server on stdio) resolved from the daemon's PATH
 * first, then common global-bin fallbacks, then ZCODE_ACP_QUOTA_BIN as an
 * override. This mirrors how runAcpProvider resolves the bridge binary.
 */

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

import type { RpcInput, RpcOutput } from "@getpaseo/plugin";

import {
  bridgeQuotaSchema,
  quotaGet,
  type QuotaOutput,
  type QuotaProvider,
} from "../shared/quota";

const TIMEOUT_MS = 45_000;
const CACHE_TTL_MS = 30_000;
const MAX_BUFFER = 1024 * 1024;

/** Candidate binaries, highest precedence first. */
function candidates(): string[] {
  const override = process.env.ZCODE_ACP_QUOTA_BIN?.trim();
  const home = homedir();
  return [
    ...(override ? [override] : []),
    "zcode-acp",
    path.join(home, ".local", "bin", "zcode-acp"),
    "/opt/homebrew/bin/zcode-acp",
    "/usr/local/bin/zcode-acp",
  ];
}

interface ExecResult {
  stdout: string;
  stderr: string;
}

function execBin(bin: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          const enriched = error as Error & { code?: unknown; stderr?: string };
          enriched.stderr = stderr;
          reject(enriched);
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });
}

/** True when the binary itself was missing (try the next candidate). */
function isNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === 127;
}

let loggedBin: string | undefined;

async function runBridge(provider: QuotaProvider): Promise<QuotaOutput> {
  const args = ["quota", "--json"];
  if (provider !== "all") args.splice(1, 0, provider);
  let lastError: unknown;
  for (const bin of candidates()) {
    try {
      const { stdout } = await execBin(bin, args);
      if (bin !== loggedBin) {
        loggedBin = bin;
        console.log(`[zcode-acp] quota RPC using binary: ${bin}`);
      }
      const parsed = bridgeQuotaSchema.parse(JSON.parse(stdout));
      // Stamp the query time AFTER validation: the bridge itself doesn't
      // emit one, and a failed parse must not be salvaged by stamping.
      return { ...parsed, queriedAt: Date.now() };
    } catch (error) {
      lastError = error;
      if (!isNotFound(error)) break;
    }
  }
  const message =
    lastError instanceof Error ? lastError.message : String(lastError);
  console.error(`[zcode-acp] quota RPC failed: ${message}`);
  return {
    glm: { kind: "unavailable" },
    go: { kind: "unavailable" },
    oc: { kind: "unavailable" },
    queriedAt: Date.now(),
    error: `Could not query the zcode-acp bridge: ${message}`,
  };
}

const caches = new Map<string, { at: number; data: QuotaOutput }>();

/** Test hook: drop all TTL caches. */
export function clearQuotaCache(): void {
  caches.clear();
}

/** Fetch quota for one provider selection, through the short TTL cache. */
export async function fetchQuota(provider: QuotaProvider): Promise<QuotaOutput> {
  const hit = caches.get(provider);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  const data = await runBridge(provider);
  caches.set(provider, { at: Date.now(), data });
  return data;
}

/** RPC handler for {@link quotaGet}. */
export async function handleQuota(
  input: RpcInput<typeof quotaGet>,
): Promise<RpcOutput<typeof quotaGet>> {
  return fetchQuota(input.provider ?? "all");
}
