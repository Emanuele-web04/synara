import { createFileRoute } from "@tanstack/react-router";
import { useWorkspaceSessions } from "../lib/hosts/workspaceSessions";

export const Route = createFileRoute("/_chat/remote")({
  validateSearch: (search: Record<string, unknown>) => ({
    environment: typeof search.environment === "string" ? search.environment : "",
    path: typeof search.path === "string" ? search.path : "/",
  }),
  component: RemoteWorkspaceRoute,
});

function RemoteWorkspaceRoute() {
  const { environment } = Route.useSearch();
  const session = useWorkspaceSessions().find(
    (item) => item.host.executionScope.environmentId === environment,
  );
  // The pane owns its loading/error UI once its router is ready. Do not leave
  // an obscured loading status in the outer document’s accessibility tree.
  if (session?.navigation) return null;
  return (
    <div
      className="flex flex-1 items-center justify-center p-6 text-ui text-muted-foreground"
      role="status"
    >
      {session
        ? (session.error ?? `Opening ${session.host.hostName}…`)
        : "This computer is not connected. Open Settings → Connections to reconnect it."}
    </div>
  );
}
