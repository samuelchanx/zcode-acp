/**
 * neutralizeSlashText tests — the `/`-leading prompt wire-text path.
 *
 * Rule under test: IDENTITY on 0.16.9. The open-sourced runtime resolves only
 * /compact, /fork, /rewind natively (turn.ts:105-106,240-267) and passes every
 * other `/name` through as a normal prompt (custom-command-prompt.ts:31-44) —
 * there is no unknown-command hard-fail to defend against, so the old
 * zero-width-space injection only corrupted session history and model input.
 * These tests are the regression guard: any reintroduced rewriting fails here.
 *
 * Also covers the known-command cache contract behind 68ac220: the cache is
 * dropped on every advertised-list rebuild, so a skill installed after the
 * bridge process started is recognised at the next session open.
 */

import { homedir } from "node:os";

import { describe, expect, it, vi } from "vitest";

// --- mock fs (same pattern as skill-discovery.test.ts) ---

const mockFiles = new Map<string, string>();
const mockDirs = new Set<string>();

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: (p: string) => mockDirs.has(p) || mockFiles.has(p),
    readFileSync: ((p: string, ...args: unknown[]) => {
      if (mockFiles.has(p)) return mockFiles.get(p)!;
      return actual.readFileSync(p, ...(args as [unknown]));
    }) as typeof actual.readFileSync,
    readdirSync: (p: string) => {
      const entries: string[] = [];
      const prefix = p + "/";
      for (const key of mockDirs) {
        if (key.startsWith(prefix) && !key.slice(prefix.length).includes("/")) {
          entries.push(key.slice(prefix.length));
        }
      }
      return entries;
    },
    statSync: (p: string) => {
      if (mockDirs.has(p)) return { isDirectory: () => true } as ReturnType<typeof actual.statSync>;
      return actual.statSync(p);
    },
  };
});

import {
  knownCommandSetForTest,
  neutralizeSlashText,
  resetKnownCommandCache,
} from "../src/handlers/slash.js";

const HOME = homedir();

/** Helper: set up a SKILL.md file with frontmatter. */
function setSkill(dir: string, name: string, description: string): void {
  mockDirs.add(dir);
  mockDirs.add(`${dir}/${name}`);
  mockFiles.set(
    `${dir}/${name}/SKILL.md`,
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

describe("neutralizeSlashText", () => {
  it("passes non-slash prompts through unchanged", () => {
    expect(neutralizeSlashText("hello world")).toBe("hello world");
    expect(neutralizeSlashText("look at Users/foo")).toBe("look at Users/foo");
  });

  it("passes known commands through unchanged", () => {
    expect(neutralizeSlashText("/compact now")).toBe("/compact now");
    expect(neutralizeSlashText("/model GLM-5.3")).toBe("/model GLM-5.3");
    expect(neutralizeSlashText("/$tdd fix the bug")).toBe("/$tdd fix the bug");
  });

  it("passes unknown commands and pasted paths through VERBATIM (no ZWSP)", () => {
    // The backend itself passes unresolvable /x to the model as a normal
    // prompt (custom-command-prompt.ts:31-44) — the wire text must stay clean.
    expect(neutralizeSlashText("/notacommand")).toBe("/notacommand");
    expect(neutralizeSlashText("/Users/william/Downloads/mitm/fashion")).toBe(
      "/Users/william/Downloads/mitm/fashion",
    );
    expect(neutralizeSlashText("/tmp")).toBe("/tmp");
    // Leading whitespace survives too — the backend trims it itself.
    expect(neutralizeSlashText("  /Users/william/project")).toBe("  /Users/william/project");
  });

  it("never injects a zero-width space", () => {
    for (const text of ["/x", "  /y z", "/compact", "plain"]) {
      expect(neutralizeSlashText(text)).not.toContain("\u200B");
    }
  });
});

describe("known-command cache reset (68ac220)", () => {
  it("resetKnownCommandCache() picks up a skill installed after the set was built", () => {
    mockFiles.clear();
    mockDirs.clear();
    resetKnownCommandCache();
    setSkill(`${HOME}/.zcode/skills`, "alpha", "Alpha skill.");

    expect(knownCommandSetForTest().has("$alpha")).toBe(true);
    expect(knownCommandSetForTest().has("alpha")).toBe(true); // bare spelling too
    expect(knownCommandSetForTest().has("$beta")).toBe(false);

    // Install another skill — the CACHED set must not see it until the
    // advertised list is rebuilt (buildAllCommands drops the cache).
    setSkill(`${HOME}/.zcode/skills`, "beta", "Beta skill.");
    expect(knownCommandSetForTest().has("$beta")).toBe(false);

    resetKnownCommandCache();
    expect(knownCommandSetForTest().has("$beta")).toBe(true);
    expect(knownCommandSetForTest().has("beta")).toBe(true);
  });
});
