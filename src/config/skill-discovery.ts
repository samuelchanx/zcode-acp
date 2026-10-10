/**
 * Skill discovery — scans the same directories ZCode uses to discover Skills,
 * reads each SKILL.md frontmatter, and returns entries suitable for the ACP
 * `available_commands_update` notification.
 *
 * Each discovered skill becomes its own `/skill-name` slash command in the
 * editor's completion menu (matching Claude Code's behaviour). The model
 * resolves the invocation via its `Skill` tool — the bridge just lists them
 * and passes the text through.
 *
 * Discovery sources (in priority order — first occurrence wins on name clash):
 *   1. <zcode-home>/skills/&#42;/SKILL.md      (user scope, ZCode native)
 *   2. ~/.agents/skills/&#42;/SKILL.md          (user scope, shared agents)
 *   3. enabled plugin <cache>/skills/[&#42;/]&#42;/SKILL.md   (flat or category layout)
 *   4. <cwd>/.zcode/skills/&#42;/SKILL.md       (project scope, ZCode native)
 *   5. <cwd>/.agents/skills/&#42;/SKILL.md      (project scope)
 *
 * ZCode itself scans workspace `.zcode/skills` before `.agents/skills` at the
 * same scope (see the zcode-configuration-guide plugin); the bridge mirrors
 * that order.
 *
 * `<zcode-home>` is the ZCode data root (`~/.zcode`, or `$ZCODE_HOME` when
 * set — see `zcodeHomeDir()`). Skills explicitly disabled in
 * `<zcode-home>/cli/config.json` (skills map with `enable: false`, keyed by
 * absolute SKILL.md path) are excluded.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

import {
  compareVersions,
  log,
  zcodeCliConfigPath,
  zcodeHomeDir,
  zcodePluginCacheDir,
} from "../utils.js";

/** A slash-command entry compatible with `sendAvailableCommands`. */
export interface SkillEntry {
  name: string;
  description: string;
  input?: { hint: string };
}

interface CliConfig {
  skills?: Record<string, { enable?: boolean }>;
  plugins?: {
    enabledPlugins?: Record<string, boolean>;
  };
}

/** Max description length before truncation with ellipsis. */
const MAX_DESC_LEN = 80;

/**
 * Parse YAML-like frontmatter from a SKILL.md file.
 * Returns a map of key→string (values have surrounding quotes stripped).
 */
function parseFrontmatter(content: string): Record<string, string> {
  const fm: Record<string, string> = {};
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return fm;
  const lines = match[1]!.split(/\r?\n/);
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) fm[key] = val;
  }
  return fm;
}

/** Truncate a description to MAX_DESC_LEN, appending "…" if truncated. */
function truncateDesc(desc: string): string {
  if (desc.length <= MAX_DESC_LEN) return desc;
  return desc.slice(0, MAX_DESC_LEN - 1) + "…";
}

/** Read the disabled skill paths from config.json (set of absolute paths). */
function loadDisabledSkillPaths(config: CliConfig | null): Set<string> {
  const disabled = new Set<string>();
  if (!config?.skills) return disabled;
  for (const [skillPath, cfg] of Object.entries(config.skills)) {
    if (cfg?.enable === false) disabled.add(skillPath);
  }
  return disabled;
}

/** Mutable scan state shared by every scope scanner (first occurrence wins). */
interface SkillScan {
  /** absolute SKILL.md paths disabled in cli config.json. */
  disabledPaths: Set<string>;
  /** discovered entries, in scan order. */
  results: SkillEntry[];
  /** `$name` keys already advertised — dedup across scopes. */
  seen: Set<string>;
}

/**
 * Read one skill directory's SKILL.md into an entry. Null when the dir is not
 * a skill (no SKILL.md), is disabled, or fails the frontmatter checks — the
 * single validation path every scanner shares.
 */
function readSkillEntry(skillDir: string, disabledPaths: Set<string>): SkillEntry | null {
  const skillMd = path.join(skillDir, "SKILL.md");
  if (!existsSync(skillMd)) return null;
  // Resolve absolute path for disabled-check.
  if (disabledPaths.has(path.resolve(skillMd))) return null;
  let content: string;
  try {
    content = readFileSync(skillMd, "utf8");
  } catch {
    return null;
  }
  const fm = parseFrontmatter(content);
  const name = fm["name"] ?? path.basename(skillDir);
  const description = fm["description"] ?? "";
  if (!description) return null;
  // Skip explicitly non-user-invocable skills.
  if (fm["user-invocable"] === "false") return null;
  // Prefix with $ so the editor groups skills visually (e.g. "$tdd") and
  // handleSlashCommand can route by prefix.
  const skillEntry: SkillEntry = {
    name: `$${name}`,
    description: truncateDesc(description),
  };
  // Only request follow-up input when the skill author explicitly declares
  // an argument-hint — matching plugin-commands.ts behaviour. Skills without
  // argument-hint (e.g. $tdd, $setup-matt-pocock-skills) send immediately on
  // selection; skills with one (e.g. $handoff, $teach) wait for user input.
  const hint = fm["argument-hint"];
  if (hint) skillEntry.input = { hint };
  return skillEntry;
}

/** Add a discovered entry unless its `$name` was already advertised. */
function addSkill(scan: SkillScan, entry: SkillEntry | null): void {
  if (!entry || scan.seen.has(entry.name)) return;
  scan.seen.add(entry.name);
  scan.results.push(entry);
}

/** Subdirectories of dir, in readdir order (empty when dir is missing/unreadable). */
function listSubdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const sub = path.join(dir, entry);
    try {
      if (statSync(sub).isDirectory()) out.push(sub);
    } catch {
      // unreadable entry — skip
    }
  }
  return out;
}

/**
 * Scan a plugin's `skills/` directory. Plugins ship two layouts:
 *   flat      — `<plugin>/<ver>/skills/<name>/SKILL.md`
 *   category  — `<plugin>/<ver>/skills/<category>/<name>/SKILL.md`
 *              (e.g. mattpocock-skills `skills/engineering/implement/`)
 * A directory that carries its own SKILL.md is itself a skill and is never
 * descended into — helper dirs inside a skill (e.g. `implement/agents/`)
 * must not be advertised. Flat entries are collected first so they win name
 * clashes within the plugin.
 */
function scanPluginSkillsDir(skillsDir: string, scan: SkillScan): void {
  const subdirs = listSubdirs(skillsDir);
  for (const dir of subdirs) {
    if (existsSync(path.join(dir, "SKILL.md")))
      addSkill(scan, readSkillEntry(dir, scan.disabledPaths));
  }
  for (const dir of subdirs) {
    if (!existsSync(path.join(dir, "SKILL.md"))) scanSkillDir(dir, scan);
  }
}

/** Scan a directory for skill subdirectories containing SKILL.md. */
function scanSkillDir(dir: string, scan: SkillScan): void {
  for (const sub of listSubdirs(dir)) {
    addSkill(scan, readSkillEntry(sub, scan.disabledPaths));
  }
}

/**
 * Discover all enabled skills from the filesystem.
 *
 * Returns entries suitable for `available_commands_update`. Best-effort:
 * failures are logged and swallowed (returns whatever was found).
 */
export function loadSkillCommands(): SkillEntry[] {
  // Load config for disabled-skills list + enabled-plugins list.
  let config: CliConfig | null = null;
  try {
    const cliConfigPath = zcodeCliConfigPath();
    if (existsSync(cliConfigPath)) {
      config = JSON.parse(readFileSync(cliConfigPath, "utf8")) as CliConfig;
    }
  } catch (e) {
    log(`skill-discovery: config read failed (${e instanceof Error ? e.message : String(e)})`);
  }

  const scan: SkillScan = {
    disabledPaths: loadDisabledSkillPaths(config),
    results: [],
    seen: new Set<string>(),
  };

  // 1. User skills under the ZCode data root.
  scanSkillDir(path.join(zcodeHomeDir(), "skills"), scan);

  // 2. ~/.agents/skills/
  scanSkillDir(path.join(homedir(), ".agents", "skills"), scan);

  // 3. Enabled plugin skills.
  const enabledPlugins = config?.plugins?.enabledPlugins ?? {};
  for (const [pluginKey, enabledFlag] of Object.entries(enabledPlugins)) {
    if (!enabledFlag) continue;
    const atIdx = pluginKey.indexOf("@");
    if (atIdx <= 0) continue;
    const pluginName = pluginKey.slice(0, atIdx);
    const marketplace = pluginKey.slice(atIdx + 1);

    const pluginDir = path.join(zcodePluginCacheDir(), marketplace, pluginName);
    if (!existsSync(pluginDir)) continue;

    // Find the latest version directory.
    let latestVersion = "";
    try {
      for (const entry of readdirSync(pluginDir)) {
        const vDir = path.join(pluginDir, entry);
        if (statSync(vDir).isDirectory() && compareVersions(entry, latestVersion) > 0) {
          latestVersion = entry;
        }
      }
    } catch {
      continue;
    }
    if (!latestVersion) continue;

    scanPluginSkillsDir(path.join(pluginDir, latestVersion, "skills"), scan);
  }

  // 4. Project-level .zcode/skills/ (if exists) — ZCode-native project scope,
  //    scanned before .agents to mirror ZCode's own precedence.
  scanSkillDir(path.join(process.cwd(), ".zcode", "skills"), scan);

  // 5. Project-level .agents/skills/ (if exists).
  scanSkillDir(path.join(process.cwd(), ".agents", "skills"), scan);

  log(`skill-discovery: loaded ${scan.results.length} skill(s)`);
  return scan.results;
}
