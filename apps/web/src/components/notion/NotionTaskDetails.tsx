import type { NotionTodoReference, Todo } from "@synara/contracts";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { NotionBrowser } from "./NotionBrowser";
import { NotionTaskPropertyEditor } from "./NotionTaskPropertyEditor";

export function NotionTaskDetails({ todo }: { todo: Todo }) {
  // TaskCard stays mounted across selections. Open editors belong to the task they opened for.
  const [page, setPage] = useState<NotionTodoReference | null>(null);
  const [database, setDatabase] = useState<NotionTodoReference | null>(null);
  const [editing, setEditing] = useState<{ external: NotionTodoReference; title: string } | null>(
    null,
  );
  const external = todo.external;
  return (
    <>
      {external ? (
        <div className="space-y-2 rounded-xl border border-border p-3 text-ui-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">Notion · {external.workspaceName}</span>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={editing !== null}
                onClick={() =>
                  setEditing({ external: structuredClone(external), title: todo.title })
                }
              >
                Edit task properties
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={editing !== null}
                onClick={() => setPage(structuredClone(external))}
              >
                Page details
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={editing !== null}
                onClick={() => setDatabase(structuredClone(external))}
              >
                Database and sprints
              </Button>
            </div>
          </div>
          <p className="text-muted-foreground">
            {external.status ?? "No mapped status"} · {external.syncState}
            {external.assignees.length ? ` · ${external.assignees.join(", ")}` : ""}
          </p>
          {external.sprintIds.length ? (
            <p className="break-words text-muted-foreground">
              Sprint: {external.sprintIds.join(", ")}
            </p>
          ) : null}
          {external.storyPoints !== null ? (
            <p className="text-muted-foreground">{external.storyPoints} story points</p>
          ) : null}
          {external.syncMessage ? <p role="status">{external.syncMessage}</p> : null}
          <p className="text-muted-foreground">
            Finishing an agent run does not complete this Notion task.
          </p>
        </div>
      ) : null}
      {editing ? (
        <NotionTaskPropertyEditor
          key={`${editing.external.connectionId}:${editing.external.pageId}`}
          {...editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {database ? (
        <NotionBrowser
          key={database.connectionId + database.dataSourceId}
          connectionId={database.connectionId}
          dataSourceId={database.dataSourceId}
          onClose={() => setDatabase(null)}
        />
      ) : null}
      {page ? (
        <NotionBrowser
          key={`${page.connectionId}:${page.pageId}`}
          connectionId={page.connectionId}
          pageId={page.pageId}
          onClose={() => setPage(null)}
        />
      ) : null}
    </>
  );
}
