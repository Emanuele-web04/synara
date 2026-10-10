/** one DeviceManager per server; exists on every platform so no caller branches on null — off darwin the backend reports `unsupported-platform` and calls fail through the same path a missing Xcode takes */
import { Effect, Layer } from "effect";
import { homedir } from "node:os";
import * as path from "node:path";

import { makeBootOwnershipStore, NULL_BOOT_OWNERSHIP } from "../bootOwnership.ts";
import { DeviceManager } from "../DeviceManager.ts";
import { IosSimulatorBackend } from "../IosSimulatorBackend.ts";
import { DeviceService, type DeviceServiceShape } from "../Services/DeviceService.ts";

export interface DeviceServiceLiveOptions {
  readonly platform?: NodeJS.Platform;
  /** where to remember this run's boots; omit to remember nothing */
  readonly bootOwnershipPath?: string;
}

/** resolved here rather than ServerConfig — this layer is built before that config is in scope, and a wrong path only costs crash-recovery */
function defaultBootOwnershipPath(): string {
  const baseDir = process.env.SYNARA_HOME?.trim() || path.join(homedir(), ".synara");
  const stateDir = path.join(baseDir, process.env.VITE_DEV_SERVER_URL ? "dev" : "userdata");
  return path.join(stateDir, "device-boot-ownership.json");
}

export function makeDeviceServiceLayer(options: DeviceServiceLiveOptions = {}) {
  return Layer.effect(
    DeviceService,
    Effect.gen(function* () {
      const platform = options.platform ?? process.platform;
      const backend = new IosSimulatorBackend({ platform });
      // only darwin can boot anything, so only darwin needs to remember doing so
      const bootOwnership =
        platform === "darwin"
          ? makeBootOwnershipStore(options.bootOwnershipPath ?? defaultBootOwnershipPath())
          : NULL_BOOT_OWNERSHIP;
      const manager = new DeviceManager({ backend, bootOwnership });

      // a crashed run left simulators booted and unowned — reclaim before this run counts boots or they linger outside the cap and sweep
      if (platform === "darwin") {
        yield* Effect.promise(async () => {
          const reclaimed = await manager.reclaimOrphanedBoots().catch(() => []);
          if (reclaimed.length > 0) {
            console.info(
              `[device] shut down ${reclaimed.length} simulator(s) left booted by a previous ` +
                `Synara run: ${reclaimed.join(", ")}`,
            );
          }
        });
      }

      // quit shuts down every simulator Synara booted; user devices keep running
      yield* Effect.addFinalizer(() => Effect.promise(() => manager.dispose()));
      return { supported: platform === "darwin", manager } satisfies DeviceServiceShape;
    }),
  );
}

export const DeviceServiceLive = makeDeviceServiceLayer();
