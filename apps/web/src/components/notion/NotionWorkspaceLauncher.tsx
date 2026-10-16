import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { NotionBrowser } from "./NotionBrowser";
import { notionApi, NotionError } from "./notionUi";

/** A contextual entry into existing Notion surfaces, never another task store or shell. */
export function NotionWorkspaceLauncher({
  project = "",
  disabled = false,
}: {
  project?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<{
    connectionId: string;
    dataSourceId?: string;
  } | null>(null);
  const state = useQuery({
    queryKey: ["notion", "state"],
    queryFn: () => notionApi().state(),
    enabled: open,
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const connections = state.data?.connections ?? [];
  const allMappings = state.data?.mappings ?? [];
  const mappings = allMappings.filter(
    (mapping) => mapping.enabled && (!project || JSON.stringify(mapping.projectId) === project),
  );
  const empty = !connections.length || (project && !mappings.length);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled}
        title={disabled ? "Close task details before browsing a workspace" : undefined}
        onClick={() => setOpen(true)}
      >
        Notion workspace
      </Button>
      <Dialog open={open && target === null} onOpenChange={setOpen}>
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Connected Notion work</DialogTitle>
            <DialogDescription>
              Open mapped tasks, database views and sprints. Browse shared page titles within a
              workspace.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <NotionError message={state.error?.message} />
            {state.isPending ? (
              <p role="status" className="text-ui text-muted-foreground">
                Loading connections…
              </p>
            ) : null}
            {state.isError ? (
              <Button variant="outline" size="sm" onClick={() => void state.refetch()}>
                Try again
              </Button>
            ) : null}
            {connections.map((connection) => {
              const connectedMappings = mappings.filter(
                (mapping) => mapping.connectionId === connection.id,
              );
              if (project && !connectedMappings.length) return null;
              return (
                <section key={connection.id} className="space-y-2">
                  <h3 className="text-ui font-medium">{connection.workspaceName}</h3>
                  {connection.status !== "connected" ? (
                    <p className="text-ui-sm text-muted-foreground">
                      Reconnect this workspace in Notion settings.
                    </p>
                  ) : null}
                  {connectedMappings.map((mapping) => (
                    <Button
                      key={mapping.id}
                      variant="ghost"
                      className="h-auto w-full justify-start whitespace-normal text-left"
                      disabled={connection.status !== "connected"}
                      onClick={() =>
                        setTarget({
                          connectionId: connection.id,
                          dataSourceId: mapping.dataSourceId,
                        })
                      }
                    >
                      <span className="min-w-0">
                        <span className="block truncate">{mapping.name}</span>
                        <span className="block text-ui-xs text-muted-foreground">
                          Tasks, database views and sprint planning
                        </span>
                      </span>
                    </Button>
                  ))}
                  {!project ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={connection.status !== "connected"}
                      onClick={() => setTarget({ connectionId: connection.id })}
                    >
                      Browse shared pages
                    </Button>
                  ) : null}
                </section>
              );
            })}
            {state.data && empty ? (
              <p className="text-ui text-muted-foreground">
                {project
                  ? "No enabled Notion mappings for this project."
                  : "Connect a Notion workspace in Settings to get started."}
              </p>
            ) : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
      {target ? (
        <NotionBrowser
          key={`${target.connectionId}:${target.dataSourceId ?? "pages"}`}
          {...target}
          onClose={() => setTarget(null)}
        />
      ) : null}
    </>
  );
}
