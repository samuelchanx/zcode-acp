import type { PluginClientContext } from "@getpaseo/plugin/client";

/**
 * Intentionally empty since 2026-10-14: the Quota screen + sidebar footer row
 * were removed (Samuel reads GLM quota on the native Usage screen, which the
 * daemon-side usage source in server/usage.ts already feeds). client/quota.tsx
 * stays for a possible comeback; nothing imports it, so it never bundles.
 */
export default function contribute(_client: PluginClientContext) {
  return () => {};
}
