// FILE: cursorSkillsDiscovery.test.ts
// Purpose: Verifies Cursor filesystem skill discovery without starting Cursor ACP.
// Layer: Server provider tests
// Exports: Vitest cases for cursorSkillsDiscovery (frontmatter parsing is covered
// in skillsCatalog.test.ts where the parser now lives).

import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { discoverCursorSkills } from "./cursorSkillsDiscovery.ts";

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

      expect(skills.map((skill) => skill.name)).toEqual(["reviewer", "writer", "global-helper"]);
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

  it("keeps the provider scope when the cwd lives under the home dir", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "cursor-skills-home-"));
    const homeDir = path.join(root, "home");
    const cwd = path.join(homeDir, "projects", "app");
    const userSkill = path.join(homeDir, ".cursor", "skills", "global-helper");

    try {
      await mkdir(userSkill, { recursive: true });
      await mkdir(cwd, { recursive: true });
      await writeFile(
        path.join(userSkill, "SKILL.md"),
        `---
name: global-helper
description: Help globally
---

# Global Helper
`,
      );

      const skills = await discoverCursorSkills({ cwd, homeDir });

      expect(skills).toHaveLength(1);
      expect(skills[0]).toMatchObject({ name: "global-helper", scope: "cursor" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
