import { lazyModule } from "../../lazyModule.ts";

export type AcpSdkModule = typeof import("@agentclientprotocol/sdk");

// lazy SDK load: every ACP provider needs runtime values only once a session spawns; an eager import costs ~32ms on every boot — types stay `import type`
export const loadAcpSdk: () => Promise<AcpSdkModule> = lazyModule(
  () => import("@agentclientprotocol/sdk"),
);
