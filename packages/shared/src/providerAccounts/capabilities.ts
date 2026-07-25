// FILE: capabilities.ts
// Purpose: Authentication and surface support matrix (plan section 7).
// Layer: Cross-package pure utility

import type {
  AccountSupportLevel,
  AccountSurface,
  AgentAuthMethod,
  ProviderAccountCapabilities,
  SupportedAccountProvider,
} from "@synara/contracts";

const CAPABILITY_MATRIX: Record<SupportedAccountProvider, ProviderAccountCapabilities> = {
  codex: {
    agent: { oauth: "supported", apiKey: "supported" },
    app: { oauth: "experimental", supportLevel: "experimental" },
  },
  claudeAgent: {
    agent: { oauth: "beta", apiKey: "supported" },
    app: { oauth: "experimental", supportLevel: "experimental" },
  },
  cursor: {
    agent: { oauth: "unsupported", apiKey: "supported" },
    app: { oauth: "beta", supportLevel: "beta" },
  },
  grok: {
    agent: { oauth: "supported", apiKey: "supported" },
    app: { oauth: "unsupported", supportLevel: "unsupported" },
  },
};

export function authCapabilities(provider: SupportedAccountProvider): ProviderAccountCapabilities {
  return CAPABILITY_MATRIX[provider];
}

export function supportLevelFor(
  provider: SupportedAccountProvider,
  surface: AccountSurface,
  authMethod: AgentAuthMethod,
): AccountSupportLevel {
  const capabilities = CAPABILITY_MATRIX[provider];
  if (surface === "app") {
    return authMethod === "oauth" ? capabilities.app.oauth : "unsupported";
  }
  return authMethod === "oauth" ? capabilities.agent.oauth : capabilities.agent.apiKey;
}
