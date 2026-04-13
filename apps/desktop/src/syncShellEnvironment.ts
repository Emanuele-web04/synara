import {
  readEnvironmentFromLoginShell,
  resolveLoginShell,
  type ShellEnvironmentReader,
} from "@t3tools/shared/shell";

const DEFAULT_SHELL_ENV_NAMES = ["PATH", "SSH_AUTH_SOCK"] as const;

export function syncShellEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    platform?: NodeJS.Platform;
    readEnvironment?: ShellEnvironmentReader;
  } = {},
): void {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") return;

  try {
    const shell = resolveLoginShell(platform, env.SHELL);
    if (!shell) return;

    const shellEnvironment = (options.readEnvironment ?? readEnvironmentFromLoginShell)(
      shell,
      DEFAULT_SHELL_ENV_NAMES,
    );

    if (shellEnvironment.PATH) {
      env.PATH = shellEnvironment.PATH;
    }

    for (const [name, value] of Object.entries(shellEnvironment)) {
      if (name === "PATH") {
        continue;
      }

      if (env[name] === undefined || env[name] === "") {
        env[name] = value;
      }
    }
  } catch {
    // Keep inherited environment if shell lookup fails.
  }
}
