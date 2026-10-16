// FILE: McpServerIcon.tsx
// Purpose: The leading icon of an MCP tool-call row: the connector's own icon (vendor mark
//   or site favicon) for Synara connectors, the vendor mark for a server named after a known
//   brand (`stripe`, `notion`), and the generic MCP glyph otherwise.
// Layer: Chat timeline UI
// Exports: McpServerIcon

import { MCP_CONNECTOR_SERVER_NAME_SUFFIX } from "@synara/shared/mcpConnectors";
import { useQuery } from "@tanstack/react-query";

import { MCP_CONNECTORS_ON } from "~/betaFeatures";
import { McpIcon } from "~/lib/icons";
import { mcpConnectorsQueryOptions } from "~/lib/mcpConnectorsReactQuery";

import { ConnectorIcon, hasConnectorBrand } from "../ConnectorIcon";

export function McpServerIcon(props: { serverName: string; className: string }) {
  const isConnector = props.serverName.endsWith(MCP_CONNECTOR_SERVER_NAME_SUFFIX);
  const connectorsQuery = useQuery({
    ...mcpConnectorsQueryOptions(),
    enabled: MCP_CONNECTORS_ON && isConnector,
    staleTime: 60_000,
  });
  const connector = isConnector
    ? connectorsQuery.data?.find((entry) => entry.serverName === props.serverName)
    : undefined;
  if (connector) {
    return <ConnectorIcon name={connector.name} url={connector.url} className={props.className} />;
  }
  // Disconnected connectors and provider-configured servers keep only their name.
  const name = isConnector
    ? props.serverName.slice(0, -MCP_CONNECTOR_SERVER_NAME_SUFFIX.length)
    : props.serverName;
  if (hasConnectorBrand(name)) return <ConnectorIcon name={name} className={props.className} />;
  return <McpIcon className={props.className} />;
}
