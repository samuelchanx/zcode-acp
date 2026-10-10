/**
 * lastRequestContextUsed tests — the resume-time context-size fallback that
 * reads the zcode store directly (`~/.zcode/cli/db/db.sqlite`, overridable
 * via ZCODE_USAGE_DB).
 *
 * Regression guard for fe036c9 + 45b39bd: a TURN's computed_total_tokens sums
 * every model request in the turn (one per tool-call round-trip, each
 * re-sending the full context), so resuming an agentic session reported e.g.
 * 22.7M used on a 1M window. The per-request model_usage row is the truth;
 * the turn aggregate is only a fallback without a completed model_usage row.
 *
 * Runs against a real temp sqlite db via node:sqlite (the same dynamic import
 * the source uses); skipped on runtimes without it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { lastRequestContextUsed } from "../src/config/model-cache.js";

/**
 * `node:sqlite` through `createRequire` — a dynamic `import("node:sqlite")`
 * makes vite resolve a package named `sqlite` and the file fails to transform
 * (same workaround as the source module and settings-usage-reset.test.ts).
 */
const sqlite = (() => {
  try {
    const require = createRequire(import.meta.url);
    return require("node:sqlite") as { DatabaseSync: new (p: string, o?: unknown) => SqliteDb };
  } catch {
    return null;
  }
})();

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): { run(...args: unknown[]): unknown };
  close(): void;
}

let dbPath: string | null = null;

afterEach(() => {
  if (dbPath) {
    rmSync(dbPath, { force: true });
    dbPath = null;
  }
  vi.unstubAllEnvs();
});

/** Create a temp store with the two usage tables and return its path. */
function makeStore(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "zcode-usage-"));
  dbPath = path.join(dir, "db.sqlite");
  const db = new sqlite!.DatabaseSync(dbPath);
  db.exec(
    `CREATE TABLE model_usage (
       session_id TEXT NOT NULL,
       status TEXT NOT NULL,
       started_at INTEGER NOT NULL,
       computed_total_tokens INTEGER NOT NULL
     );
     CREATE TABLE turn_usage (
       session_id TEXT NOT NULL,
       status TEXT NOT NULL,
       started_at INTEGER NOT NULL,
       computed_total_tokens INTEGER NOT NULL
     );`,
  );
  db.close();
  return dbPath;
}

function insert(table: "model_usage" | "turn_usage", row: [string, string, number, number]): void {
  const db = new sqlite!.DatabaseSync(dbPath!);
  db.prepare(
    `INSERT INTO ${table} (session_id, status, started_at, computed_total_tokens)
     VALUES (?, ?, ?, ?)`,
  ).run(...row);
  db.close();
}

describe.skipIf(!sqlite)("lastRequestContextUsed", () => {
  it("prefers the NEWEST completed model_usage row over the turn aggregate", async () => {
    const store = makeStore();
    // Agentic turn shape: one turn sums 3 model requests → 22.7M aggregate,
    // while the newest single request actually carried 130K of context.
    insert("model_usage", ["sess", "completed", 1000, 150_000]);
    insert("model_usage", ["sess", "completed", 2000, 130_000]);
    insert("turn_usage", ["sess", "completed", 2000, 22_700_000]);
    vi.stubEnv("ZCODE_USAGE_DB", store);

    await expect(lastRequestContextUsed("sess")).resolves.toBe(130_000);
  });

  it("ignores non-completed model_usage rows (falls back to the turn aggregate)", async () => {
    const store = makeStore();
    insert("model_usage", ["sess", "running", 2000, 999_999]);
    insert("turn_usage", ["sess", "completed", 2000, 90_000]);
    vi.stubEnv("ZCODE_USAGE_DB", store);

    await expect(lastRequestContextUsed("sess")).resolves.toBe(90_000);
  });

  it("returns 0 for a session with no completed rows anywhere", async () => {
    const store = makeStore();
    insert("model_usage", ["other", "completed", 1000, 50_000]);
    insert("turn_usage", ["other", "completed", 1000, 50_000]);
    vi.stubEnv("ZCODE_USAGE_DB", store);

    await expect(lastRequestContextUsed("sess")).resolves.toBe(0);
  });

  it("returns 0 when the store file is missing", async () => {
    vi.stubEnv("ZCODE_USAGE_DB", path.join(tmpdir(), "zcode-usage-missing", "db.sqlite"));

    await expect(lastRequestContextUsed("sess")).resolves.toBe(0);
  });
});
