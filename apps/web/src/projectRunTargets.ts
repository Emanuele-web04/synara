// FILE: projectRunTargets.ts
// Purpose: Choose the sidebar run command from saved scripts and discovered package scripts.
// Layer: Web project-run logic
// Exports: selectPrimaryProjectRunCommand and labels for sidebar run actions.

import type { ProjectDiscoveredScriptTarget, ProjectScript } from "@t3tools/contracts";

import { primaryProjectScript } from "./projectScripts";

export type ProjectRunCommandTarget =
  | {
      source: "saved";
      label: string;
      command: string;
      cwd: string;
      script: ProjectScript;
    }
  | {
      source: "discovered";
      label: string;
      command: string;
      cwd: string;
      packageRelativePath: string;
      scriptName: string;
    };

const DISCOVERED_PRIMARY_SCRIPT_ORDER = ["dev", "start"] as const;

function discoveredScriptLabel(input: {
  target: ProjectDiscoveredScriptTarget;
  scriptName: string;
}): string {
  const packageLabel = input.target.relativePath || input.target.packageName || "";
  return packageLabel ? `${packageLabel} ${input.scriptName}` : input.scriptName;
}

export function selectPrimaryProjectRunCommand(input: {
  project: { cwd: string; scripts: ProjectScript[] };
  discoveredTargets?: readonly ProjectDiscoveredScriptTarget[];
}): ProjectRunCommandTarget | null {
  const savedScript = primaryProjectScript(input.project.scripts);
  if (savedScript && !savedScript.runOnWorktreeCreate) {
    return {
      source: "saved",
      label: savedScript.name,
      command: savedScript.command,
      cwd: input.project.cwd,
      script: savedScript,
    };
  }

  for (const scriptName of DISCOVERED_PRIMARY_SCRIPT_ORDER) {
    for (const target of input.discoveredTargets ?? []) {
      const script = target.scripts.find((entry) => entry.name === scriptName);
      if (!script) {
        continue;
      }
      return {
        source: "discovered",
        label: discoveredScriptLabel({ target, scriptName }),
        command: script.command,
        cwd: target.cwd,
        packageRelativePath: target.relativePath,
        scriptName,
      };
    }
  }

  return null;
}
