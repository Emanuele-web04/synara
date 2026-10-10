import { join } from "node:path";

import { CuaDriverHost } from "./cuaDriverHost";
import type { WindowsEscapeKillSwitchMonitor } from "./windowsEscapeKillSwitchMonitor";

/**
 * Windows uses the upstream cua-driver.exe artifact.
 *
 * Unlike Linux, Windows should not be forced through the Linux admission
 * refusals by default. The upstream Windows driver is the intended native
 * route for this platform.
 */
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
    nativeRevision: null,
    inputMonitorState: () =>
      options.inputMonitor?.state ?? { ready: false, error: "windows_global_escape_unavailable" },
    activateInputMonitor: async () => {
      await options.inputMonitor?.activate();
    },
    onInputMonitorArmedChange: (armed) => options.inputMonitor?.setArmed(armed),
    setup: async () => {
      // The upstream Windows driver handles its own elevation/permission needs
      // for global input injection. Do not reuse the macOS permission guide.
    },
  });
}
