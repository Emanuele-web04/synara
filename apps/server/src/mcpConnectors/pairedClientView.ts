// FILE: pairedClientView.ts
// Purpose: What a paired device may read about this computer's connectors: enough to
//          mention one (name, MCP server name, status, site for its logo), never a URL
//          path, query or credentials, since some servers keep an API key there.
// Layer: Connectors
// Exports: connectorsForPairedClient

import type { McpConnector } from "@synara/contracts";

export function connectorsForPairedClient(
  connectors: readonly McpConnector[],
): readonly McpConnector[] {
  return connectors.flatMap((connector) => {
    // Process paths, arguments and environment keys stay on the owning computer.
    if (connector.transport === "stdio") return [];
    try {
      const origin = new URL(connector.url).origin;
      return origin === "null" ? [] : [{ ...connector, url: origin }];
    } catch {
      return [];
    }
  });
}
