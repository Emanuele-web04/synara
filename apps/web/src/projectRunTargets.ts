import type { ProjectDiscoveredScriptTarget, ProjectScript } from "@synara/contracts";

import { nextProjectScriptId, primaryProjectScript } from "./projectScripts";

const DEFAULT_RUN_SCRIPT_NAME = "dev";

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

// persists the run-dialog command as the project's primary script so the next launch defaults to it; a non-setup script is the canonical holder
export function upsertProjectRunCommandScripts(input: {
  scripts: ProjectScript[];
  command: string;
}): ProjectScript[] | null {
  const command = input.command.trim();
  if (command.length === 0) {
    return null;
  }
  const existing = primaryProjectScript(input.scripts);
  if (existing && !existing.runOnWorktreeCreate) {
    if (existing.command === command) {
      return null;
    }
    return input.scripts.map((script) =>
      script.id === existing.id ? { ...script, command } : script,
    );
  }
  const id = nextProjectScriptId(
    DEFAULT_RUN_SCRIPT_NAME,
    input.scripts.map((script) => script.id),
  );
  const runScript: ProjectScript = {
    id,
    name: DEFAULT_RUN_SCRIPT_NAME,
    command,
    icon: "play",
    runOnWorktreeCreate: false,
  };
  return [...input.scripts, runScript];
}
