/**
 * `@` mentions of Connectors never reach providers as native mentions:
 * Codex would treat `connector://` as a plugin path and Droid as a local path.
 * They become one context block naming the MCP server to use instead.
 *
 * @module provider/connectorMentionContext
 */
import type { ProviderMentionReference } from "@synara/contracts";
import {
  isMcpConnectorMentionPath,
  serverNameFromMcpConnectorMentionPath,
} from "@synara/shared/mcpConnectors";

const MAX_CONNECTOR_MENTIONS = 20;
const MAX_CONNECTOR_NAME_CHARS = 60;

export interface ConnectorMentionProjection {
  /** Every mention that is not a connector, for the thread/provider projection. */
  readonly otherMentions: ReadonlyArray<ProviderMentionReference> | undefined;
  /** Zero or one `<mentioned_connectors>` block. */
  readonly contextBlocks: readonly string[];
}

// Display names come from the user (custom URLs); keep them on one line and
// out of the tag syntax around them.
function sanitizeConnectorName(name: string): string {
  return name
    .replace(/[\r\n<>]+/gu, " ")
    .trim()
    .slice(0, MAX_CONNECTOR_NAME_CHARS);
}

export function projectConnectorMentions(input: {
  readonly mentions: ReadonlyArray<ProviderMentionReference> | undefined;
  /** When connectors are disabled, their mentions are dropped without a block. */
  readonly enabled: boolean;
}): ConnectorMentionProjection {
  const mentions = input.mentions ?? [];
  const otherMentions = mentions.filter((mention) => !isMcpConnectorMentionPath(mention.path));
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const mention of mentions) {
    const serverName = serverNameFromMcpConnectorMentionPath(mention.path);
    if (!serverName || seen.has(serverName) || seen.size >= MAX_CONNECTOR_MENTIONS) continue;
    seen.add(serverName);
    lines.push(`- @${sanitizeConnectorName(mention.name)}: MCP server "${serverName}"`);
  }
  return {
    otherMentions: otherMentions.length > 0 ? otherMentions : undefined,
    contextBlocks:
      input.enabled && lines.length > 0
        ? [
            [
              "<mentioned_connectors>",
              "The user mentioned these connected services. Use the tools of the matching MCP server:",
              ...lines,
              // Grants are fixed when the session starts, and some agents get no
              // connectors at all, so the server may be missing from this session.
              "If a server is not available in this session, do not guess its results: tell the user to start a new chat, or to reconnect it in Settings → Connectors.",
              "</mentioned_connectors>",
            ].join("\n"),
          ]
        : [],
  };
}
