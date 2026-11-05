import type { McpConnector } from "@synara/contracts";
import type { ReactNode } from "react";

import { useTranslation } from "~/i18n";

import { McpConnectorGlyph } from "./McpConnectorGlyph";

export const MCP_CONNECTOR_CARD_CLASS_NAME =
  "min-w-0 rounded-xl border border-border bg-[var(--color-background-elevated-primary)] p-4 text-ui";

/** Shared identity for saved connectors and chat proposals. */
export function McpConnectorCardHeader(props: {
  connector: McpConnector;
  subtitle?: string | undefined;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
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
              {t("settings:remote_connector_custom")}
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-ui-sm text-muted-foreground">
          {props.subtitle ??
            (local
              ? t("settings:remote_connector_onThisComputer")
              : t("settings:remote_connector_remoteServer"))}
        </p>
      </div>
      {props.children}
    </div>
  );
}

/** Exact configuration stays reviewable without putting paths on the main card. */
export function McpConnectorDetails({ connector }: { connector: McpConnector }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4 text-ui-sm">
      <dl className="space-y-3 [overflow-wrap:anywhere]">
        {connector.transport === "stdio" ? (
          <>
            <div className="space-y-1">
              <dt className="text-ui-xs text-muted-foreground">{t("workspace:scripts_command")}</dt>
              <dd>
                <code>{connector.command}</code>
              </dd>
            </div>
            <div className="space-y-1">
              <dt className="text-ui-xs text-muted-foreground">
                {t("settings:remote_connector_exactArguments")}
              </dt>
              <dd>
                <code>{JSON.stringify(connector.args)}</code>
              </dd>
            </div>
            <div className="space-y-1">
              <dt className="text-ui-xs text-muted-foreground">
                {t("settings:remote_connector_workingDirectory")}
              </dt>
              <dd>{connector.cwd ?? t("settings:remote_connector_homeDirectory")}</dd>
            </div>
            <div className="space-y-1">
              <dt className="text-ui-xs text-muted-foreground">
                {t("settings:remote_connector_environmentKeys")}
              </dt>
              <dd>{connector.envKeys.join(", ") || t("chat:none")}</dd>
            </div>
          </>
        ) : (
          <div className="space-y-1">
            <dt className="text-ui-xs text-muted-foreground">
              {t("settings:remote_connector_serverUrl")}
            </dt>
            <dd>{connector.url}</dd>
          </div>
        )}
      </dl>
      <p className="text-ui-xs text-muted-foreground">
        {t("settings:remote_connector_usedByProviders")}
      </p>
    </div>
  );
}
