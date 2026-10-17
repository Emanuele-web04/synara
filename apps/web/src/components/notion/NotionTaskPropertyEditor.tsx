import type { NotionMapping, NotionObject, NotionTodoReference } from "@synara/contracts";
import {
  notionArray,
  notionObject,
  notionPropertyLabel,
  notionResourceId,
  notionString,
} from "@synara/shared/notion";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { NotionDraftBoundary, useNotionDraft, useNotionDraftGuard } from "./NotionDraftBoundary";
import {
  mappedNotionProperties,
  notionOptions,
  notionReferenceChoices,
  notionTaskPropertyPatch,
  type MappedNotionProperty,
} from "./notionProperties";
import { NotionError, NotionSelect, notionApi, useNotionAction } from "./notionUi";

interface PropertyControlProps {
  connectionId: string;
  property: MappedNotionProperty;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
}

function ReferenceChoices({
  connectionId,
  property,
  value,
  disabled,
  onChange,
}: PropertyControlProps) {
  const [filter, setFilter] = useState("");
  const people = property.type === "people";
  const sourceId = notionString(notionObject(property.schema.relation).data_source_id);
  const selected = notionArray(value).map((raw) =>
    notionResourceId(notionString(notionObject(raw).id)),
  );
  const query = useInfiniteQuery({
    queryKey: ["notion", "property-choices", connectionId, property.type, sourceId],
    initialPageParam: undefined as string | undefined,
    enabled: !disabled && (people || Boolean(sourceId)),
    queryFn: async ({ pageParam }) => {
      const result = (
        await notionApi().read({
          connectionId,
          ...(people ? { kind: "users" as const } : { kind: "query" as const, id: sourceId }),
          pageSize: 50,
          ...(pageParam ? { cursor: pageParam } : {}),
        })
      ).data;
      return {
        has_more: result.has_more === true,
        next_cursor: notionString(result.next_cursor),
        options: notionReferenceChoices(result, people, sourceId),
      };
    },
    getNextPageParam: (lastPage, pages) => {
      const cursor = notionString(lastPage.next_cursor);
      if (lastPage.has_more !== true || !cursor || pages.length >= 40) return undefined;
      if (pages.slice(0, -1).some((page) => page.next_cursor === cursor)) return undefined;
      return cursor;
    },
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const choices = new Map<string, string>();
  for (const raw of notionArray(property.original[property.type])) {
    const original = notionObject(raw);
    choices.set(
      notionResourceId(notionString(original.id)),
      notionString(original.name) || notionString(original.id),
    );
  }
  for (const page of query.data?.pages ?? []) {
    for (const option of page.options) choices.set(option.value, option.label);
  }
  const visible = [...choices].filter(
    ([id, label]) => selected.includes(id) || label.toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <div className="space-y-2">
      {!people && !sourceId ? (
        <p className="text-ui-sm text-muted-foreground">
          The related data source is not shared or is missing from the schema. Existing references
          are retained.
        </p>
      ) : null}
      <Input
        aria-label={`Filter ${property.label} choices`}
        placeholder="Filter loaded choices"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      <div className="max-h-48 space-y-2 overflow-auto rounded-lg border border-border p-3">
        {visible.map(([id, label]) => (
          <label className="flex items-center gap-2 text-ui" key={id}>
            <Checkbox
              checked={selected.includes(id)}
              disabled={disabled || !query.isSuccess || (!people && !sourceId)}
              onCheckedChange={(checked) => {
                const next = checked
                  ? [...new Set([...selected, id])]
                  : selected.filter((current) => current !== id);
                onChange(next.map((id) => ({ id })));
              }}
            />
            <span className="break-words">{label}</span>
          </label>
        ))}
        {query.isLoading ? (
          <p role="status" className="text-ui-sm text-muted-foreground">
            Loading authorized choices…
          </p>
        ) : null}
        {!query.isLoading && !visible.length ? (
          <p className="text-ui-sm text-muted-foreground">No matching loaded choices.</p>
        ) : null}
      </div>
      <NotionError message={query.error?.message} />
      {query.isError ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || query.isFetching}
          onClick={() => void query.refetch()}
        >
          Retry choices
        </Button>
      ) : null}
      {query.hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          Load more choices
        </Button>
      ) : null}
      {query.data?.pages.at(-1)?.has_more === true && !query.hasNextPage ? (
        <p role="status" className="text-ui-sm text-muted-foreground">
          The choice list is incomplete. Unloaded selections are preserved.
        </p>
      ) : null}
      <p className="text-ui-xs text-muted-foreground">
        {selected.length} selected. Filtering or loading another page does not clear selections.
      </p>
    </div>
  );
}

export function PropertyControl(props: PropertyControlProps) {
  const { property, value, disabled, onChange } = props;
  if (property.readOnlyReason)
    return (
      <div className="space-y-1 text-ui-sm text-muted-foreground">
        <p>{notionPropertyLabel(property.original) || "No value"}</p>
        <p>{property.readOnlyReason}</p>
      </div>
    );
  const options = notionOptions(property);
  if (property.type === "status" || property.type === "select") {
    return (
      <NotionSelect
        label={property.label}
        value={notionString(notionObject(value).id)}
        disabled={disabled}
        options={[
          ...(property.type === "select" ? [{ value: "", label: "Not assigned" }] : []),
          ...options,
        ]}
        onChange={(id) => onChange(id ? { id } : null)}
      />
    );
  }
  if (property.type === "multi_select") {
    const selected = notionArray(value).map((raw) => notionString(notionObject(raw).id));
    const known = new Set(options.map((option) => option.value));
    return (
      <div className="space-y-2">
        {selected
          .filter((id) => !known.has(id))
          .map((id) => (
            <p className="text-ui-sm text-muted-foreground" key={id}>
              Unknown existing option retained: {id}
            </p>
          ))}
        {options.map((option) => (
          <label key={option.value} className="flex items-center gap-2 text-ui">
            <Checkbox
              checked={selected.includes(option.value)}
              disabled={disabled}
              onCheckedChange={(checked) =>
                onChange(
                  (checked
                    ? [...new Set([...selected, option.value])]
                    : selected.filter((id) => id !== option.value)
                  ).map((id) => ({ id })),
                )
              }
            />
            {option.label}
          </label>
        ))}
      </div>
    );
  }
  if (property.type === "relation" || property.type === "people")
    return <ReferenceChoices {...props} />;
  if (property.type === "number")
    return (
      <Input
        aria-label={property.label}
        type="number"
        min={property.fields.includes("points") ? 0 : undefined}
        step="any"
        disabled={disabled}
        value={typeof value === "number" && Number.isFinite(value) ? value : ""}
        onChange={(event) =>
          onChange(event.target.value === "" ? null : event.target.valueAsNumber)
        }
      />
    );
  if (property.type === "checkbox")
    return (
      <Checkbox
        aria-label={property.label}
        checked={value === true}
        disabled={disabled}
        onCheckedChange={(checked) => onChange(checked)}
      />
    );
  if (property.type === "date") {
    const date = notionObject(value);
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-ui-sm">
          Start
          <Input
            aria-label={`${property.label} start`}
            type="date"
            value={notionString(date.start)}
            disabled={disabled}
            onChange={(event) =>
              onChange(
                event.target.value
                  ? { start: event.target.value, end: date.end ?? null, time_zone: null }
                  : null,
              )
            }
          />
        </label>
        <label className="grid gap-1 text-ui-sm">
          End (optional)
          <Input
            aria-label={`${property.label} end`}
            type="date"
            min={notionString(date.start)}
            value={notionString(date.end)}
            disabled={disabled || !date.start}
            onChange={(event) =>
              onChange({ start: date.start, end: event.target.value || null, time_zone: null })
            }
          />
        </label>
      </div>
    );
  }
  return null;
}

interface TaskEditorSnapshot {
  mapping: NotionMapping;
  source: NotionObject;
  page: NotionObject;
  properties: MappedNotionProperty[];
}

function TaskEditor({ snapshot, onClose }: { snapshot: TaskEditorSnapshot; onClose: () => void }) {
  // Query refetches never replace a user's baseline or draft while this editor is mounted.
  const [original] = useState(() => structuredClone(snapshot));
  const [edits, setEdits] = useState<NotionObject>({});
  const action = useNotionAction();
  const locked = action.pending || action.awaitingConfirmation;
  useNotionDraft(Object.keys(edits).length > 0 || action.pending);
  return (
    <form
      className="space-y-4 rounded-lg border border-border p-3"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.stopPropagation();
          event.preventDefault();
          event.currentTarget.requestSubmit();
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        void action.run(async () => {
          const patch = notionTaskPropertyPatch(
            original.mapping,
            original.source,
            original.page,
            edits,
          );
          if (!Object.keys(patch.changes).length) {
            onClose();
            return;
          }
          await action.write({
            connectionId: original.mapping.connectionId,
            kind: "updatePage",
            id: notionString(original.page.id),
            ...patch,
          });
          await notionApi().sync();
          onClose();
        });
      }}
    >
      <h4 className="text-ui font-medium">Task properties</h4>
      <p className="text-ui-sm text-muted-foreground">
        Only explicitly mapped Notion properties are changed. Clearing the Sprint field returns this
        task to the backlog. Agent execution is unaffected.
      </p>
      {original.properties.map((property) => (
        <fieldset key={property.id} className="space-y-2" disabled={locked}>
          <legend className="mb-1 text-ui font-medium">
            {property.label}{" "}
            <span className="font-normal text-muted-foreground">
              ({property.fields.join(" / ")})
            </span>
          </legend>
          <PropertyControl
            connectionId={original.mapping.connectionId}
            property={property}
            value={
              Object.hasOwn(edits, property.id)
                ? edits[property.id]
                : property.original[property.type]
            }
            disabled={locked}
            onChange={(value) => setEdits((current) => ({ ...current, [property.id]: value }))}
          />
        </fieldset>
      ))}
      {!original.properties.length ? (
        <p className="text-ui-sm text-muted-foreground">
          Configure additional task fields in Settings → Integrations → Notion.
        </p>
      ) : null}
      <NotionError message={action.error} />
      {action.awaitingConfirmation ? (
        <p role="status" className="text-ui-sm text-muted-foreground">
          The original request is retained while this editor is open. Retry checks the same request.
          Review conflicts in Notion settings; closing does not undo a remote write.
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" disabled={action.pending} onClick={onClose}>
          {action.awaitingConfirmation ? "Close to review" : "Cancel"}
        </Button>
        <Button type="submit" disabled={action.pending || !Object.keys(edits).length}>
          {action.pending
            ? "Saving…"
            : action.awaitingConfirmation
              ? "Check original request"
              : "Save task properties"}
        </Button>
      </div>
    </form>
  );
}

function TaskEditorLoader({
  external,
  onClose,
}: {
  external: NotionTodoReference;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: ["notion", "task-editor", external.connectionId, external.mappingId, external.pageId],
    queryFn: async (): Promise<TaskEditorSnapshot> => {
      const api = notionApi();
      const state = await api.state();
      const mapping = state.mappings.find(
        (candidate) =>
          candidate.id === external.mappingId &&
          candidate.connectionId === external.connectionId &&
          candidate.enabled,
      );
      if (
        !mapping ||
        !state.connections.some(
          (connection) =>
            connection.id === external.connectionId && connection.status === "connected",
        )
      )
        throw new Error("Reconnect or enable this task's Notion source before editing.");
      const [source, page] = await Promise.all([
        api.read({
          connectionId: external.connectionId,
          kind: "dataSource",
          id: mapping.dataSourceId,
        }),
        api.read({ connectionId: external.connectionId, kind: "page", id: external.pageId }),
      ]);
      const properties = mappedNotionProperties(mapping, source.data, page.data);
      return { mapping, source: source.data, page: page.data, properties };
    },
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  if (query.isError)
    return (
      <div className="space-y-2">
        <NotionError message={query.error.message} />
        <Button
          variant="outline"
          size="sm"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Retry task properties
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
    );
  if (!query.data)
    return (
      <p role="status" className="text-ui-sm text-muted-foreground">
        Loading task properties…
      </p>
    );
  return <TaskEditor snapshot={query.data} onClose={onClose} />;
}

function TaskEditorDialog({
  external,
  title,
  onClose,
}: {
  external: NotionTodoReference;
  title: string;
  onClose: () => void;
}) {
  const guard = useNotionDraftGuard();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && guard?.mayLeave() !== false) onClose();
      }}
    >
      <DialogPopup
        className="w-[min(42rem,94vw)]"
        onKeyDown={(event) => {
          // Portal events still bubble to TaskCard's agent hand-off shortcut.
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") event.stopPropagation();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title || "Notion task"}</DialogTitle>
          <DialogDescription>
            Edit mapped Notion properties. This editor stays with this task, independently of the
            selected task card.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="max-h-[75vh] space-y-3 overflow-auto">
          <NotionError message={guard?.error} />
          <TaskEditorLoader external={external} onClose={onClose} />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

export function NotionTaskPropertyEditor(props: {
  external: NotionTodoReference;
  title: string;
  onClose: () => void;
}) {
  return (
    <NotionDraftBoundary>
      <TaskEditorDialog {...props} />
    </NotionDraftBoundary>
  );
}
