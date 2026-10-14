import { join } from "node:path";

import { CuaDriverHost } from "./cuaDriverHost";
import type { WindowsEscapeKillSwitchMonitor } from "./windowsEscapeKillSwitchMonitor";

/** Windows native input requires the pinned, patched driver and a live Escape monitor. */
export function createWindowsCuaDriverHost(options: {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly appRoot: string;
  readonly bundleId: string;
  readonly capability: string;
  readonly ownPids: () => ReadonlySet<number>;
  readonly inputMonitor?: Pick<WindowsEscapeKillSwitchMonitor, "state" | "activate" | "setArmed">;
}): CuaDriverHost {
  return new CuaDriverHost({
    binaryPath: options.isPackaged
      ? join(options.resourcesPath, "cua-driver", "cua-driver.exe")
      : join(options.appRoot, "apps/desktop/resources/cua-driver/cua-driver.exe"),
    bundleId: options.bundleId,
    capability: options.capability,
    ownPids: options.ownPids,
    inputMonitorState: () =>
      options.inputMonitor?.state ?? { ready: false, error: "windows_global_escape_unavailable" },
    activateInputMonitor: async () => {
      await options.inputMonitor?.activate();
    },
    onInputMonitorArmedChange: (armed) => options.inputMonitor?.setArmed(armed),
    setup: async () => {
      // Windows input uses the current user desktop and integrity level.
      // Setup does not request elevation or macOS permissions.
    },
  });
}
