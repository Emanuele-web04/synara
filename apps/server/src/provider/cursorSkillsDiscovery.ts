import * as nodePath from "node:path";

import type { ProviderSkillDescriptor } from "@synara/contracts";

import { collectSkillsFromRoots, providerNativeSkillRoots } from "./skillsCatalog.ts";

export interface CursorSkillDiscoveryInput {
  readonly cwd: string;
  readonly homeDir: string;
}

export async function discoverCursorSkills(
  input: CursorSkillDiscoveryInput,
): Promise<ProviderSkillDescriptor[]> {
  return collectSkillsFromRoots(
    providerNativeSkillRoots({
      cwd: input.cwd,
      homeDir: input.homeDir,
      synaraBaseDir: nodePath.join(input.homeDir, ".synara"),
      provider: "cursor",
    }),
  );
}
