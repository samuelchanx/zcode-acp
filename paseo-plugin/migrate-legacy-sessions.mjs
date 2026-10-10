#!/usr/bin/env node
/**
 * One-time migration: rewrite agent persistence handles written under the
 * config-defined "zcode" ACP provider into the plugin provider's format.
 *
 * The config-defined path persisted the raw ACP session id:
 *   persistence.sessionId = "bbb61aa6-…"
 * The plugin path (Paseo's PluginAgentClient.decodePersistence) requires the
 * plugin envelope, otherwise every resume / timeline fetch of a thread created
 * before the plugin install dies with "Invalid plugin provider persistence
 * handle":
 *   persistence.sessionId = 'plugin:{"version":1,"data":{"sessionId":"…"}}'
 *   persistence.metadata.pluginProviderPersistence = {version:1, data:{…}}
 *
 * The ACP session id itself is unchanged, so the bridge's session/load replay
 * (the plugin resume path) finds the same backend session. Everything else on
 * the record (cwd, model, mode, mcpServers, nativeHandle) is preserved.
 *
 * Usage: node migrate-legacy-sessions.mjs [--dry-run] [--paseo-home <dir>]
 * Every rewritten file is copied to ~/.paseo/agents-backup-pre-plugin-migration/
 * (mirrored subpaths) before the atomic (temp+rename) rewrite.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const paseoHomeIdx = args.indexOf("--paseo-home");
const paseoHome = paseoHomeIdx >= 0 ? args[paseoHomeIdx + 1] : join(homedir(), ".paseo");

const agentsDir = join(paseoHome, "agents");
const backupDir = join(paseoHome, "agents-backup-pre-plugin-migration");

if (!existsSync(agentsDir)) {
  console.error(`No agents directory at ${agentsDir}`);
  process.exit(1);
}

let scanned = 0;
let migrated = 0;
let skipped = 0;
const failures = [];

function atomicWriteJson(file, record) {
  const tmp = `${file}.migrate-tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmp, file);
}

for (const slug of readdirSync(agentsDir)) {
  const slugDir = join(agentsDir, slug);
  if (!statSync(slugDir).isDirectory()) continue;
  for (const name of readdirSync(slugDir)) {
    if (!name.endsWith(".json")) continue;
    const file = join(slugDir, name);
    scanned++;
    let record;
    try {
      record = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      failures.push(`${file}: unparseable JSON, left untouched`);
      continue;
    }
    if (record.provider !== "zcode") continue;
    const persistence = record.persistence;
    if (!persistence || typeof persistence !== "object") {
      skipped++;
      continue;
    }
    const sid = persistence.sessionId;
    if (typeof sid !== "string" || sid.length === 0) {
      skipped++;
      continue;
    }
    if (sid.startsWith("plugin:")) {
      skipped++;
      continue;
    }

    const pp = { version: 1, data: { sessionId: sid } };
    persistence.sessionId = `plugin:${JSON.stringify(pp)}`;
    persistence.metadata = { ...persistence.metadata, pluginProviderPersistence: pp };
    if (record.runtimeInfo?.sessionId === sid) {
      record.runtimeInfo.sessionId = persistence.sessionId;
    }

    if (dryRun) {
      console.log(`[dry-run] ${file}: ${sid} -> ${persistence.sessionId}`);
      migrated++;
      continue;
    }
    try {
      const backupFile = join(backupDir, slug, name);
      mkdirSync(join(backupDir, slug), { recursive: true });
      cpSync(file, backupFile);
      atomicWriteJson(file, record);
      migrated++;
    } catch (error) {
      failures.push(`${file}: ${error.message}`);
    }
  }
}

console.log(
  `scanned=${scanned} migrated=${migrated} skipped(already-plugin/no-persistence)=${skipped} failures=${failures.length}`,
);
for (const failure of failures) console.error(`FAIL ${failure}`);
process.exit(failures.length > 0 ? 1 : 0);
