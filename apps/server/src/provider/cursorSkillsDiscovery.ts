// FILE: cursorSkillsDiscovery.ts
// Purpose: Finds Cursor-compatible Agent Skill folders from project and user skill roots,
//          mirroring the roots cursor-agent scans natively.
// Layer: Server provider discovery helper
// Exports: discoverCursorSkills (generic primitives live in skillsCatalog.ts).

import * as nodePath from "node:path";

import type { ProviderSkillDescriptor } from "@t3tools/contracts";

import { ancestorsFromDeepest, collectSkillsFromRoots, type SkillRoot } from "./skillsCatalog.ts";

export interface CursorSkillDiscoveryInput {
  readonly cwd: string;
  readonly homeDir: string;
}

function cursorSkillRoots(input: CursorSkillDiscoveryInput): SkillRoot[] {
  const homeRoots: SkillRoot[] = [
    { path: nodePath.join(input.homeDir, ".cursor", "skills-cursor"), scope: "cursor" },
    { path: nodePath.join(input.homeDir, ".cursor", "skills"), scope: "personal" },
    { path: nodePath.join(input.homeDir, ".agents", "skills"), scope: "personal" },
    { path: nodePath.join(input.homeDir, ".claude", "skills"), scope: "personal" },
    { path: nodePath.join(input.homeDir, ".codex", "skills"), scope: "personal" },
  ];
  const homeRootPaths = new Set(homeRoots.map((root) => nodePath.resolve(root.path)));

  const projectRootNames = [".cursor", ".agents", ".claude", ".codex"] as const;
  // A cwd under the home dir reaches the home skill folders as "project
  // ancestors"; skip them so each folder is scanned once with its true scope.
  const projectRoots = ancestorsFromDeepest(input.cwd).flatMap((ancestor) =>
    projectRootNames
      .map((rootName) => nodePath.join(ancestor, rootName, "skills"))
      .filter((rootPath) => !homeRootPaths.has(nodePath.resolve(rootPath)))
      .map((rootPath) => ({ path: rootPath, scope: "project" })),
  );

  return [...projectRoots, ...homeRoots];
}

export async function discoverCursorSkills(
  input: CursorSkillDiscoveryInput,
): Promise<ProviderSkillDescriptor[]> {
  return collectSkillsFromRoots(cursorSkillRoots(input));
}
