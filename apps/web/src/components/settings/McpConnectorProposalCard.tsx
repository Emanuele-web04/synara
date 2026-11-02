import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "~/components/ui/button";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { ProposalActions } from "~/components/ui/proposal-actions";
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
          ? "Open Connectors on the owning computer to review this proposal."
          : "Loading connector proposal…"}
      </p>
    );
  const connector = proposal.connector;
  const pending = proposal.state === "pending";
  const reviewOpen = pending && reviewingId === proposalId;
  return (
    <section
      className={`${MCP_CONNECTOR_CARD_CLASS_NAME} w-full max-w-xl`}
      aria-label={`${connector.name} connector proposal`}
    >
      <McpConnectorCardHeader connector={connector} />
      {pending ? (
        <p className="mt-4 text-ui-sm text-muted-foreground">
          {proposal.action === "remove"
            ? `Remove ${connector.name} from Synara and stop access from its chats.`
            : `Connect ${connector.name} to use its tools in new chats.`}
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
          Connection details
          <DisclosureChevron open={reviewOpen} className="size-3.5" />
        </Button>
      ) : null}
      <DisclosureRegion open={reviewOpen}>
        <div id={detailsId} className="space-y-4 pt-4">
          {proposal.source ? (
            <p className="text-ui-sm text-muted-foreground [overflow-wrap:anywhere]">
              Found in {proposal.source}
            </p>
          ) : null}
          <McpConnectorDetails connector={connector} />
          {proposal.action === "add" ? (
            <p className="text-ui-sm text-muted-foreground">
              {connector.transport === "stdio"
                ? "Approval runs this command on this computer. Its tools become available in new chats."
                : "Approval connects to this URL and opens OAuth sign-in if required. Its tools become available in new chats."}
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
                  ? "Remove connector"
                  : "Approve connector"
                : "Review connection"
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
              ? "Connector removed"
              : "Approved · available in new chats after connection"
            : "Dismissed"}
        </p>
      )}
      {mutation.isError ? (
        <p role="alert" className="mt-3 text-ui-sm text-destructive">
          {mutation.error instanceof Error
            ? mutation.error.message
            : "Could not apply this proposal."}
        </p>
      ) : null}
    </section>
  );
}
