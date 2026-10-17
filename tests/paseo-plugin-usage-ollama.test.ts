/**
 * Native usage source for Ollama Cloud (paseo-plugin/server/usage-ollama.ts)
 * — hermetic tests.
 *
 * The RPC path is exercised through the same stub-binary harness as
 * paseo-plugin-quota.test.ts (ZCODE_ACP_QUOTA_BIN override, so the real
 * `zcode-acp` on PATH is never spawned); the ocReport mapping is tested purely.
 */

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearQuotaCache } from "../paseo-plugin/server/quota.js";
import type { QuotaOutput } from "../paseo-plugin/shared/quota";
import { createOllamaUsageSource, ocReport } from "../paseo-plugin/server/usage-ollama.js";

const OC_SUCCESS: QuotaOutput = {
  glm: { kind: "unavailable" },
  go: { kind: "not_configured" },
  oc: {
    kind: "success",
    session: 0.3175,
    weekly: 0.6898,
    sessionResetAt: Date.parse("2026-10-17T08:00:00Z"),
    weeklyResetAt: Date.parse("2026-10-19T00:00:00Z"),
    plan: "pro",
    purchasedUsd: 0,
    fetchedAt: 1,
  },
  queriedAt: 1,
};

const OC_NOT_CONFIGURED: QuotaOutput = {
  glm: { kind: "unavailable" },
  go: { kind: "not_configured" },
  oc: { kind: "not_configured" },
  queriedAt: 1,
};

function stubBin(scriptBody: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "zacp-usage-oc-stub-"));
  const script = path.join(dir, "zcode-acp-usage-oc-stub");
  writeFileSync(script, `#!/bin/sh\n${scriptBody}\n`);
  chmodSync(script, 0o755);
  return script;
}

// --- ocReport (pure mapping) -------------------------------------------------

describe("ocReport", () => {
  it("maps windows with percent, tone, and ISO resets; plan goes into planLabel", () => {
    const report = ocReport(OC_SUCCESS);
    expect(report.status).toBe("available");
    if (report.status !== "available") return;
    expect(report.planLabel).toBe("Ollama Cloud · pro");
    expect(report.windows).toHaveLength(2);

    const [fiveHour, weekly] = report.windows;
    expect(fiveHour).toMatchObject({
      id: "five-hour",
      label: "5-hour",
      usedPct: 31.75,
      remainingPct: 68.25,
      tone: "ok",
      resetsAt: new Date(Date.parse("2026-10-17T08:00:00Z")).toISOString(),
    });
    expect(weekly).toMatchObject({ id: "weekly", usedPct: 68.98, tone: "ok" });
  });

  it("turns warning at >=70% and danger beyond 90%", () => {
    const ok = ocReport({
      glm: { kind: "unavailable" },
      go: { kind: "not_configured" },
      oc: { kind: "success", weekly: 0.6898, weeklyResetAt: 1, fetchedAt: 1 },
      queriedAt: 1,
    });
    if (ok.status !== "available") throw new Error("expected available");
    expect(ok.windows[0]).toMatchObject({ tone: "ok" });

    const warn = ocReport({
      glm: { kind: "unavailable" },
      go: { kind: "not_configured" },
      oc: { kind: "success", weekly: 0.74, weeklyResetAt: 1, fetchedAt: 1 },
      queriedAt: 1,
    });
    if (warn.status !== "available") throw new Error("expected available");
    expect(warn.windows[0]).toMatchObject({ tone: "warning" });

    const danger = ocReport({
      glm: { kind: "unavailable" },
      go: { kind: "not_configured" },
      oc: { kind: "success", weekly: 0.91, weeklyResetAt: 1, fetchedAt: 1 },
      queriedAt: 1,
    });
    if (danger.status !== "available") throw new Error("expected available");
    expect(danger.windows[0]).toMatchObject({ tone: "danger" });
  });

  it("carries purchased credits as a usd balance; ok tone while non-zero", () => {
    const withCredit = ocReport({
      glm: { kind: "unavailable" },
      go: { kind: "not_configured" },
      oc: { kind: "success", weekly: 0.2, purchasedUsd: 4.25, fetchedAt: 1 },
      queriedAt: 1,
    });
    if (withCredit.status !== "available") throw new Error("expected available");
    expect(withCredit.planLabel).toBe("Ollama Cloud");
    expect(withCredit.balances?.[0]).toMatchObject({
      id: "ollama-credits",
      unit: "usd",
      remaining: 4.25,
      tone: "ok",
    });

    const zero = ocReport({
      glm: { kind: "unavailable" },
      go: { kind: "not_configured" },
      oc: { kind: "success", weekly: 0.2, purchasedUsd: 0, fetchedAt: 1 },
      queriedAt: 1,
    });
    if (zero.status !== "available") throw new Error("expected available");
    expect(zero.balances?.[0]).toMatchObject({ tone: "default" });
  });

  it("degrades to typed non-available states", () => {
    const nc = ocReport(OC_NOT_CONFIGURED);
    expect(nc).toMatchObject({ status: "unavailable", problem: { kind: "no_quota" } });

    const auth = ocReport({
      glm: { kind: "unavailable" },
      go: { kind: "not_configured" },
      oc: { kind: "auth_error" },
      queriedAt: 1,
    });
    expect(auth.status).toBe("unavailable");

    const dead = ocReport({
      glm: { kind: "unavailable" },
      go: { kind: "not_configured" },
      oc: { kind: "unavailable" },
      queriedAt: 1,
      error: "bridge down",
    });
    expect(dead).toMatchObject({ status: "error", error: "bridge down" });
  });
});

// --- discovery scoping (stubbed bridge binary) -------------------------------

describe("createOllamaUsageSource().discover (stubbed bridge)", () => {
  beforeEach(() => {
    clearQuotaCache();
  });

  afterEach(() => {
    delete process.env.ZCODE_ACP_QUOTA_BIN;
  });

  it("hands out the account for global scope and router/cloud sessions", async () => {
    process.env.ZCODE_ACP_QUOTA_BIN = stubBin(`echo '${JSON.stringify(OC_SUCCESS)}'`);
    const source = createOllamaUsageSource();

    const global = await source.discover({ kind: "global" });
    expect(global).toHaveLength(1);
    expect(global[0]?.key).toBe("ollama-cloud");

    expect(
      await source.discover({ kind: "session", provider: "router", model: "glm-5.3[1m]", env: {} }),
    ).toHaveLength(1);
    expect(
      await source.discover({
        kind: "session",
        provider: "router",
        model: "kimi-k2.7-code:cloud",
        env: {},
      }),
    ).toHaveLength(1);
    // A :cloud model on ANY provider draws on the shared ollama identity.
    expect(
      await source.discover({
        kind: "session",
        provider: "zcode",
        model: "glm-5.3:cloud[1m]",
        env: {},
      }),
    ).toHaveLength(1);
  });

  it("keeps the card away from providers with no ollama traffic", async () => {
    process.env.ZCODE_ACP_QUOTA_BIN = stubBin(`echo '${JSON.stringify(OC_SUCCESS)}'`);
    const source = createOllamaUsageSource();
    expect(
      await source.discover({ kind: "session", provider: "codex", model: "gpt-5.4", env: {} }),
    ).toHaveLength(0);
  });

  it("no account when Ollama is not configured anywhere", async () => {
    process.env.ZCODE_ACP_QUOTA_BIN = stubBin(`echo '${JSON.stringify(OC_NOT_CONFIGURED)}'`);
    const source = createOllamaUsageSource();
    expect(await source.discover({ kind: "global" })).toHaveLength(0);
    expect(await source.fetch({})).toMatchObject({ status: "unavailable" });
  });
});