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
    const child = yield* spawner.spawn(
      makeEffectProcessCommand(command, args, { ...options, lowerPriority: enabled }),
    );
    if (enabled) lowerProcessPriority(child.pid);
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
 * Effect spawner is injectable, so a missing executable surfaces as the
 * spawner's own ENOENT error in the owning domain rather than a pre-spawn throw.
 */
export function makeEffectProcessCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: EffectProcessRuntimeOptions = {},
): ReturnType<typeof ChildProcess.make> {
  const { platform, lowerPriority, ...commandOptions } = options;
  const effectivePlatform = platform ?? process.platform;

  // Effect's ChildProcessSpawner is injectable. Keep executable existence and
  // POSIX PATH resolution behind that seam so test/runtime spawners receive the
  // logical command and can translate spawn failures in their owning domain.
  // Windows still needs centralized launch planning for PATHEXT, batch shims,
  // PowerShell scripts, and WSL dispatch before the spawner receives the command.
  if (effectivePlatform !== "win32") {
    return ChildProcess.make(command, [...args], {
      ...commandOptions,
      shell: false,
    });
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

  return ChildProcess.make(plan.command, plan.args, effectOptions);
}
