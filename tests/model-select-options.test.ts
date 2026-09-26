/**
 * ACP model option values stay the legacy BARE modelId for unambiguous
 * builtins and qualify (providerId\modelId) only when the bare id would be
 * ambiguous: colliding builtin ids across coding plans (which crashed clients
 * that key on uniqueness — Paseo Command Center) and third-party providers.
 *
 * Why bare is load-bearing for orchestrators: Paseo provider configs and
 * saved agent profiles store bare modelIds and validate a REQUESTED model by
 * exact match against the advertised values before sending the switch. The
 * always-qualified encoding (#175) made every such stored id fail validation
 * client-side, so flash-configured Paseo agents silently ran the default
 * GLM-5.3 (observed 2026-09-26: 109/150 agents misrouted, daemon log full of
 * "is not a valid acp model config option"). parseModelValue accepts both
 * spellings inbound, so bare advertised values round-trip.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { ZCODE_CREDS_PATH } from "../src/utils.js";
import { ZcodeAcpServer } from "../src/server.js";

function codingPlan(name: string, baseURL: string) {
  return {
    name,
    kind: "anthropic",
    enabled: true,
    options: { apiKey: "plan-token", apiKeyRequired: true, baseURL },
    models: {
      "GLM-5.3": { limit: { context: 200000 } },
      "GLM-5.3-Flash": { limit: { context: 200000 } },
    },
  };
}

function collidingPlansConfig() {
  return {
    provider: {
      "builtin:zai-coding-plan": codingPlan("Z.ai - Coding Plan", "https://api.z.ai/api/anthropic"),
      "builtin:zai-start-plan": codingPlan(
        "Z.ai - Start Plan",
        "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
      ),
    },
  };
}

let fakeConfig: unknown = collidingPlansConfig();

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: (p: string) => {
      if (p === ZCODE_CREDS_PATH) return JSON.stringify(fakeConfig);
      return actual.readFileSync(p);
    },
  };
});

const { buildConfigOptions, formatModelValue, parseModelValue } =
  await import("../src/config/options.js");

afterEach(() => {
  fakeConfig = collidingPlansConfig();
});

describe("model configOptions uniqueness", () => {
  it("does not advertise duplicate values when two builtins share GLM-5.3", async () => {
    const options = await buildConfigOptions(new ZcodeAcpServer(), null);
    const model = options.find((option) => option.id === "model");
    const values = model?.options.map((option) => option.value) ?? [];

    expect(values).toEqual([...new Set(values)]);
    expect(values).toHaveLength(4);
    expect(model?.currentValue).toBeDefined();
    expect(values).toContain(model?.currentValue);
  });

  it("keeps both colliding coding plans selectable", async () => {
    const options = await buildConfigOptions(new ZcodeAcpServer(), null);
    const model = options.find((option) => option.id === "model");
    const parsed = (model?.options ?? []).map((option) => parseModelValue(option.value));

    expect(parsed).toEqual([
      { providerId: "builtin:zai-coding-plan", modelId: "GLM-5.3" },
      { providerId: "builtin:zai-coding-plan", modelId: "GLM-5.3-Flash" },
      { providerId: "builtin:zai-start-plan", modelId: "GLM-5.3" },
      { providerId: "builtin:zai-start-plan", modelId: "GLM-5.3-Flash" },
    ]);
    expect(model?.options.map((option) => option.name)).toEqual([
      "Z.ai - Coding Plan › GLM-5.3",
      "Z.ai - Coding Plan › GLM-5.3-Flash",
      "Z.ai - Start Plan › GLM-5.3",
      "Z.ai - Start Plan › GLM-5.3-Flash",
    ]);
  });

  it("advertises legacy bare ids for a single unambiguous builtin plan", async () => {
    fakeConfig = {
      provider: {
        "builtin:zai-coding-plan": codingPlan(
          "Z.ai - Coding Plan",
          "https://api.z.ai/api/anthropic",
        ),
      },
    };

    const options = await buildConfigOptions(new ZcodeAcpServer(), null);
    const model = options.find((option) => option.id === "model");
    const values = model?.options.map((option) => option.value) ?? [];

    expect(values).toEqual(["GLM-5.3", "GLM-5.3-Flash"]);
    expect(model?.options.map((option) => option.name)).toEqual(["GLM-5.3", "GLM-5.3-Flash"]);
    // currentValue uses the same spelling as the choices so client dropdowns
    // highlight the active model.
    expect(model?.currentValue).toBe("GLM-5.3");
    // Round-trip: parseModelValue resolves a bare value back to the enabled
    // builtin provider.
    expect(parseModelValue("GLM-5.3-Flash")).toEqual({
      providerId: "builtin:zai-coding-plan",
      modelId: "GLM-5.3-Flash",
    });
    // formatModelValue keeps the qualified spelling for inbound/internal
    // callers (env pin, fallback switches) — parseModelValue accepts it.
    expect(formatModelValue("builtin:zai-coding-plan", "GLM-5.3")).toBe(
      "builtin:zai-coding-plan\\GLM-5.3",
    );
  });

  it("qualifies colliding builtin ids so values stay unique per plan", async () => {
    // Colliding plans keep the #175 disambiguation: both plans ship GLM-5.3,
    // so the bare id would be ambiguous and the qualified spelling is
    // required for uniqueness.
    const options = await buildConfigOptions(new ZcodeAcpServer(), null);
    const model = options.find((option) => option.id === "model");
    const values = model?.options.map((option) => option.value) ?? [];

    expect(values).toContain("builtin:zai-coding-plan\\GLM-5.3");
    expect(values).toContain("builtin:zai-start-plan\\GLM-5.3");
    expect(values).not.toContain("GLM-5.3");
    expect(values).not.toContain("GLM-5.3-Flash");
  });
});
