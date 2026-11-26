import type { McpConnector } from "@synara/contracts";
import type { ReactNode } from "react";

import { McpConnectorGlyph } from "./McpConnectorGlyph";

export const MCP_CONNECTOR_CARD_CLASS_NAME =
  "min-w-0 rounded-xl border border-border bg-[var(--color-background-elevated-primary)] p-4 text-ui";

/** Shared identity for saved connectors and chat proposals. */
export function McpConnectorCardHeader(props: {
  connector: McpConnector;
  subtitle?: string | undefined;
  children?: ReactNode;
}) {
  const { connector } = props;
  const local = connector.transport === "stdio" || connector.transport === "local-http";
  return (
    <div className="flex min-w-0 items-center gap-3">
      <McpConnectorGlyph name={connector.name} url={local ? undefined : connector.url} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 truncate text-ui-lg font-semibold" title={connector.name}>
            {connector.name}
          </span>
          {connector.presetId === null ? (
            <span className="shrink-0 rounded-md border border-border/60 px-1.5 text-ui-xs text-muted-foreground">
              Custom
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-ui-sm text-muted-foreground">
          {props.subtitle ?? (local ? "On this computer" : "Remote server")}
        </p>
      </div>
      {props.children}
    </div>
  );
}

/** Exact configuration stays reviewable without putting paths on the main card. */
export function McpConnectorDetails({ connector }: { connector: McpConnector }) {
  return (
    <div className="space-y-4 text-ui-sm">
      <dl className="space-y-3 [overflow-wrap:anywhere]">
        {connector.transport === "stdio" ? (
          <>
            <div className="space-y-1">
              <dt className="text-ui-xs text-muted-foreground">Command</dt>
              <dd>
                <code>{connector.command}</code>
              </dd>
            </div>
            <div className="space-y-1">
              <dt className="text-ui-xs text-muted-foreground">Arguments (exact array)</dt>
              <dd>
                <code>{JSON.stringify(connector.args)}</code>
              </dd>
            </div>
            <div className="space-y-1">
              <dt className="text-ui-xs text-muted-foreground">Working directory</dt>
              <dd>{connector.cwd ?? "Home directory"}</dd>
            </div>
            <div className="space-y-1">
              <dt className="text-ui-xs text-muted-foreground">Environment keys (values hidden)</dt>
              <dd>{connector.envKeys.join(", ") || "None"}</dd>
            </div>
          </>
        ) : (
          <div className="space-y-1">
            <dt className="text-ui-xs text-muted-foreground">Server URL</dt>
            <dd>{connector.url}</dd>
          </div>
        )}
      </dl>
      <p className="text-ui-xs text-muted-foreground">
        Used by Claude, Codex, OpenCode, Cursor, Grok, Droid and Oh My Pi
      </p>
    </div>
  );
}
