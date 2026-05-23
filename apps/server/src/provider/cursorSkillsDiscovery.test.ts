// FILE: cursorSkillsDiscovery.test.ts
// Purpose: Verifies Cursor filesystem skill discovery without starting Cursor ACP.
// Layer: Server provider tests
// Exports: Vitest cases for cursorSkillsDiscovery.

import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { discoverCursorSkills, parseSkillFrontmatter } from "./cursorSkillsDiscovery.ts";

describe("parseSkillFrontmatter", () => {
  it("parses scalar Agent Skill metadata", () => {
    expect(
      parseSkillFrontmatter(`---
name: check-code
description: "Review recent code changes"
disable-model-invocation: true
---

# Check Code
`),
    ).toEqual({
      name: "check-code",
      description: "Review recent code changes",
      "disable-model-invocation": true,
    });
  });
});

describe("discoverCursorSkills", () => {
  it("discovers project, nested, and user Cursor skill folders", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "cursor-skills-"));
    const homeDir = path.join(root, "home");
    const cwd = path.join(root, "repo", "packages", "web");
    const projectSkill = path.join(root, "repo", ".cursor", "skills", "reviewer");
    const nestedSkill = path.join(root, "repo", ".cursor", "skills", "skills-sh", "writer");
    const userSkill = path.join(homeDir, ".cursor", "skills", "global-helper");

    try {
      await mkdir(projectSkill, { recursive: true });
      await mkdir(nestedSkill, { recursive: true });
      await mkdir(userSkill, { recursive: true });
      await mkdir(cwd, { recursive: true });

      await writeFile(
        path.join(projectSkill, "SKILL.md"),
        `---
name: reviewer
description: Review code
---

# Reviewer
`,
      );
      await writeFile(
        path.join(nestedSkill, "SKILL.md"),
        `---
name: writer
description: Write docs
---

# Writer
`,
      );
      await writeFile(
        path.join(userSkill, "SKILL.md"),
        `---
description: Help globally
---

# Global Helper
`,
      );

      const skills = await discoverCursorSkills({ cwd, homeDir });

      expect(skills.map((skill) => skill.name)).toEqual([
        "reviewer",
        "writer",
        "global-helper",
      ]);
      expect(skills[0]).toMatchObject({
        name: "reviewer",
        description: "Review code",
        enabled: true,
        scope: "project",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
