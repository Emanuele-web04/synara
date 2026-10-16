import { lstat, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { resolveExecutable } from "@synara/shared/executable";
import { spawnProcess } from "@synara/shared/processRuntime";

export interface ExtensionSandboxInput {
  workspace: string;
  storage: string;
  packages: string;
  runtime: string;
  stateDir: string;
  node: string;
}
export function pathWithin(root: string, filename: string): boolean {
  const relative = path.relative(root, filename);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

/** The child receives no inherited Synara, provider, GitHub or cloud secrets. */
export function extensionSandboxEnvironment(storage: string, node: string): NodeJS.ProcessEnv {
  return {
    PATH: `${path.dirname(node)}${path.delimiter}/usr/local/bin${path.delimiter}/usr/bin${path.delimiter}/bin`,
    HOME: path.join(storage, "home"),
    TMPDIR: "/tmp",
    TMP: "/tmp",
    TEMP: "/tmp",
    XDG_CONFIG_HOME: path.join(storage, "home/.config"),
    XDG_CACHE_HOME: path.join(storage, "home/.cache"),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NO_COLOR: "1",
  };
}

export function extensionSandboxArguments(
  input: ExtensionSandboxInput,
  systemRoots: readonly string[],
): string[] {
  const reads = [
    ...new Set([
      ...systemRoots,
      path.dirname(input.node),
      path.dirname(input.runtime),
      input.packages,
      input.workspace,
    ]),
  ];
  return [
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    ...reads.flatMap((root) => ["--ro-bind", root, root]),
    "--bind",
    input.storage,
    input.storage,
    "--chdir",
    input.workspace,
    "--",
    input.node,
    "--max-old-space-size=512",
    input.runtime,
  ];
}

export async function spawnSandboxedExtensionHost(
  input: ExtensionSandboxInput,
): Promise<ChildProcess> {
  if (process.platform !== "linux")
    throw new Error(
      "Code-OSS extension execution requires a supported OS sandbox. macOS and Windows execution are not enabled yet.",
    );
  const resolved = Object.fromEntries(
    await Promise.all(
      Object.entries(input).map(async ([key, filename]) => {
        if (!path.isAbsolute(filename) || filename.includes("\0"))
          throw new Error("Extension sandbox paths must be absolute.");
        return [key, await realpath(filename)];
      }),
    ),
  ) as unknown as ExtensionSandboxInput;
  const home = await realpath(os.homedir());
  if (
    resolved.workspace === path.parse(resolved.workspace).root ||
    resolved.workspace === home ||
    pathWithin(resolved.workspace, resolved.stateDir)
  ) {
    throw new Error(
      "Extension workspaces must not expose the filesystem root, home root or Synara control-plane state.",
    );
  }
  if (
    !pathWithin(resolved.stateDir, resolved.storage) ||
    resolved.storage === resolved.stateDir ||
    !pathWithin(resolved.stateDir, resolved.packages) ||
    pathWithin(resolved.workspace, resolved.storage) ||
    pathWithin(resolved.packages, resolved.storage) ||
    pathWithin(resolved.storage, resolved.workspace)
  ) {
    throw new Error("Extension sandbox storage overlaps a protected boundary.");
  }
  for (const directory of [
    resolved.workspace,
    resolved.storage,
    resolved.packages,
    path.dirname(resolved.runtime),
  ]) {
    if (!(await lstat(directory)).isDirectory())
      throw new Error("Extension sandbox directory is unavailable.");
  }
  const env = extensionSandboxEnvironment(resolved.storage, resolved.node);
  const executable = resolveExecutable("bwrap", { cwd: resolved.workspace, env });
  if (!executable)
    throw new Error(
      "Install bubblewrap to enable protected Code-OSS extensions. Unsandboxed execution is not permitted.",
    );
  const systemRoots: string[] = [];
  for (const directory of [
    "/usr",
    "/bin",
    "/lib",
    "/lib64",
    "/etc/os-release",
    "/etc/lsb-release",
  ]) {
    if (
      await lstat(directory).then(
        () => true,
        () => false,
      )
    )
      systemRoots.push(directory);
  }
  return spawnProcess(executable, extensionSandboxArguments(resolved, systemRoots), {
    cwd: resolved.workspace,
    env,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    ownProcessGroup: true,
    requireExecutable: true,
  });
}
