// FILE: protocolProcessTeardown.ts
// Purpose: Preserves descendant identities across a protocol-driven process shutdown.
// Layer: Server platform runtime

import {
  captureProcessTree,
  inspectProcessTree,
  isProcessRunning,
  type CapturedProcessTree,
  type PlatformProcessTreeOptions,
} from "./processTreeController";
import {
  teardownChildProcessTree,
  teardownProviderProcessTree,
  type ProcessExitHandle,
} from "./supervisedProcessTeardown";
import { createWindowsTeardownProcessSnapshotObserver } from "./windowsProcessSnapshot";

const WINDOWS_COLD_CAPTURE_MS = 8_000;
const WINDOWS_INSPECTION_MS = 1_500;

/**
 * Capture before asking an adapter to disconnect: disconnect may terminate or
 * reparent its children. Retain that snapshot on failure, and memoize only proven
 * cleanup. A retry must never mistake an empty post-exit tree for exit evidence.
 * The caller must bound its protocol request; forced teardown still runs if it fails.
 */
export function createProtocolProcessTeardown(
  child: ProcessExitHandle,
  disconnect: () => Promise<void>,
  platform: NodeJS.Platform = process.platform,
): () => Promise<void> {
  let captured: CapturedProcessTree | undefined;
  let pending: Promise<void> | undefined;
  let disconnected = false;
  let complete = false;

  return () => {
    if (complete) return Promise.resolve();
    if (pending) return pending;
    pending = Promise.resolve()
      .then(async () => {
        // Cold PowerShell/CIM startup needs its own bounded budget. Keep the
        // observer warm for proof; do not change other runtime owners' deadlines.
        const observer =
          platform === "win32"
            ? createWindowsTeardownProcessSnapshotObserver({
                probeTimeoutMs: WINDOWS_COLD_CAPTURE_MS,
              })
            : undefined;
        const options = (timeoutMs: number): PlatformProcessTreeOptions => ({
          platform,
          ...(observer ? { captureWindowsChildren: () => observer.captureWithin(timeoutMs) } : {}),
        });
        const errors: unknown[] = [];
        try {
          if (child.pid !== undefined && !captured) {
            try {
              // Once the root has exited, its former children may have been
              // reparented. An empty snapshot then cannot establish ownership.
              if (child.exitCode !== null || child.signalCode !== null)
                throw new Error("Process exited before descendant identities were captured.");
              captured = await captureProcessTree(child.pid, options(WINDOWS_COLD_CAPTURE_MS));
            } catch (error) {
              captured = { descendants: [], captureComplete: false };
              errors.push(error);
            }
          } else if (observer && captured) {
            // Warm a retry's observer, but never replace the original identities.
            await observer.captureWithin(WINDOWS_COLD_CAPTURE_MS);
          }
          if (!disconnected) {
            disconnected = true;
            try {
              await disconnect();
            } catch (error) {
              errors.push(error);
            }
          }
          try {
            await teardownChildProcessTree(child, (input) =>
              teardownProviderProcessTree(input, {
                platform,
                captureProcessTree: async () =>
                  captured ?? { descendants: [], captureComplete: false },
                inspectProcessTree: (tree) =>
                  inspectProcessTree(tree, options(WINDOWS_INSPECTION_MS)),
                isRootRunning: (pid) => isProcessRunning(pid, options(WINDOWS_INSPECTION_MS)),
              }),
            );
          } catch (error) {
            if (errors.length > 0)
              throw new AggregateError([...errors, error], "Protocol process cleanup failed.", {
                cause: error,
              });
            throw error;
          }
          complete = true;
        } finally {
          observer?.dispose();
        }
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}
