// FILE: mcpConnectorsReactQuery.ts
// Purpose: The one react-query definition of the Connectors list, shared by Settings and
//   the composer's `@` menu so a connect or disconnect refreshes both.
// Layer: Web data access
// Exports: MCP_CONNECTORS_QUERY_KEY, mcpConnectorsQueryOptions

import { queryOptions } from "@tanstack/react-query";

import { ensureNativeApi } from "~/nativeApi";

export const MCP_CONNECTORS_QUERY_KEY = ["server", "mcpConnectors"] as const;

export function mcpConnectorsQueryOptions() {
  return queryOptions({
    queryKey: MCP_CONNECTORS_QUERY_KEY,
    queryFn: () => ensureNativeApi().server.listMcpConnectors(),
    staleTime: 5_000,
    // Remote and browser-hosted clients get a definitive refusal (connectors
    // are managed on the loopback instance); retrying only repeats it.
    retry: false,
  });
}
