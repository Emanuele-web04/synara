import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ProposalActions } from "~/components/ui/proposal-actions";
import { MCP_CONNECTORS_QUERY_KEY } from "~/lib/mcpConnectorsReactQuery";
import { ensureNativeApi } from "~/nativeApi";

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
  return (
    <div className="space-y-3 rounded-xl border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-primary)] p-3 text-ui">
      <p className="font-medium">
        {proposal.action === "add" ? "Add" : "Remove"} {connector.name}?
      </p>
      {proposal.source ? (
        <p className="text-ui-sm text-muted-foreground">Found in {proposal.source}</p>
      ) : null}
      {connector.transport === "stdio" ? (
        <dl className="space-y-1 break-all text-ui-sm">
          <dt>Command</dt>
          <dd>
            <code>{connector.command}</code>
          </dd>
          <dt>Arguments (exact array)</dt>
          <dd>
            <code>{JSON.stringify(connector.args)}</code>
          </dd>
          <dt>Working directory</dt>
          <dd>{connector.cwd ?? "Home directory"}</dd>
          <dt>Environment keys (values hidden)</dt>
          <dd>{connector.envKeys.join(", ") || "None"}</dd>
        </dl>
      ) : (
        <p className="break-all text-ui-sm">{connector.url}</p>
      )}
      <p className="text-ui-sm text-muted-foreground">
        {proposal.action === "remove"
          ? "Removes this connector from Synara and stops access from its chats."
          : connector.transport === "stdio"
            ? "Approval runs this command on this computer. Its tools become available in new chats."
            : "Approval connects to this URL and opens OAuth sign-in if required. Its tools become available in new chats."}
      </p>
      {proposal.state === "pending" ? (
        <ProposalActions
          pending={mutation.isPending}
          acceptLabel={proposal.action === "remove" ? "Remove connector" : "Approve connector"}
          onResolve={(resolution) => mutation.mutate(resolution)}
        />
      ) : (
        <p className="text-ui-sm text-muted-foreground">
          {proposal.state === "accepted"
            ? proposal.action === "remove"
              ? "Connector removed"
              : "Approved · available in new threads after connection"
            : "Dismissed"}
        </p>
      )}
      {mutation.isError ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {mutation.error instanceof Error
            ? mutation.error.message
            : "Could not apply this proposal."}
        </p>
      ) : null}
    </div>
  );
}
