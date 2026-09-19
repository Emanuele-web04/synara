/**
 * Building the KWin plugin from source, through the installer script.
 *
 * The build lives in `scripts/install-and-load.sh` so there is exactly one of
 * it; `--build-only` is that script with its install, load, and stamp steps
 * removed, and it prints the built `.so` path as its last stdout line. This
 * module owns the process side: a cancellable run whose whole tree - bash,
 * cmake, ninja, the compilers - is gone before the promise settles.
 */
import { ComputerBackendError } from "../ComputerBackend.ts";
import { CommandFailedError, CommandTimeoutError, runCancellable } from "./runCancellable.ts";

/** A cold cmake configure plus a full compile on a slow laptop, with margin. */
export const PLUGIN_BUILD_TIMEOUT_MS = 10 * 60 * 1_000;

export interface BuildPluginFromSourceOptions {
  readonly scriptPath: string;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * Resolves the path of the built plugin. Rejects with the abort reason when
 * cancelled, and otherwise with a `ComputerBackendError` whose message carries
 * what the toolchain said, which is the only actionable part of a failed
 * build.
 */
export async function buildPluginFromSource(
  options: BuildPluginFromSourceOptions,
): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await runCancellable("bash", [options.scriptPath, "--build-only"], {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? PLUGIN_BUILD_TIMEOUT_MS,
    }));
  } catch (error) {
    if (error instanceof CommandFailedError) {
      throw new ComputerBackendError(
        `Building the computer-use plugin failed${error.stderrTail ? `: ${error.stderrTail}` : "."}`,
        { cause: error },
      );
    }
    if (error instanceof CommandTimeoutError) {
      throw new ComputerBackendError(
        `Building the computer-use plugin took longer than ${Math.round(error.timeoutMs / 60_000)} minutes and was stopped.`,
        { retryable: true, cause: error },
      );
    }
    throw error;
  }
  const path = stdout.trimEnd().split("\n").at(-1)?.trim();
  if (!path) {
    throw new ComputerBackendError(`${options.scriptPath} --build-only printed no path.`);
  }
  return path;
}
