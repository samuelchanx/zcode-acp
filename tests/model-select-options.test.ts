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
import { isPersistedModelStillEnabled } from "../src/handlers/session.js";

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
    // First-owner-bare (2026-09-30): the primary plan keeps the bare spelling
    // so stored bare ids (Paseo agents, editor session state) keep matching —
    // the qualified spelling disambiguates only the SECONDARY holder. Names
    // follow the value shape: bare values show the modelId, qualified values
    // show "provider › model".
    expect(model?.options.map((option) => option.value)).toEqual([
      "GLM-5.3",
      "GLM-5.3-Flash",
      "builtin:zai-start-plan\\GLM-5.3",
      "builtin:zai-start-plan\\GLM-5.3-Flash",
    ]);
    expect(model?.options.map((option) => option.name)).toEqual([
      "GLM-5.3",
      "GLM-5.3-Flash",
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

  it("qualifies only the SECONDARY holder of a colliding builtin id", async () => {
    // Colliding plans stay unambiguous: the first holder advertises bare
    // (its stored ids keep matching), later holders qualify (2026-09-30,
    // first-owner-bare — supersedes the all-qualified rule from #175).
    const options = await buildConfigOptions(new ZcodeAcpServer(), null);
    const model = options.find((option) => option.id === "model");
    const values = model?.options.map((option) => option.value) ?? [];

    expect(values).toContain("GLM-5.3");
    expect(values).toContain("GLM-5.3-Flash");
    expect(values).toContain("builtin:zai-start-plan\\GLM-5.3");
    expect(values).toContain("builtin:zai-start-plan\\GLM-5.3-Flash");
    expect(values).not.toContain("builtin:zai-coding-plan\\GLM-5.3");
    // Uniqueness — the invariant #175 was about — still holds.
    expect(values).toEqual([...new Set(values)]);
  });

  it("resolves a bare id unique to the second enabled plan to ITS provider (ownership, not order)", () => {
    // Two enabled plans with disjoint extra models: GLM-4.7 exists only on
    // the start plan, so it is advertised BARE (no collision) — but
    // resolving it to the first enabled builtin (the old rule) sent the
    // switch to the coding plan and failed with "Provider Registry 中不
    // 存在 Model": the selected-model-not-applied shape.
    fakeConfig = {
      provider: {
        "builtin:zai-coding-plan": codingPlan(
          "Z.ai - Coding Plan",
          "https://api.z.ai/api/anthropic",
        ),
        "builtin:zai-start-plan": {
          ...codingPlan("Z.ai - Start Plan", "https://zcode.z.ai/api/v1/zcode-plan/anthropic"),
          models: {
            "GLM-5.3": { limit: { context: 200000 } },
            "GLM-4.7": { limit: { context: 128000 } },
          },
        },
      },
    };

    expect(parseModelValue("GLM-4.7")).toEqual({
      providerId: "builtin:zai-start-plan",
      modelId: "GLM-4.7",
    });
    // Models on the FIRST plan still resolve to it, and colliding ids keep
    // the first-owner tiebreak.
    expect(parseModelValue("GLM-5.3")).toEqual({
      providerId: "builtin:zai-coding-plan",
      modelId: "GLM-5.3",
    });
  });

  it("falls back to the first enabled builtin for a bare id no provider carries", () => {
    // Unknown ids keep the legacy fallback so applyModelSwitch surfaces the
    // registry's own error instead of the bridge inventing one.
    fakeConfig = {
      provider: {
        "builtin:zai-coding-plan": codingPlan(
          "Z.ai - Coding Plan",
          "https://api.z.ai/api/anthropic",
        ),
      },
    };

    expect(parseModelValue("GLM-9.9")).toEqual({
      providerId: "builtin:zai-coding-plan",
      modelId: "GLM-9.9",
    });
  });
});

/**
 * repairUnavailableModel compares the session's persisted model against the
 * enabled catalog. The backend reports its current model in the account
 * registry spelling (`account:<family>-individual-coding-plan`), the catalog
 * spells the same plan `builtin:<family>-coding-plan`; an exact-provider
 * comparison read that as "no longer enabled" and silently downgraded idle
 * sessions to the first catalog model (observed: GLM-5.3-Flash sessions
 * reverted to GLM-5.3 whenever a prompt followed an idle gap — the backend
 * respawned, the reload ran the repair). The comparison must accept either
 * spelling (verified 2026-10-01 from ~/.zcode/cli/log/zcode-acp-*.log).
 */
describe("isPersistedModelStillEnabled", () => {
  const catalog = [
    {
      providerId: "builtin:bigmodel-coding-plan",
      providerName: "GLM Coding Plan",
      modelId: "GLM-5.3",
    },
    {
      providerId: "builtin:bigmodel-coding-plan",
      providerName: "GLM Coding Plan",
      modelId: "GLM-5.3-Flash",
    },
    {
      providerId: "builtin:bigmodel-start-plan",
      providerName: "GLM Start Plan",
      modelId: "GLM-5.3-Flash",
    },
  ];

  it("accepts the backend account spelling of a configured plan (" +
    "`account:<family>-individual-coding-plan` vs catalog `builtin:<family>-coding-plan`)", () => {
    expect(
      isPersistedModelStillEnabled(catalog, {
        providerId: "account:bigmodel-individual-coding-plan",
        modelId: "GLM-5.3-Flash",
      }),
    ).toBe(true);
  });

  it("accepts the exact config spelling unchanged", () => {
    expect(
      isPersistedModelStillEnabled(catalog, {
        providerId: "builtin:bigmodel-start-plan",
        modelId: "GLM-5.3-Flash",
      }),
    ).toBe(true);
  });

  it("downgrades only when no enabled provider carries the model under either spelling", () => {
    expect(
      isPersistedModelStillEnabled(catalog, {
        providerId: "account:bigmodel-individual-coding-plan",
        modelId: "GLM-9.9",
      }),
    ).toBe(false);
  });
});
