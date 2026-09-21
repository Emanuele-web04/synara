import { prepareProcess, type ProcessLaunchInput } from "@synara/shared/platformProcess";
import { ChildProcess } from "effect/unstable/process";

type ProcessPlanningOptions = Pick<ProcessLaunchInput, "platform">;

// the pinned Effect revision predates these Node-only Windows options — the platform-node-shared patch reads them at runtime
type EffectWindowsCommandOptions = ChildProcess.CommandOptions & {
  readonly windowsHide?: boolean;
  readonly windowsVerbatimArguments?: boolean;
};

export type EffectProcessRuntimeOptions = Omit<
  ChildProcess.CommandOptions,
  "shell" | "windowsVerbatimArguments"
> &
  ProcessPlanningOptions;

/** no `requireExecutable` unlike the Node runtime — the injectable spawner surfaces a missing exe as its own ENOENT in the owning domain */
export function makeEffectProcessCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: EffectProcessRuntimeOptions = {},
): ReturnType<typeof ChildProcess.make> {
  const { platform, ...commandOptions } = options;
  const effectivePlatform = platform ?? process.platform;

  // keep executable existence and PATH resolution behind the spawner seam so test/runtime spawners get the logical command
  // Windows still needs centralized launch planning (PATHEXT, batch shims, PowerShell, WSL) before the spawner sees the command
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
