/**
 * Response-first replay for Paseo's plugin shim (loadSession + `_meta.paseo`).
 *
 * The shim binds its native session id only AFTER the load promise resolves,
 * so replay notifications emitted during the handler fail its sessionId guard
 * and are silently dropped — every resumed agent showed an empty history
 * (observed 2026-09-30 via Paseo's fetch_agent_timeline). For `_meta.paseo`
 * loads the bridge defers the notification tail (history replay + todos +
 * usage) past the response; other clients keep the synchronous order.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import { loadSession } from "../src/handlers/session.js";
import { ZcodeAcpServer } from "../src/server.js";

vi.mock("../src/tasks-index.js", () => ({
  upsertSessionTask: async () => true,
  updateSessionTitle: async () => true,
}));
vi.mock("../src/quota/index.js", () => ({ queryQuota: async () => ({ kind: "unavailable" }) }));
vi.mock("../src/remote/config.js", () => ({ parseRemoteConfig: () => null }));

function fakeBackend(): ZcodeBackend {
  return {
    isDead: false,
    // contextUsed > 0 so the deferred tail's emitInitialUsage emits a visible
    // usage_update (used 0 is skipped by design).
    request: async (_id: number, method: string) => {
      if (method === "session/read") {
        return { result: { projection: { status: "idle", contextUsed: 5000 } } };
      }
      return { result: {} };
    },
    send: () => {},
    pollServerRequests: () => [],
    registerEventListener: () => {},
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend;
}

function recordingCx(): { cx: acp.AgentContext; updates: Array<Record<string, unknown>> } {
  const updates: Array<Record<string, unknown>> = [];
  const cx = {
    connectionContext: undefined,
    notify: async (
      _method: string,
      params: { sessionId: string; update: Record<string, unknown> },
    ) => {
      updates.push(params.update);
    },
  } as unknown as acp.AgentContext;
  return { cx, updates };
}

const ACP_SID = "72386886-d429-4281-bd0b-bd1b805372e9";

async function loadedServer(): Promise<ZcodeAcpServer> {
  const server = new ZcodeAcpServer();
  server.backend = fakeBackend();
  server.registerSession(ACP_SID, "zsess_load");
  return server;
}

describe("session/load response-first replay (_meta.paseo)", () => {
  it("defers the notification tail past the response for paseo-shaped loads", async () => {
    const server = await loadedServer();
    const { cx, updates } = recordingCx();

    const response = await loadSession(
      server,
      {
        sessionId: ACP_SID,
        cwd: "/tmp/proj",
        mcpServers: [],
        _meta: { _paseo: { persist: true } },
      } as unknown as acp.LoadSessionRequest,
      cx,
    );

    // The response resolves with replayMeta BEFORE any notification — the
    // shim can only bind its session id after this point.
    expect(response.replayMeta).toBeTruthy();
    expect(updates).toHaveLength(0);

    // The deferred tail then delivers history/todos/usage notifications.
    await vi.waitFor(
      () => {
        expect(updates.length).toBeGreaterThan(0);
      },
      { timeout: 2_000, interval: 25 },
    );
  });

  it("keeps the synchronous tail for clients without _meta.paseo (Zed path unchanged)", async () => {
    const server = await loadedServer();
    const { cx, updates } = recordingCx();

    await loadSession(
      server,
      { sessionId: ACP_SID, cwd: "/tmp/proj", mcpServers: [] } as unknown as acp.LoadSessionRequest,
      cx,
    );

    // Notifications already flushed during the handler — no deferral.
    expect(updates.length).toBeGreaterThan(0);
  });
});
