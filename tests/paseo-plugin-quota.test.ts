/**
 * Quota surface of the paseo plugin — hermetic unit tests.
 *
 * The RPC handler is exercised end-to-end against a STUB binary via
 * ZCODE_ACP_QUOTA_BIN (the override candidate is tried first, so the real
 * `zcode-acp` on PATH is never spawned): canned CombinedResult JSON is
 * validated through the shared contract, garbage degrades to the typed
 * unavailable shape, and the TTL cache collapses repeat calls. The native
 * usage mapping (glmReport) is tested purely.
 */

import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearQuotaCache, fetchQuota } from "../paseo-plugin/server/quota.js";
import { glmReport } from "../paseo-plugin/server/usage.js";

const CANNED = {
  glm: {
    kind: "success",
    level: "max",
    items: [
      { key: "token_5h", label: "5h", usedPercent: 1, leftPercent: 99, nextResetTime: 1791645148626 },
      { key: "token_1", label: "1", usedPercent: 43, leftPercent: 57, nextResetTime: 1791770642981 },
      {
        key: "mcp",
        label: "MCP",
        usedPercent: 6,
        leftPercent: 94,
        usedCount: 239,
        totalCount: 4000,
        nextResetTime: 1791872145997,
        detail: [{ modelCode: "search-prime", usage: 216 }],
      },
    ],
  },
  go: { kind: "not_configured" },
  oc: { kind: "not_configured" },
};

function stubBin(scriptBody: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "zacp-quota-stub-"));
  const script = path.join(dir, "zcode-acp-quota-stub");
  writeFileSync(script, `#!/bin/sh\n${scriptBody}\n`);
  chmodSync(script, 0o755);
  return script;
}

beforeEach(() => {
  clearQuotaCache();
});

afterEach(() => {
  delete process.env.ZCODE_ACP_QUOTA_BIN;
});

describe("quota RPC handler (stubbed bridge binary)", () => {
  it("validates and passes through a canned bridge response", async () => {
    process.env.ZCODE_ACP_QUOTA_BIN = stubBin(`echo '${JSON.stringify(CANNED)}'`);
    const out = await fetchQuota("all");
    expect(out.glm.kind).toBe("success");
    expect(out.go.kind).toBe("not_configured");
    expect(out.oc.kind).toBe("not_configured");
    expect(out.error).toBeUndefined();
    if (out.glm.kind === "success") {
      expect(out.glm.items.map((item) => item.key)).toEqual(["token_5h", "token_1", "mcp"]);
    }
    expect(typeof out.queriedAt).toBe("number");
  });

  it("degrades to the typed unavailable shape when the bridge prints garbage", async () => {
    process.env.ZCODE_ACP_QUOTA_BIN = stubBin(`echo "not json at all"`);
    const out = await fetchQuota("glm");
    expect(out.glm).toEqual({ kind: "unavailable" });
    expect(out.go).toEqual({ kind: "unavailable" });
    expect(out.oc).toEqual({ kind: "unavailable" });
    expect(out.error).toMatch(/Could not query the zcode-acp bridge/);
  });

  it("serves repeat calls from the TTL cache (one spawn per window)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zacp-quota-count-"));
    const counter = path.join(dir, "spawns");
    process.env.ZCODE_ACP_QUOTA_BIN = stubBin(
      `echo x >> ${JSON.stringify(counter)}; echo '${JSON.stringify(CANNED)}'`,
    );
    await fetchQuota("all");
    await fetchQuota("all");
    await fetchQuota("all");
    expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(1);
  });
});

describe("glmReport — native usage mapping", () => {
  const base = { queriedAt: 1, error: undefined } as const;

  it("maps token/mcp items onto the native windows in order", () => {
    const report = glmReport({ ...CANNED, ...base });
    expect(report.status).toBe("available");
    if (report.status !== "available") return;
    expect(report.windows.map((w) => w.id)).toEqual(["five_hour", "weekly", "mcp"]);
    expect(report.planLabel).toBe("GLM Coding Plan · max");
    for (const w of report.windows) {
      expect(w.tone).toBe("ok"); // 1% / 43% / 6% are all healthy
      expect(w.remainingPct).toBe(100 - (w.usedPct ?? -1));
    }
  });

  it("derives warning and danger tones at 70 / 90", () => {
    const report = glmReport({
      glm: {
        kind: "success",
        level: "pro",
        items: [
          { key: "token_5h", label: "5h", usedPercent: 75, leftPercent: 25 },
          { key: "token_1", label: "1", usedPercent: 95, leftPercent: 5 },
        ],
      },
      go: { kind: "not_configured" },
      oc: { kind: "not_configured" },
      ...base,
    });
    if (report.status !== "available") throw new Error("expected available");
    expect(report.windows.map((w) => w.tone)).toEqual(["warning", "danger"]);
  });

  it("maps auth_error to an unavailable no_quota problem", () => {
    const report = glmReport({
      glm: { kind: "auth_error" },
      go: { kind: "not_configured" },
      oc: { kind: "not_configured" },
      ...base,
    });
    expect(report).toEqual({
      status: "unavailable",
      problem: { kind: "no_quota", detail: expect.stringMatching(/~\/\.zcode/) },
    });
  });

  it("maps a bridge-level failure to an error report", () => {
    const report = glmReport({
      glm: { kind: "unavailable" },
      go: { kind: "unavailable" },
      oc: { kind: "unavailable" },
      queriedAt: 1,
      error: "Could not query the zcode-acp bridge: spawn ENOENT",
    });
    expect(report).toEqual({
      status: "error",
      error: "Could not query the zcode-acp bridge: spawn ENOENT",
    });
  });
});
