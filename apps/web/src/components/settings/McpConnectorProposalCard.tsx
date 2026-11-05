import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "~/components/ui/button";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { ProposalActions } from "~/components/ui/proposal-actions";
import { useTranslation } from "~/i18n";
import { MCP_CONNECTORS_QUERY_KEY } from "~/lib/mcpConnectorsReactQuery";
import { ensureNativeApi } from "~/nativeApi";
import {
  MCP_CONNECTOR_CARD_CLASS_NAME,
  McpConnectorCardHeader,
  McpConnectorDetails,
} from "./McpConnectorCard";

export const MCP_CONNECTOR_PROPOSALS_QUERY_KEY = ["server", "mcpConnectorProposals"] as const;
export function mcpConnectorProposalsQueryOptions() {
  return {
    queryKey: MCP_CONNECTOR_PROPOSALS_QUERY_KEY,
    queryFn: () => ensureNativeApi().server.listMcpConnectorProposals(),
    refetchInterval: 5_000,
    retry: false,
  } as const;
}

export function McpConnectorProposalCard({ proposalId }: { proposalId: string }) {
  const { t } = useTranslation();
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const detailsId = useId();
  const client = useQueryClient();
  const query = useQuery(mcpConnectorProposalsQueryOptions());
  const proposal = query.data?.find((entry) => entry.proposalId === proposalId);
  const mutation = useMutation({
    mutationFn: (resolution: "accepted" | "dismissed") =>
      ensureNativeApi().server.resolveMcpConnectorProposal({ proposalId, resolution }),
    onSuccess: async (result) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: MCP_CONNECTORS_QUERY_KEY }),
        client.invalidateQueries({ queryKey: MCP_CONNECTOR_PROPOSALS_QUERY_KEY }),
      ]);
      if (result.authorizationUrl)
        await ensureNativeApi().shell.openExternal(result.authorizationUrl);
    },
  });
  if (!proposal)
    return (
      <p className="text-ui-sm text-muted-foreground">
        {query.isError
          ? t("settings:remote_connector_reviewOnOwningComputer")
          : t("settings:remote_connector_loadingProposal")}
      </p>
    );
  const connector = proposal.connector;
  const pending = proposal.state === "pending";
  const reviewOpen = pending && reviewingId === proposalId;
  return (
    <section
      className={`${MCP_CONNECTOR_CARD_CLASS_NAME} w-full max-w-xl`}
      aria-label={t("settings:remote_connector_proposalLabel", { name: connector.name })}
    >
      <McpConnectorCardHeader connector={connector} />
      {pending ? (
        <p className="mt-4 text-ui-sm text-muted-foreground">
          {proposal.action === "remove"
            ? t("settings:remote_connector_removeDescription", { name: connector.name })
            : t("settings:remote_connector_connectDescription", { name: connector.name })}
        </p>
      ) : null}
      {reviewOpen ? (
        <Button
          type="button"
          variant="ghost"
          size="chip"
          aria-expanded={reviewOpen}
          aria-controls={detailsId}
          onClick={() => setReviewingId(null)}
          className="mt-4"
        >
          {t("settings:remote_connector_connectionDetails")}
          <DisclosureChevron open={reviewOpen} className="size-3.5" />
        </Button>
      ) : null}
      <DisclosureRegion open={reviewOpen}>
        <div id={detailsId} className="space-y-4 pt-4">
          {proposal.source ? (
            <p className="text-ui-sm text-muted-foreground [overflow-wrap:anywhere]">
              {t("settings:remote_connector_foundIn", { source: proposal.source })}
            </p>
          ) : null}
          <McpConnectorDetails connector={connector} />
          {proposal.action === "add" ? (
            <p className="text-ui-sm text-muted-foreground">
              {connector.transport === "stdio"
                ? t("settings:remote_connector_commandApproval")
                : t("settings:remote_connector_urlApproval")}
            </p>
          ) : null}
        </div>
      </DisclosureRegion>
      {pending ? (
        <div className="mt-4 flex justify-end">
          <ProposalActions
            pending={mutation.isPending}
            acceptLabel={
              reviewOpen
                ? proposal.action === "remove"
                  ? t("settings:remote_connector_remove")
                  : t("settings:remote_connector_approve")
                : t("settings:remote_connector_review")
            }
            onResolve={(resolution) => {
              if (resolution === "accepted" && !reviewOpen) setReviewingId(proposalId);
              else mutation.mutate(resolution);
            }}
          />
        </div>
      ) : (
        <p className="mt-4 text-ui-sm text-muted-foreground">
          {proposal.state === "accepted"
            ? proposal.action === "remove"
              ? t("settings:remote_connector_removed")
              : t("settings:remote_connector_approved")
            : t("settings:remote_connector_dismissed")}
        </p>
      )}
      {mutation.isError ? (
        <p role="alert" className="mt-3 text-ui-sm text-destructive">
          {mutation.error instanceof Error
            ? mutation.error.message
            : t("settings:remote_connector_proposalFailed")}
        </p>
      ) : null}
    </section>
  );
}
