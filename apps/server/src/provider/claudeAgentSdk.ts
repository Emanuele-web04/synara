import { lazyModule } from "../lazyModule.ts";

export type ClaudeAgentSdkModule = typeof import("@anthropic-ai/claude-agent-sdk");

// lazy SDK load: eager import costs ~26ms on every boot including ones that never touch Claude — all consumers share this loader; types stay `import type`
export const loadClaudeAgentSdk: () => Promise<ClaudeAgentSdkModule> = lazyModule(
  () => import("@anthropic-ai/claude-agent-sdk"),
);
