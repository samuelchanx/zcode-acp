/**
 * Foreign config options in session/set_config_option must not fail the
 * caller's whole flow. Paseo's plugin path applies every agent's saved
 * featureValues as set_config_option on load — e.g. `auto_accept: true`, a
 * boolean for an option this bridge doesn't own — and the throw turned
 * EVERY resumed agent into "Internal error" / "Couldn't refresh agent
 * history" (observed 2026-09-30, daemon 0.9.2 + paseo-plugin). Foreign
 * options are acknowledged as a no-op (current options returned); the
 * bridge-owned options keep their strict validation.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import { setConfigOptionHandler } from "../src/handlers/session.js";
import { newSession } from "../src/handlers/session.js";
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
    request: async (_id: number, method: string) => {
      if (method === "session/read") {
        return { result: { projection: { status: "idle", contextUsed: 0 } } };
      }
      return { result: {} };
    },
    send: () => {},
    pollServerRequests: () => [],
    registerEventListener: () => {},
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend;
}

function recordingCx(): acp.AgentContext {
  return {
    connectionContext: undefined,
    notify: async () => {},
  } as unknown as acp.AgentContext;
}

async function newSessionId(): Promise<string> {
  const server = new ZcodeAcpServer();
  server.backend = fakeBackend();
  const cx = recordingCx();
  vi.spyOn(server.clients, "broadcast").mockReturnValue(cx);
  const resp = await newSession(server, { cwd: "/tmp/proj" } as acp.NewSessionRequest, cx);
  return resp.sessionId;
}

describe("set_config_option: foreign options no-op", () => {
  it("acknowledges an unknown option id with a boolean value (Paseo auto_accept shape)", async () => {
    const server = new ZcodeAcpServer();
    server.backend = fakeBackend();
    const sid = await newSessionId();
    const resp = await setConfigOptionHandler(
      server,
      {
        sessionId: sid,
        configId: "auto_accept",
        type: "boolean",
        value: true,
      } as unknown as acp.SetSessionConfigOptionRequest,
      recordingCx(),
    );
    expect(resp.configOptions.length).toBeGreaterThan(0);
  });

  it("acknowledges an unknown option id with a string value", async () => {
    const server = new ZcodeAcpServer();
    server.backend = fakeBackend();
    const sid = await newSessionId();
    const resp = await setConfigOptionHandler(
      server,
      {
        sessionId: sid,
        configId: "some_future_option",
        value: "x",
      } as unknown as acp.SetSessionConfigOptionRequest,
      recordingCx(),
    );
    expect(resp.configOptions.length).toBeGreaterThan(0);
  });

  it("still rejects a non-string value for a bridge-owned option", async () => {
    const server = new ZcodeAcpServer();
    server.backend = fakeBackend();
    const sid = await newSessionId();
    await expect(
      setConfigOptionHandler(
        server,
        {
          sessionId: sid,
          configId: "model",
          type: "boolean",
          value: true,
        } as unknown as acp.SetSessionConfigOptionRequest,
        recordingCx(),
      ),
    ).rejects.toThrow("unsupported config value type");
  });
});
