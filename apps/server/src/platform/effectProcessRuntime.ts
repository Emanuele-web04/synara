// FILE: effectProcessRuntime.ts
// Purpose: Builds Effect child-process commands from the shared platform planner.
// Layer: Server platform runtime

import {
  lowerProcessPriority,
  prepareProcess,
  type ProcessLaunchInput,
} from "@synara/shared/platformProcess";
import { Effect } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { providerProcessPriorityEnabled } from "../providerProcessPriority";

/** Keep agent CPU scheduling in the same boundary as process launch planning. */
export function spawnProviderProcess(
  spawner: Pick<ChildProcessSpawner.ChildProcessSpawner["Service"], "spawn">,
  command: string,
  args: ReadonlyArray<string>,
  options: EffectProcessRuntimeOptions = {},
): ReturnType<ChildProcessSpawner.ChildProcessSpawner["Service"]["spawn"]> {
  return Effect.gen(function* () {
    const enabled = yield* providerProcessPriorityEnabled;
    const prepared = prepareEffectProcessCommand(command, args, {
      ...options,
      lowerPriority: enabled,
    });
    const child = yield* spawner.spawn(prepared.command);
    if (
      enabled &&
      ((options.platform ?? process.platform) === "win32" || !prepared.priorityBeforeExec)
    ) {
      lowerProcessPriority(child.pid, options);
    }
    return child;
  });
}

type ProcessPlanningOptions = Pick<ProcessLaunchInput, "platform" | "lowerPriority">;

// The pinned Effect revision predates these Node-only Windows options. The
// tracked platform-node-shared patch reads them from the command at runtime.
type EffectWindowsCommandOptions = ChildProcess.CommandOptions & {
  readonly windowsHide?: boolean;
  readonly windowsVerbatimArguments?: boolean;
};

export type EffectProcessRuntimeOptions = Omit<
  ChildProcess.CommandOptions,
  "shell" | "windowsVerbatimArguments"
> &
  ProcessPlanningOptions;

/**
 * Creates an Effect command without leaking `.cmd`, `cmd.exe`, WSL,
 * windowsHide, or windowsVerbatimArguments decisions into
 * provider/application code.
 *
 * Unlike the Node runtime there is deliberately no `requireExecutable`: the
 * Effect spawner is injectable. Unresolved POSIX executables bypass the priority
 * launcher so startup failures retain the spawner's ENOENT/EACCES in either
 * setting state. Neither path throws during command planning.
 */
export function makeEffectProcessCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: EffectProcessRuntimeOptions = {},
): ReturnType<typeof ChildProcess.make> {
  return prepareEffectProcessCommand(command, args, options).command;
}

function prepareEffectProcessCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: EffectProcessRuntimeOptions,
): { command: ReturnType<typeof ChildProcess.make>; priorityBeforeExec: boolean } {
  const { platform, lowerPriority, ...commandOptions } = options;
  const effectivePlatform = platform ?? process.platform;

  // Effect's ChildProcessSpawner is injectable. Keep executable existence and
  // POSIX PATH resolution behind that seam when no priority launcher is needed.
  // Priority-enabled POSIX agents must adjust scheduling before exec: Linux
  // nice is per-thread, so post-spawn adjustment can miss existing agent threads.
  // Windows still needs centralized launch planning for PATHEXT, batch shims,
  // PowerShell scripts, and WSL dispatch before the spawner receives the command.
  if (effectivePlatform !== "win32" && !lowerPriority) {
    return {
      command: ChildProcess.make(command, [...args], { ...commandOptions, shell: false }),
      priorityBeforeExec: false,
    };
  }

  const cwd = typeof commandOptions.cwd === "string" ? commandOptions.cwd : undefined;
  const env = commandOptions.env as NodeJS.ProcessEnv | undefined;
  const plan = prepareProcess(command, args, {
    platform: effectivePlatform,
    ...(lowerPriority ? { lowerPriority: true } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(env !== undefined ? { env } : {}),
  });

  const effectOptions: EffectWindowsCommandOptions = {
    ...commandOptions,
    shell: false,
    ...(plan.windowsHide ? { windowsHide: true } : {}),
    ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  };

  return {
    command: ChildProcess.make(plan.command, plan.args, effectOptions),
    priorityBeforeExec: plan.priorityBeforeExec === true,
  };
}
