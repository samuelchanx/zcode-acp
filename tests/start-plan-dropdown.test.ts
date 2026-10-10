/**
 * Start-plan entries in the model dropdown (Weekend Build support).
 *
 * The desktop writes `enabled:false` on `builtin:<family>-start-plan` config
 * entries EVEN WHILE the plan is the user's active connection — the flag
 * tracks legacy-provider selection, not start-plan membership (verified
 * 2026-09-30). The plan JWT's presence is the connection record, so
 * `providerSelectable` keys on that for start plans, and the dropdown then
 * carries the start-plan models — which makes GLM-5.3/GLM-5.3-Flash AMBIGUOUS
 * (they exist on the individual plan too), flipping the advertised configOption
 * values to the qualified `providerId\modelId` spelling via modelChoiceValue.
 */

import { describe, expect, it, vi } from "vitest";

import { ZCODE_CREDS_PATH } from "../src/utils.js";

const FAKE_CONFIG = {
  provider: {
    "builtin:bigmodel-coding-plan": {
      name: "BigModel - Coding Plan",
      kind: "anthropic",
      enabled: true,
      options: { apiKey: "k-individual" },
      models: {
        "GLM-5.3": { limit: { context: 200000 } },
        "GLM-5.3-Flash": { limit: { context: 200000 } },
      },
    },
    "builtin:bigmodel-start-plan": {
      name: "BigModel - Start Plan",
      kind: "anthropic",
      enabled: false, // desktop writes this even for the ACTIVE plan
      options: { apiKey: "start-plan-jwt" },
      models: {
        "GLM-5.3": { limit: { context: 200000 } },
        "GLM-5.3-Flash": { limit: { context: 200000 } },
      },
    },
    "builtin:zai-start-plan": {
      name: "Z.ai - Start Plan",
      kind: "anthropic",
      enabled: false,
      options: { apiKey: "" }, // never provisioned — stays hidden
      models: { "GLM-5.3": {} },
    },
  },
};

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: (p: string) => {
      if (p === ZCODE_CREDS_PATH) return JSON.stringify(FAKE_CONFIG);
      return actual.readFileSync(p);
    },
  };
});

// Import AFTER vi.mock is set up.
const { loadAllModels, modelChoiceValue, parseModelValue, providerSelectable } = await import(
  "../src/config/options.js"
);

describe("providerSelectable start-plan rule", () => {
  it("selects a start plan on JWT presence despite enabled:false", () => {
    expect(
      providerSelectable("builtin:bigmodel-start-plan", {
        enabled: false,
        options: { apiKey: "jwt" },
      }),
    ).toBe(true);
    expect(
      providerSelectable("builtin:zai-start-plan", {
        enabled: false,
        options: { apiKey: "" },
      }),
    ).toBe(false);
    // Other builtins keep the enabled gate.
    expect(
      providerSelectable("builtin:bigmodel-coding-plan", {
        enabled: false,
        options: { apiKey: "k" },
      }),
    ).toBe(false);
  });
});

describe("loadAllModels with an active start plan", () => {
  it("includes start-plan models; a never-provisioned start plan stays out", () => {
    const models = loadAllModels();
    const providers = new Set(models.map((m) => m.providerId));
    expect(providers).toContain("builtin:bigmodel-start-plan");
    expect(providers).toContain("builtin:bigmodel-coding-plan");
    expect(providers).not.toContain("builtin:zai-start-plan");
    expect(models.filter((m) => m.providerId === "builtin:bigmodel-start-plan")).toHaveLength(2);
  });

  it("keeps the FIRST holder's spelling bare; later holders qualify", () => {
    // Individual (first in config.json) keeps the bare spelling so every
    // client with a stored bare id keeps resolving to it; the start plan
    // qualifies. parseModelValue's bare→first-owner rule matches.
    const models = loadAllModels();
    expect(modelChoiceValue("builtin:bigmodel-coding-plan", "GLM-5.3-Flash", models)).toBe(
      "GLM-5.3-Flash",
    );
    expect(modelChoiceValue("builtin:bigmodel-start-plan", "GLM-5.3-Flash", models)).toBe(
      "builtin:bigmodel-start-plan\\GLM-5.3-Flash",
    );
    // Qualified values round-trip.
    expect(parseModelValue("builtin:bigmodel-start-plan\\GLM-5.3-Flash")).toEqual({
      providerId: "builtin:bigmodel-start-plan",
      modelId: "GLM-5.3-Flash",
    });
    // Bare round-trips to the first owner.
    expect(parseModelValue("GLM-5.3-Flash")).toEqual({
      providerId: "builtin:bigmodel-coding-plan",
      modelId: "GLM-5.3-Flash",
    });
  });
});
