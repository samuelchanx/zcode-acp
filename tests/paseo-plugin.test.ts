/**
 * Paseo provider plugin — seam test (spec: samuelchanx/zcode-acp#1).
 *
 * The single seam is the plugin's server entry exercised end-to-end against
 * the BUILT bridge: `contribute()` registers the provider, and the shim's
 * connect → catalog → close cycle drives a real spawned `zcode-acp-server`
 * child (a PATH shim over dist/index.js). Everything below the seam is
 * Paseo's own tested shim code — we assert the externally observable
 * contract we depend on, not its internals.
 *
 * The catalog contract is hermetic: the bridge's session/new is LAZY (no
 * backend spawn — verified with ZCODE_BIN pointed at nothing), so a
 * synthetic ~/.zcode/v2/config.json in the hermetic HOME fully determines
 * the advertised models, thinking options, and modes. The hermetic shim
 * also poisons ZCODE_BIN so no code path can reach a real backend on a dev
 * machine.
 *
 * The live-gated describe covers what genuinely needs a real backend:
 * a thinking-option write materializes the backend session, and a real
 * model turn emits session.usage (the context-meter feed). Opt in with
 * ZCODE_ACP_PLUGIN_LIVE=<real HOME> (uses real credentials and quota):
 *
 *   ZCODE_ACP_PLUGIN_LIVE="$HOME" npx vitest run tests/paseo-plugin.test.ts
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { PluginServerContext } from "@getpaseo/plugin/server";
import { PROVIDER_CAPABILITIES } from "@getpaseo/plugin/server/provider";
import type {
  ProviderConnection,
  ProviderEvent,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import contribute from "../paseo-plugin/index.server.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = path.join(repoRoot, "paseo-plugin");
const distEntry = path.join(repoRoot, "dist", "index.js");

// Spec: the integration test gates on dist/ existing — same story as the
// smoke script. Everything else still runs (registration + manifest are
// pure), so only the bridge-driving describes skip.
const hasBuild = existsSync(distEntry);
const describeBuilt = hasBuild ? describe : describe.skip;

// Live gate: the env var's VALUE is the real HOME to run the bridge child
// under (the vitest worker's own HOME is the hermetic temp dir by then).
const liveHome = process.env.ZCODE_ACP_PLUGIN_LIVE;
const describeLive = liveHome ? describeBuilt : describe.skip;

const originalPath = process.env.PATH;

function writeShim(dir: string, envPrefix: string): string {
  const script = path.join(dir, "zcode-acp-server");
  // `node dist/index.js` is the ACP-over-stdio entry (same one `pnpm smoke`
  // boots). argv[0] games are irrelevant here — index.js IS the server.
  writeFileSync(script, `#!/bin/sh\n${envPrefix}exec node ${JSON.stringify(distEntry)} "$@"\n`);
  chmodSync(script, 0o755);
  return dir;
}

/** Shim whose child can never reach a real zcode backend (hermetic runs). */
function makePoisonedShim(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "zacp-plugin-shim-"));
  return writeShim(dir, "ZCODE_BIN=/nonexistent-zcode-bin ");
}

/** Shim with normal backend resolution (live runs). */
function makeShim(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "zacp-plugin-shim-"));
  return writeShim(dir, "");
}

function writeSyntheticZcodeConfig(): void {
  const home = process.env.HOME;
  if (!home) throw new Error("hermetic HOME missing");
  mkdirSync(path.join(home, ".zcode", "v2"), { recursive: true });
  writeFileSync(
    path.join(home, ".zcode", "v2", "config.json"),
    JSON.stringify({
      provider: {
        "builtin:bigmodel-coding-plan": {
          name: "BigModel - Coding Plan",
          enabled: true,
          options: { apiKey: "test-key" },
          models: {
            "GLM-5.3": {
              limit: { context: 1000000 },
              reasoning: { enabled: true, variants: ["low", "max", "high"], defaultVariant: "max" },
            },
            "GLM-5.3-Flash": {
              limit: { context: 1000000 },
              reasoning: { enabled: true, variants: ["low", "max", "high"], defaultVariant: "max" },
            },
          },
        },
        "builtin:bigmodel-start-plan": {
          name: "BigModel - Coding Plan",
          enabled: false,
          options: { apiKey: "fake-jwt" },
          models: {
            "GLM-5.3": { limit: { context: 200000 } },
            "GLM-5.3-Flash": { limit: { context: 200000 } },
          },
        },
      },
    }),
  );
}

/** Register the plugin through a minimal server-context double. */
function registeredProviders(): ProviderRegistration[] {
  const captured: ProviderRegistration[] = [];
  const fakeServer = {
    registerProvider: (provider: ProviderRegistration) => {
      captured.push(provider);
    },
    handle: () => {},
    registerUsageSource: () => {},
  } as unknown as PluginServerContext;
  const cleanup = contribute(fakeServer);
  expect(typeof cleanup).toBe("function");
  return captured;
}

/** Collect provider events; resolve when a matching one arrives. */
class EventLog {
  readonly events: ProviderEvent[] = [];
  private unsubscribe: () => void;

  constructor(connection: ProviderConnection) {
    this.unsubscribe = connection.onEvent((event) => {
      this.events.push(event);
    });
  }

  async waitFor(
    predicate: (event: ProviderEvent) => boolean,
    what: string,
    timeoutMs: number,
  ): Promise<ProviderEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.events.find(predicate);
      if (hit) return hit;
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for ${what}; saw: ${this.events.map((e) => e.type).join(", ") || "nothing"}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  dispose(): void {
    this.unsubscribe();
  }
}

async function connectShim(registration: ProviderRegistration): Promise<ProviderConnection> {
  return registration.connect({
    versions: [1],
    capabilities: [...PROVIDER_CAPABILITIES],
  });
}

describe("paseo-plugin registration and manifest", () => {
  it("registers exactly one provider with the expected id and label", () => {
    const providers = registeredProviders();
    expect(providers).toHaveLength(1);
    const provider = providers[0]!;
    expect(provider.id).toBe("zcode");
    expect(provider.label).toBe("ZCode");
    expect(provider.description).toBeTruthy();
    expect(provider.icon).toBe("icon.svg");
    expect(typeof provider.connect).toBe("function");
  });

  it("ships a valid paseo-plugin.json manifest and an in-bounds icon", () => {
    const manifest = JSON.parse(readFileSync(path.join(pluginDir, "paseo-plugin.json"), "utf8"));
    expect(manifest.id).toBe("zcode-acp");
    expect(manifest.requirements?.paseo).toBe(">=0.8.0");
    const iconPath = path.join(pluginDir, "icon.svg");
    const icon = readFileSync(iconPath, "utf8");
    // Paseo enforces: regular SVG inside the plugin dir, ≤ 64 KiB.
    expect(icon.startsWith("<svg")).toBe(true);
    expect(statSync(iconPath).size).toBeLessThanOrEqual(64 * 1024);
  });
});

describeBuilt("paseo-plugin catalog (built bridge, hermetic)", () => {
  // The PATH shim resolves `zcode-acp-server` for the shim's spawn; the
  // poisoned ZCODE_BIN guarantees no backend can ever be reached.
  let shimDir: string;

  beforeAll(() => {
    writeSyntheticZcodeConfig();
    shimDir = makePoisonedShim();
    process.env.PATH = `${shimDir}:${originalPath}`;
  });

  afterAll(() => {
    process.env.PATH = originalPath;
    rmSync(shimDir, { recursive: true, force: true });
  });

  it("discovers the bridge's runtime catalog: models, thinking options, modes", async () => {
    const [provider] = registeredProviders();
    const connection = await connectShim(provider!);
    const log = new EventLog(connection);
    try {
      await connection.send({ type: "catalog", requestId: "catalog-1", cwd: repoRoot });
      const event = await log.waitFor(
        (e) => e.type === "catalog" || e.type === "request.failed",
        "catalog response",
        60_000,
      );
      expect(event.type).toBe("catalog");

      // Model ids use the bridge's advertised spellings: bare for the
      // first builtin holder, qualified for the colliding start-plan ids.
      // (The shim resolves `zcode-acp-server` from PATH for the spawn —
      // reaching this assertion at all is the functional proof that the
      // registration's command is exactly that binary name; the SDK's
      // ProviderRegistration type does not expose the command.)
      const qualifiedStartPlanGlm = "builtin:bigmodel-start-plan\\GLM-5.3";
      const models = event.catalog.models.map((m) => m.id);
      expect(models).toEqual([
        "GLM-5.3",
        "GLM-5.3-Flash",
        qualifiedStartPlanGlm,
        "builtin:bigmodel-start-plan\\GLM-5.3-Flash",
      ]);
      // Qualified entries carry the provider-prefixed display label.
      const qualified = event.catalog.models.find((m) => m.id === qualifiedStartPlanGlm);
      expect(qualified?.label).toContain("GLM-5.3");

      // Reasoning effort: the config declares variants ["low","max","high"],
      // but the bridge canonicalizes display order (orderThoughtVariants →
      // low, high, max) — assert the canonical order, not the file order.
      // defaultThinkingOption is the config's defaultVariant. This is
      // exactly what Paseo's composer effort selector and the daemon's
      // per-model thinkingOptions mapping consume.
      expect(event.catalog.thinkingOptions?.map((t) => t.id)).toEqual(["low", "high", "max"]);
      expect(event.catalog.defaultThinkingOption).toBe("max");

      expect(event.catalog.defaultModel).toBe("GLM-5.3");
      expect(event.catalog.modes.map((m) => m.id)).toEqual([
        "plan",
        "build",
        "edit",
        "guarded",
        "yolo",
      ]);
      expect(event.catalog.defaultMode).toBe("yolo");
    } finally {
      log.dispose();
      await connection.close();
    }
  }, 90_000);
});

describeLive("paseo-plugin live turn (real backend, real quota)", () => {
  let shimDir: string;

  beforeAll(() => {
    // Clean shim: no ZCODE_BIN poisoning — the backend must resolve for
    // real, under the REAL home passed via the session-open env.
    shimDir = makeShim();
    process.env.PATH = `${shimDir}:${originalPath}`;
  });

  afterAll(() => {
    process.env.PATH = originalPath;
    rmSync(shimDir, { recursive: true, force: true });
  });

  it("applies a thinking-option selection and reports turn usage", async () => {
    const [provider] = registeredProviders();
    const connection = await connectShim(provider!);
    const log = new EventLog(connection);
    try {
      await connection.send({
        type: "session.open",
        requestId: "open-1",
        sessionId: "spike-session",
        config: {
          cwd: repoRoot,
          env: { HOME: liveHome },
          mcpServers: {},
          settings: {},
          persist: false,
          thinkingOption: "low",
        },
        history: "skip",
      });
      await log.waitFor((e) => e.type === "session.ready", "session ready", 90_000);

      // The open-time effort must be applied through the bridge's
      // session/set_config_option (id `thought`) — the config echo carries
      // the BRIDGE's response configOptions, not shim-local state, so this
      // proves the RPC round-trip.
      await log.waitFor(
        (e) => e.type === "session.config" && e.config.thinkingOption === "low",
        "thinkingOption=low config event",
        60_000,
      );

      // Mid-conversation switch (spec story 7): the composer's exact
      // channel is session.configure, mapped by the shim to the same
      // thought_level config option.
      await connection.send({
        type: "session.configure",
        requestId: "configure-1",
        sessionId: "spike-session",
        changes: { thinkingOption: "high" },
      });
      await log.waitFor(
        (e) => e.type === "session.config" && e.config.thinkingOption === "high",
        "thinkingOption=high config event",
        60_000,
      );

      await connection.send({
        type: "session.prompt",
        sessionId: "spike-session",
        prompt: {
          clientMessageId: "live-1",
          delivery: "auto",
          input: {
            type: "message",
            content: [{ type: "text", text: "Reply with exactly the word: ok" }],
          },
        },
      });

      // The context-meter feed: usage_update mapped into session.usage.
      // The window comes from the real config's limit.context for the
      // session's model (machine-dependent — assert the invariant, not an
      // exact size): a sane configured window and occupancy within it.
      const usage = await log.waitFor(
        (e) =>
          e.type === "session.usage" &&
          (e.usage.contextWindowUsedTokens ?? 0) > 0 &&
          (e.usage.contextWindowMaxTokens ?? 0) > 0,
        "session.usage with real occupancy",
        240_000,
      );
      if (usage.type === "session.usage") {
        const max = usage.usage.contextWindowMaxTokens!;
        const used = usage.usage.contextWindowUsedTokens!;
        expect(max).toBeGreaterThanOrEqual(100_000);
        expect(used).toBeLessThanOrEqual(max);
      }

      const result = await log.waitFor(
        (e) => e.type === "session.prompt_result",
        "prompt result",
        240_000,
      );
      expect(result.type).toBe("session.prompt_result");
      expect(result.result.type).toBe("turn");
    } finally {
      log.dispose();
      await connection.close();
    }
  }, 420_000);
});
