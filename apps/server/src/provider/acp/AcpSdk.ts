// FILE: AcpSdk.ts
// Purpose: Single memoized loader for the Agent Client Protocol SDK runtime values.
// Layer: Provider ACP runtime helper
// Exports: AcpSdkModule, loadAcpSdk

import { lazyModule } from "../../lazyModule.ts";

export type AcpSdkModule = typeof import("@agentclientprotocol/sdk");

/**
 * Loads `@agentclientprotocol/sdk` on first use. Every ACP-backed provider
 * (Cursor, Droid, Grok) only needs the SDK's runtime values once a session is
 * actually spawned, while an eager top-level import costs ~32ms on every server
 * boot. All other ACP modules consume the SDK purely as `import type`, which is
 * erased at compile time.
 */
export const loadAcpSdk: () => Promise<AcpSdkModule> = lazyModule(
  () => import("@agentclientprotocol/sdk"),
);
