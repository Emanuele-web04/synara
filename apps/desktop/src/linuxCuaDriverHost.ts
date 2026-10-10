import { join } from "node:path";

import { CuaDriverHost } from "./cuaDriverHost";
import type { LinuxEscapeKillSwitchMonitor } from "./linuxEscapeKillSwitchMonitor";

/** Linux has no macOS helper; browser safety capabilities come from the live driver handshake. */
export function createLinuxCuaDriverHost(options: {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly appRoot: string;
  readonly bundleId: string;
  readonly capability: string;
  readonly ownPids: () => ReadonlySet<number>;
  readonly inputMonitor?: Pick<LinuxEscapeKillSwitchMonitor, "state" | "activate" | "setArmed">;
}): CuaDriverHost {
  return new CuaDriverHost({
    binaryPath: options.isPackaged
      ? join(options.resourcesPath, "cua-driver", "cua-driver")
      : join(options.appRoot, "apps/desktop/resources/cua-driver/cua-driver"),
    bundleId: options.bundleId,
    capability: options.capability,
    ownPids: options.ownPids,
    nativeRevision: null,
    inputMonitorState: () =>
      options.inputMonitor?.state ?? { ready: false, error: "linux_global_escape_unavailable" },
    activateInputMonitor: async () => {
      await options.inputMonitor?.activate();
    },
    onInputMonitorArmedChange: (armed) => options.inputMonitor?.setArmed(armed),
    setup: async () => {
      throw new Error(
        "Start Synara inside your Linux desktop session with its display and accessibility " +
          "bus available. Screen capture and input depend on the X11 or Wayland compositor; " +
          "the macOS permission guide does not apply. If the driver is missing, reinstall " +
          "the Linux package or run apps/desktop/scripts/provision-cua-driver.mjs --platform linux.",
      );
    },
  });
}
