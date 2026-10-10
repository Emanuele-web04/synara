import { ServiceMap } from "effect";

import type { DeviceManager } from "../DeviceManager.ts";

export interface DeviceServiceShape {
  /** off darwin the manager still answers but every call reports `unsupported-platform` — callers hide the surface rather than offering tools that cannot work */
  readonly supported: boolean;
  readonly manager: DeviceManager;
}

export class DeviceService extends ServiceMap.Service<DeviceService, DeviceServiceShape>()(
  "synara/device/Services/DeviceService",
) {}
