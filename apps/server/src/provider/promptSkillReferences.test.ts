// FILE: promptSkillReferences.test.ts
// Purpose: Verifies typed skill tokens resolve against the shared skills catalog, with
//          each provider preferring its own copy of a name several providers share.
// Layer: Server provider tests

import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { ProviderKind, ProviderSkillDescriptor } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  extractPromptSkillTokenNames,
  leadingPromptSkillTokenName,
  leadingSlashTokenName,
  resolvePromptSkillReferences,
} from "./promptSkillReferences.ts";
import { clearSkillsCatalogCacheForTests, discoverSkillsCatalog } from "./skillsCatalog.ts";

function descriptor(name: string, skillPath: string, enabled = true): ProviderSkillDescriptor {
  return { name, path: skillPath, enabled };
}

describe("extractPromptSkillTokenNames", () => {
  it("reads /name and $name tokens anywhere, once each, without Synara commands or paths", () => {
    expect(extractPromptSkillTokenNames("/refactor-code: fix (see $docs)")).toEqual([
      "refactor-code",
      "docs",
    ]);
    expect(
      extractPromptSkillTokenNames(
        "Start with /plan, then /Refactor-Code and $check-code.\n/refactor-code again, " +
          "open /Users/me/notes and `/quoted` plus plugin /tools:lint",
      ),
    ).toEqual(["Refactor-Code", "check-code", "tools:lint"]);
  });
});

describe("leadingSlashTokenName", () => {
  it("reads only a command that starts the text", () => {
    expect(leadingSlashTokenName("  /refactor-code fix bugs")).toBe("refactor-code");
    expect(leadingSlashTokenName("/refactor-code")).toBe("refactor-code");
    expect(leadingSlashTokenName("Please /refactor-code")).toBeNull();
    expect(leadingSlashTokenName("/Users/me/file")).toBeNull();
  });

  it("reads a leading skill token even when punctuation follows it", () => {
    expect(leadingSlashTokenName("/refactor-code, fix")).toBeNull();
    expect(leadingPromptSkillTokenName("/refactor-code, fix")).toBe("refactor-code");
    expect(leadingPromptSkillTokenName("/plan this")).toBeNull();
    expect(leadingPromptSkillTokenName("$refactor-code fix")).toBeNull();
    expect(leadingPromptSkillTokenName("Please /refactor-code")).toBeNull();
  });
});

describe("resolvePromptSkillReferences", () => {
  const available = [
    descriptor("refactor-code", "/home/.claude/skills/refactor-code/SKILL.md"),
    descriptor("check-code", "/home/.codex/skills/check-code/SKILL.md"),
    descriptor("muted", "/home/.claude/skills/muted/SKILL.md", false),
  ];

  it("keeps menu picks first and adds typed skills by catalog name", () => {
    const picked = { name: "check-code", path: "/repo/.agents/skills/check-code/SKILL.md" };
    expect(
      resolvePromptSkillReferences({
        text: "Use $check-code, then /REFACTOR-CODE and /unknown and /muted",
        attached: [picked],
        available,
      }),
    ).toEqual([
      picked,
      { name: "refactor-code", path: "/home/.claude/skills/refactor-code/SKILL.md" },
    ]);
  });

  it("returns nothing new when no token matches", () => {
    expect(resolvePromptSkillReferences({ text: "plain words", available })).toEqual([]);
  });
});

describe("shared skills across providers", () => {
  let home: string;

  async function writeSkill(root: string, name: string): Promise<string> {
    const dir = path.join(home, root, "skills", name);
    await mkdir(dir, { recursive: true });
    const skillPath = path.join(dir, "SKILL.md");
    await writeFile(skillPath, `---\nname: ${name}\ndescription: ${name} skill\n---\n# ${name}\n`);
    return skillPath;
  }

  async function resolveFor(provider: ProviderKind, text: string) {
    const available = await discoverSkillsCatalog({
      homeDir: home,
      synaraBaseDir: path.join(home, ".synara"),
      provider,
      forceReload: true,
    });
    return resolvePromptSkillReferences({ text, available });
  }

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "prompt-skill-refs-"));
    clearSkillsCatalogCacheForTests();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    clearSkillsCatalogCacheForTests();
  });

  it("resolves each provider's own copy first and reaches the other providers' skills", async () => {
    const claudeShared = await writeSkill(".claude", "shared");
    const codexShared = await writeSkill(".codex", "shared");
    const claudeOnly = await writeSkill(".claude", "claude-only");
    const codexOnly = await writeSkill(".codex", "codex-only");
    const portable = await writeSkill(".synara", "portable");
    const text = "/shared then /claude-only, /codex-only and $portable";

    expect(await resolveFor("claudeAgent", text)).toEqual([
      { name: "shared", path: claudeShared },
      { name: "claude-only", path: claudeOnly },
      { name: "codex-only", path: codexOnly },
      { name: "portable", path: portable },
    ]);
    expect(await resolveFor("codex", text)).toEqual([
      { name: "shared", path: codexShared },
      { name: "claude-only", path: claudeOnly },
      { name: "codex-only", path: codexOnly },
      { name: "portable", path: portable },
    ]);
  });
});
