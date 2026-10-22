import type { NotionMapping, NotionObject } from "@synara/contracts";
import {
  notionArray,
  notionObject,
  notionPropertyLabel,
  notionPropertySnapshot,
  notionRelationIds,
  notionString,
  notionText,
  notionTitle,
  plainNotionText,
  isPlainNotionText,
} from "@synara/shared/notion";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { NotionPlanningPanel } from "./NotionPlanningPanel";
import { NotionRecordPropertyEditor } from "./NotionRecordPropertyEditor";
import { moveNotionDate } from "./notionPlanning";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { notionOptions, notionProperties, type NotionPropertyDescriptor } from "./notionProperties";
import { useNotionDraft, useNotionDraftGuard } from "./NotionDraftBoundary";
import {
  NotionError,
  NotionReceiptNotice,
  NotionSelect,
  notionApi,
  useNotionAction,
} from "./notionUi";

type RecordView = "table" | "list" | "board" | "calendar" | "timeline" | "sprints";
type OpenPage = (id: string, kind: "page") => void;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_MS = 86_400_000;

function property(page: NotionObject, column: NotionPropertyDescriptor | undefined): NotionObject {
  return (
    Object.values(notionObject(page.properties))
      .map(notionObject)
      .find((value) => value.id === column?.id) ?? {}
  );
}
function dateKey(value: unknown): string {
  const text = notionString(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
  const parsed = new Date(text + "T00:00:00Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text
    ? text
    : "";
}
function startOfWeek(value: Date): Date {
  const day = new Date(value);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day;
}
function advance(value: Date, amount: number, unit: "month" | "day"): Date {
  const next = new Date(value);
  if (unit === "month") next.setUTCMonth(next.getUTCMonth() + amount, 1);
  else next.setUTCDate(next.getUTCDate() + amount);
  return next;
}
function dayString(day: Date): string {
  return day.toISOString().slice(0, 10);
}
function safeDateOnly(value: NotionObject): boolean {
  const raw = value.date;
  const date = notionObject(raw);
  return (
    raw == null ||
    (!date.time_zone &&
      (!date.start || dateKey(date.start) === date.start) &&
      (!date.end || dateKey(date.end) === date.end))
  );
}
function statusId(page: NotionObject, column: NotionPropertyDescriptor | undefined): string {
  return notionString(notionObject(property(page, column)[column?.type ?? ""]).id);
}
function points(page: NotionObject, mapping: NotionMapping | undefined): number {
  const id = mapping?.fields.points?.id;
  const value = Object.values(notionObject(page.properties))
    .map(notionObject)
    .find((item) => item.id === id)?.number;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function isDone(page: NotionObject, mapping: NotionMapping | undefined): boolean {
  if (!mapping?.fields.status) return false;
  const field = Object.values(notionObject(page.properties))
    .map(notionObject)
    .find((item) => item.id === mapping.fields.status?.id);
  return field?.type === "checkbox"
    ? field.checkbox === true
    : mapping.completedStatusIds.includes(
        notionString(notionObject(field?.[notionString(field?.type)]).id),
      );
}

/** Synara-defined views over the authorized, paginated Notion API response; never saved Notion views. */
export function NotionDatabaseWorkspace({
  connectionId,
  id,
  onOpen,
}: {
  connectionId: string;
  id: string;
  onOpen: OpenPage;
}) {
  const [view, setView] = useState<RecordView>("table");
  const [cursor, setCursor] = useState<string | undefined>();
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [sortKey, setSortKey] = useState("title");
  const [descending, setDescending] = useState(false);
  const [visibleIds, setVisibleIds] = useState<string[] | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [editing, setEditing] = useState<{
    pageId: string;
    propertyId: string;
    value: string;
    page: NotionObject;
  } | null>(null);
  const [propertyPage, setPropertyPage] = useState<NotionObject | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [anchor, setAnchor] = useState(
    () => new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth(), 1)),
  );
  const [calendarMode, setCalendarMode] = useState<"month" | "week">("month");
  const [timelineDays, setTimelineDays] = useState(30);
  const action = useNotionAction();
  useNotionDraft(Boolean(newTitle.trim()) || editing !== null || action.pending);
  const guard = useNotionDraftGuard();

  const schema = useQuery({
    queryKey: ["notion", "schema", connectionId, id],
    queryFn: async () => (await notionApi().read({ connectionId, kind: "dataSource", id })).data,
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const mappings = useQuery({
    queryKey: ["notion", "mapping-state", connectionId],
    queryFn: () => notionApi().state(),
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const mapping = mappings.data?.mappings.find(
    (item) =>
      item.enabled &&
      item.connectionId === connectionId &&
      item.dataSourceId.replaceAll("-", "") === id.replaceAll("-", ""),
  );
  const columns = notionProperties(schema.data ?? {});
  const status =
    columns.find(
      (column) =>
        column.id === mapping?.fields.status?.id && ["status", "select"].includes(column.type),
    ) ?? columns.find((column) => ["status", "select"].includes(column.type));
  const date =
    columns.find((column) => column.id === mapping?.fields.due?.id && column.type === "date") ??
    columns.find((column) => column.type === "date");
  const start =
    columns.find((column) => column.id === mapping?.fields.start?.id && column.type === "date") ??
    date;
  const sprint = columns.find(
    (column) => column.id === mapping?.fields.sprint?.id && column.type === "relation",
  );
  const sprintSource = notionString(notionObject(sprint?.schema.relation).data_source_id);
  const statusOptions = notionOptions(status);
  const query = useQuery({
    queryKey: [
      "notion",
      "records",
      connectionId,
      id,
      cursor,
      filter,
      statusFilter,
      sortKey,
      descending,
    ],
    enabled: Boolean(schema.data),
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async () => {
      const clauses: NotionObject[] = [];
      const titleColumn = columns.find((column) => column.type === "title");
      if (filter.trim() && titleColumn)
        clauses.push({ property: titleColumn.id, title: { contains: filter.trim() } });
      if (statusFilter && status) {
        const option = statusOptions.find((value) => value.value === statusFilter);
        if (option) clauses.push({ property: status.id, [status.type]: { equals: option.label } });
      }
      const sort =
        sortKey === "title" ? titleColumn?.id : columns.find((column) => column.id === sortKey)?.id;
      const data = (
        await notionApi().read({
          connectionId,
          kind: "query",
          id,
          pageSize: 50,
          ...(cursor ? { cursor } : {}),
          ...(clauses.length
            ? { filter: clauses.length === 1 ? clauses[0]! : { and: clauses } }
            : {}),
          ...(sort
            ? { sorts: [{ property: sort, direction: descending ? "descending" : "ascending" }] }
            : {}),
        })
      ).data;
      if (
        !Array.isArray(data.results) ||
        typeof data.has_more !== "boolean" ||
        (data.has_more && !notionString(data.next_cursor))
      )
        throw new Error(
          "Notion returned an incomplete record page. Existing drafts are preserved.",
        );
      return data;
    },
  });

  const all = notionArray(query.data?.results).map(notionObject);
  const records = all
    .filter((page) => {
      const matchesText = notionTitle(page)
        .toLocaleLowerCase()
        .includes(filter.toLocaleLowerCase());
      return matchesText && (!statusFilter || statusId(page, status) === statusFilter);
    })
    .toSorted((a, b) => {
      const left =
        sortKey === "title"
          ? notionTitle(a)
          : notionPropertyLabel(
              property(
                a,
                columns.find((column) => column.id === sortKey),
              ),
            );
      const right =
        sortKey === "title"
          ? notionTitle(b)
          : notionPropertyLabel(
              property(
                b,
                columns.find((column) => column.id === sortKey),
              ),
            );
      return left.localeCompare(right, undefined, { numeric: true }) * (descending ? -1 : 1);
    });
  const shown = columns.filter(
    (column) =>
      column.type !== "title" &&
      (visibleIds === null
        ? columns
            .filter((item) => item.type !== "title")
            .slice(0, 6)
            .some((item) => item.id === column.id)
        : visibleIds.includes(column.id)),
  );
  const selectedPage = (pageId: string) => all.find((page) => notionString(page.id) === pageId);
  const open = (page: NotionObject) => (
    <Button
      variant="ghost"
      className="max-w-full justify-start truncate text-left"
      onClick={() => onOpen(notionString(page.id), "page")}
    >
      {notionTitle(page)}
    </Button>
  );

  const save = async (page: NotionObject, column: NotionPropertyDescriptor, value: unknown) => {
    const original = property(page, column);
    if (original.type !== column.type || original.has_more === true)
      throw new Error("The property is incomplete or its schema changed. Reload before editing.");
    await action.write({
      connectionId,
      kind: "updatePage",
      id: notionString(page.id),
      base: notionPropertySnapshot(page.properties, [column.id]),
      changes: { [column.id]: { [column.type]: value } },
    });
    await query.refetch();
    setEditing(null);
  };
  const saveStatus = (page: NotionObject, target: string) =>
    void action.run(async () => {
      if (
        !status ||
        (!statusOptions.some((option) => option.value === target) &&
          !(status.type === "select" && target === ""))
      )
        throw new Error("Choose a valid status from this source.");
      if (statusId(page, status) === target) return;
      await save(page, status, target ? { id: target } : null);
    });
  const saveDate = (page: NotionObject, target: string) =>
    void action.run(async () => {
      if (!date) throw new Error("Choose a calendar date property.");
      await save(page, date, moveNotionDate(property(page, date), target));
    });
  const saveEdit = () =>
    void action.run(async () => {
      if (!editing) return;
      const page = editing.page;
      const column = columns.find((candidate) => candidate.id === editing.propertyId);
      if (!page || !column) throw new Error("The selected record is no longer loaded.");
      const original = property(page, column);
      let value: unknown;
      if (column.type === "title" || column.type === "rich_text") {
        if (!isPlainNotionText(original[column.type]))
          throw new Error(
            "Formatted rich text must be edited as individual runs in the page editor.",
          );
        value = plainNotionText(editing.value);
      } else if (column.type === "number") {
        value = editing.value.trim() === "" ? null : Number(editing.value);
        if (value !== null && (!Number.isFinite(value) || editing.value.trim() === ""))
          throw new Error("Enter a valid number.");
      } else if (column.type === "date") {
        if (!safeDateOnly(original) || (editing.value && dateKey(editing.value) !== editing.value))
          throw new Error(
            "Only complete date-only values are editable here. Use the property editor for timed dates.",
          );
        value = editing.value ? moveNotionDate(original, editing.value) : null;
      } else if (column.type === "checkbox") value = editing.value === "true";
      else if (column.type === "status" || column.type === "select") {
        if (
          !notionOptions(column).some((option) => option.value === editing.value) &&
          !(column.type === "select" && editing.value === "")
        )
          throw new Error("That option no longer exists in Notion.");
        value = editing.value ? { id: editing.value } : null;
      } else throw new Error("Edit this complex property in the task or page editor.");
      await save(page, column, value);
    });
  const edit = (page: NotionObject, column: NotionPropertyDescriptor) => {
    const raw = property(page, column);
    if (
      raw.has_more === true ||
      !["title", "rich_text", "number", "date", "checkbox", "select", "status"].includes(
        column.type,
      )
    )
      return null;
    if (["title", "rich_text"].includes(column.type) && !isPlainNotionText(raw[column.type]))
      return null;
    if (column.type === "date" && !safeDateOnly(raw)) return null;
    const value =
      column.type === "select" || column.type === "status"
        ? notionString(notionObject(raw[column.type]).id)
        : column.type === "date"
          ? notionString(notionObject(raw.date).start).slice(0, 10)
          : column.type === "checkbox"
            ? String(raw.checkbox === true)
            : column.type === "number"
              ? typeof raw.number === "number"
                ? String(raw.number)
                : ""
              : notionText(raw[column.type]);
    return (
      <Button
        size="sm"
        variant="ghost"
        disabled={action.pending || action.awaitingConfirmation}
        aria-label={"Edit " + column.label + " for " + notionTitle(page)}
        className="max-w-56 justify-start truncate"
        onClick={() =>
          setEditing({
            pageId: notionString(page.id),
            propertyId: column.id,
            value,
            page: structuredClone(page),
          })
        }
      >
        {notionPropertyLabel(raw) || "—"}
      </Button>
    );
  };
  const updatePage = (page: NotionObject, column: NotionPropertyDescriptor) => {
    const active = editing?.pageId === notionString(page.id) && editing.propertyId === column.id;
    if (!active || !editing)
      return (
        edit(page, column) ?? (
          <span className="text-muted-foreground">
            {notionPropertyLabel(property(page, column)) || "—"}
          </span>
        )
      );
    const options =
      column.type === "status" || column.type === "select" ? notionOptions(column) : [];
    return (
      <div className="flex min-w-36 items-center gap-1">
        {options.length ? (
          <NotionSelect
            label={"Edit " + column.label}
            value={editing.value}
            onChange={(value) =>
              setEditing((current) => (current ? { ...current, value } : current))
            }
            options={[
              ...(column.type === "select" ? [{ value: "", label: "None" }] : []),
              ...options,
            ]}
            disabled={action.pending}
          />
        ) : column.type === "checkbox" ? (
          <Checkbox
            checked={editing.value === "true"}
            onCheckedChange={(checked) =>
              setEditing((current) =>
                current ? { ...current, value: String(checked === true) } : current,
              )
            }
            disabled={action.pending}
          />
        ) : (
          <Input
            aria-label={"Edit " + column.label}
            type={column.type === "date" ? "date" : column.type === "number" ? "number" : "text"}
            value={editing.value}
            onChange={(event) =>
              setEditing((current) =>
                current ? { ...current, value: event.target.value } : current,
              )
            }
            disabled={action.pending}
          />
        )}
        <Button size="sm" onClick={saveEdit} disabled={action.pending}>
          Save
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setEditing(null)}
          disabled={action.pending}
        >
          Cancel
        </Button>
      </div>
    );
  };
  const dateFor = (page: NotionObject) => dateKey(notionObject(property(page, date).date).start);
  const rangeFor = (page: NotionObject) => {
    const first = notionObject(property(page, start).date);
    const last = notionObject(property(page, date).date);
    const from = dateKey(first.start) || dateFor(page);
    const to = dateKey(first.end) || dateKey(last.end) || dateKey(last.start) || from;
    return { from, to: to < from ? from : to };
  };
  const shift = (direction: number) =>
    setAnchor((value) =>
      advance(
        value,
        direction * (view === "timeline" ? timelineDays : calendarMode === "week" ? 7 : 1),
        view === "timeline" || calendarMode === "week" ? "day" : "month",
      ),
    );
  const displayRange =
    view === "calendar" && calendarMode === "week"
      ? startOfWeek(anchor)
      : new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
  const firstDay =
    view === "calendar" && calendarMode === "week" ? displayRange : startOfWeek(displayRange);
  const calendarDays = Array.from({ length: calendarMode === "week" ? 7 : 42 }, (_, index) =>
    advance(firstDay, index, "day"),
  );
  const timelineStart = dayString(anchor);
  const groupStatus = (page: NotionObject) => statusId(page, status);

  return (
    <div className="space-y-4">
      <h2 className="text-ui-lg font-semibold">
        {schema.data ? notionTitle(schema.data) : "Database"}
      </h2>
      <NotionError
        message={
          schema.error?.message ?? query.error?.message ?? mappings.error?.message ?? action.error
        }
      />
      <NotionReceiptNotice active={action.awaitingConfirmation} />
      {propertyPage && schema.data ? (
        <NotionRecordPropertyEditor
          connectionId={connectionId}
          source={schema.data}
          page={propertyPage}
          onClose={() => setPropertyPage(null)}
          onSaved={() => void query.refetch()}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <NotionSelect
          label="Synara record view"
          value={view}
          onChange={(value) => {
            if (guard?.mayLeave() !== false) setView(value as RecordView);
          }}
          options={(
            [
              ["table", "Table"],
              ["list", "List"],
              ["board", "Board"],
              ["calendar", "Calendar"],
              ["timeline", "Timeline"],
              ["sprints", "Sprints"],
            ] as const
          ).map(([value, label]) => ({ value, label }))}
        />
        <Input
          aria-label="Search database record titles"
          placeholder="Search this database"
          value={filter}
          maxLength={200}
          onChange={(event) => {
            if (guard?.mayLeave() !== false) {
              setFilter(event.target.value);
              setCursor(undefined);
            }
          }}
        />
        {statusOptions.length ? (
          <NotionSelect
            label="Filter by status"
            value={statusFilter}
            onChange={(value) => {
              if (guard?.mayLeave() !== false) {
                setStatusFilter(value);
                setCursor(undefined);
              }
            }}
            options={[{ value: "", label: "All statuses" }, ...statusOptions]}
          />
        ) : null}
        <NotionSelect
          label="Sort records"
          value={sortKey}
          onChange={(value) => {
            if (guard?.mayLeave() !== false) {
              setSortKey(value);
              setCursor(undefined);
            }
          }}
          options={[
            { value: "title", label: "Title" },
            ...columns
              .filter((column) => column.type !== "title")
              .map((column) => ({ value: column.id, label: column.label })),
          ]}
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            if (guard?.mayLeave() !== false) {
              setDescending((value) => !value);
              setCursor(undefined);
            }
          }}
          aria-label="Toggle sort direction"
        >
          {descending ? "Z → A" : "A → Z"}
        </Button>
      </div>
      <p className="text-ui-sm text-muted-foreground">
        Synara-native views, not Notion saved-view configurations. Search, status filters and
        sorting run against the authorized database API. {records.length} matching records
        {query.data?.has_more ? "; additional records are on the next API page" : ""}. Dragging and
        edits require valid, fully loaded properties.
      </p>
      {query.isPending ? (
        <p role="status" className="text-ui text-muted-foreground">
          Loading Notion records…
        </p>
      ) : null}

      {view === "table" ? (
        <div className="space-y-2">
          <details className="rounded-lg border border-border p-2">
            <summary className="cursor-pointer text-ui">Visible columns</summary>
            <div className="mt-2 flex flex-wrap gap-3">
              {columns
                .filter((column) => column.type !== "title")
                .map((column) => (
                  <label key={column.id} className="flex items-center gap-2 text-ui-sm">
                    <Checkbox
                      checked={shown.some((item) => item.id === column.id)}
                      onCheckedChange={(checked) =>
                        setVisibleIds((current) => {
                          const previous =
                            current ??
                            columns
                              .filter((item) => item.type !== "title")
                              .slice(0, 6)
                              .map((item) => item.id);
                          return checked
                            ? [...new Set([...previous, column.id])]
                            : previous.filter((value) => value !== column.id);
                        })
                      }
                    />
                    {column.label}
                  </label>
                ))}
            </div>
          </details>
          <div className="overflow-auto rounded-xl border border-border">
            <table className="w-full text-left text-ui">
              <thead>
                <tr className="bg-muted/40">
                  <th scope="col" className="p-2">
                    Record
                  </th>
                  {shown.map((column) => (
                    <th scope="col" className="p-2" key={column.id}>
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {records.map((page) => (
                  <tr key={notionString(page.id)} className="border-t border-border">
                    <td className="p-2">
                      <div className="flex items-center gap-1">
                        {open(page)}
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={"Edit properties for " + notionTitle(page)}
                          onClick={() => setPropertyPage(structuredClone(page))}
                        >
                          Properties
                        </Button>
                      </div>
                    </td>
                    {shown.map((column) => (
                      <td className="max-w-80 p-2" key={column.id}>
                        {["title", "rich_text", "relation", "people", "multi_select"].includes(
                          column.type,
                        ) ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="max-w-56 truncate"
                            onClick={() => setPropertyPage(structuredClone(page))}
                          >
                            {notionPropertyLabel(property(page, column)) || "Edit properties"}
                          </Button>
                        ) : (
                          updatePage(page, column)
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {view === "list" ? (
        <div className="divide-y divide-border rounded-xl border border-border">
          {records.map((page) => (
            <div
              key={notionString(page.id)}
              className="flex flex-wrap items-center justify-between gap-2 p-2"
            >
              {open(page)}
              <span className="text-ui-sm text-muted-foreground">
                {[status, date]
                  .filter((item): item is NotionPropertyDescriptor => Boolean(item))
                  .map((column) => notionPropertyLabel(property(page, column)))
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {view === "board" ? (
        !status || !statusOptions.length ? (
          <p className="text-ui text-muted-foreground">
            Map or create a status/select property in Notion to use the board.
          </p>
        ) : (
          <div className="flex gap-3 overflow-x-auto pb-3">
            {[
              ...(status.type === "select" ? [{ value: "", label: "No status" }] : []),
              ...statusOptions,
            ].map((option) => (
              <section
                key={option.value}
                aria-label={option.label}
                className="min-w-60 flex-1 rounded-xl border border-border bg-muted/20 p-3"
                onDragOver={(event) => {
                  if (dragId && !action.pending) event.preventDefault();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const page = dragId ? selectedPage(dragId) : null;
                  setDragId(null);
                  if (page) saveStatus(page, option.value);
                }}
              >
                <h3 className="mb-3 text-ui font-medium">
                  {option.label}{" "}
                  <span className="text-muted-foreground">
                    {records.filter((page) => groupStatus(page) === option.value).length}
                  </span>
                </h3>
                {records
                  .filter((page) => groupStatus(page) === option.value)
                  .map((page) => (
                    <article
                      key={notionString(page.id)}
                      draggable={!action.pending && property(page, status).has_more !== true}
                      onDragStart={() => setDragId(notionString(page.id))}
                      onDragEnd={() => setDragId(null)}
                      className="mb-2 space-y-2 rounded-lg border border-border bg-background p-2"
                    >
                      {open(page)}
                      <div className="flex flex-wrap gap-2 text-ui-xs text-muted-foreground">
                        {date ? notionPropertyLabel(property(page, date)) : null}
                        {mapping?.fields.points ? " · " + points(page, mapping) + " pts" : null}
                      </div>
                      <NotionSelect
                        label={"Move " + notionTitle(page) + " to status"}
                        value={statusId(page, status)}
                        onChange={(next) => saveStatus(page, next)}
                        options={[
                          ...(status.type === "select" ? [{ value: "", label: "No status" }] : []),
                          ...statusOptions,
                        ]}
                        disabled={action.pending}
                      />
                    </article>
                  ))}
              </section>
            ))}
          </div>
        )
      ) : null}

      {view === "calendar" ? (
        !date ? (
          <p className="text-ui text-muted-foreground">
            A date property is needed to render the calendar.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => shift(-1)}>
                Previous
              </Button>
              <h3 className="text-ui font-medium">
                {displayRange.toLocaleDateString(undefined, {
                  month: "long",
                  year: "numeric",
                  timeZone: "UTC",
                })}
              </h3>
              <Button variant="outline" size="sm" onClick={() => shift(1)}>
                Next
              </Button>
              <NotionSelect
                label="Calendar range"
                value={calendarMode}
                onChange={(value) => setCalendarMode(value as "month" | "week")}
                options={[
                  { value: "month", label: "Month" },
                  { value: "week", label: "Week" },
                ]}
              />
            </div>
            <div className="grid grid-cols-7 gap-px rounded-lg border border-border bg-border">
              {WEEKDAYS.map((day) => (
                <div key={day} className="bg-muted p-2 text-center text-ui-sm font-medium">
                  {day}
                </div>
              ))}
              {calendarDays.map((day) => {
                const key = dayString(day);
                return (
                  <div
                    key={key}
                    className="min-h-28 min-w-0 space-y-1 bg-background p-1.5"
                    onDragOver={(event) => {
                      if (dragId) event.preventDefault();
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      const page = dragId ? selectedPage(dragId) : undefined;
                      setDragId(null);
                      if (page) saveDate(page, key);
                    }}
                  >
                    <div
                      className={
                        day.getUTCMonth() === anchor.getUTCMonth()
                          ? "text-ui-sm font-medium"
                          : "text-ui-sm text-muted-foreground"
                      }
                    >
                      {day.getUTCDate()}
                    </div>
                    {records
                      .filter((page) => {
                        const range = notionObject(property(page, date).date);
                        const from = dateKey(range.start);
                        const to = dateKey(range.end) || from;
                        return from && key >= from && key <= to;
                      })
                      .map((page) => (
                        <div
                          key={notionString(page.id)}
                          draggable={safeDateOnly(property(page, date)) && !action.pending}
                          onDragStart={() => setDragId(notionString(page.id))}
                          onDragEnd={() => setDragId(null)}
                          className="flex min-w-0 flex-col items-start gap-1 rounded bg-muted p-1 text-ui-xs"
                        >
                          {open(page)}
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            aria-label={"Edit dates for " + notionTitle(page)}
                            disabled={action.pending || action.awaitingConfirmation}
                            onClick={() => setPropertyPage(structuredClone(page))}
                          >
                            Dates
                          </Button>
                        </div>
                      ))}
                  </div>
                );
              })}
            </div>
            {records.some((page) => !dateFor(page)) ? (
              <p className="text-ui-sm text-muted-foreground">
                {records.filter((page) => !dateFor(page)).length} undated records are not placed on
                the grid.
              </p>
            ) : null}
          </div>
        )
      ) : null}

      {view === "timeline" ? (
        !date ? (
          <p className="text-ui text-muted-foreground">
            A date property is needed for the timeline.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => shift(-1)}>
                Previous
              </Button>
              <span className="text-ui font-medium">
                {timelineStart} · {dayString(advance(anchor, timelineDays - 1, "day"))}
              </span>
              <Button variant="outline" size="sm" onClick={() => shift(1)}>
                Next
              </Button>
              <NotionSelect
                label="Timeline zoom"
                value={String(timelineDays)}
                onChange={(value) => setTimelineDays(Number(value))}
                options={[
                  { value: "14", label: "2 weeks" },
                  { value: "30", label: "Month" },
                  { value: "90", label: "Quarter" },
                ]}
              />
            </div>
            <div className="overflow-x-auto rounded-xl border border-border">
              <div className="min-w-[36rem]">
                <div className="flex border-b border-border bg-muted/30">
                  <span className="w-48 shrink-0 p-2 text-ui-sm font-medium">Record</span>
                  <div className="flex flex-1 justify-between p-2 text-ui-xs text-muted-foreground">
                    <span>{timelineStart}</span>
                    <span>{dayString(advance(anchor, timelineDays - 1, "day"))}</span>
                  </div>
                </div>
                {records
                  .filter((page) => rangeFor(page).from)
                  .map((page) => {
                    const range = rangeFor(page);
                    const offset = (Date.parse(range.from) - Date.parse(timelineStart)) / DAY_MS;
                    const days = Math.max(
                      1,
                      (Date.parse(range.to) - Date.parse(range.from)) / DAY_MS + 1,
                    );
                    const left = Math.max(0, (offset / timelineDays) * 100);
                    const right = Math.min(100, ((offset + days) / timelineDays) * 100);
                    return (
                      <div
                        key={notionString(page.id)}
                        className="flex min-h-12 items-center border-b border-border"
                      >
                        <div className="w-48 shrink-0 truncate px-2">{open(page)}</div>
                        <div className="relative h-9 flex-1 bg-muted/20">
                          {right > left ? (
                            <button
                              type="button"
                              aria-label={
                                "Edit dates for " +
                                notionTitle(page) +
                                ": " +
                                range.from +
                                " to " +
                                range.to
                              }
                              title={range.from + " to " + range.to}
                              disabled={action.pending || action.awaitingConfirmation}
                              onClick={() => setPropertyPage(structuredClone(page))}
                              className="absolute top-2 h-5 rounded-md bg-primary/60 focus-visible:outline-2 focus-visible:outline-ring"
                              style={{
                                left: left + "%",
                                width: Math.max(0.75, right - left) + "%",
                              }}
                            />
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
            {records.some((page) => !rangeFor(page).from) ? (
              <p className="text-ui-sm text-muted-foreground">
                Undated records are omitted from the timeline.
              </p>
            ) : null}
          </div>
        )
      ) : null}

      {view === "sprints" ? (
        mapping && schema.data ? (
          <NotionPlanningPanel
            connectionId={connectionId}
            mapping={mapping}
            source={schema.data}
            records={records}
            partial={Boolean(cursor || query.data?.has_more)}
            onOpen={onOpen}
            onSaved={() => void query.refetch()}
          />
        ) : (
          <p className="text-ui text-muted-foreground">
            Map this data source to Synara Tasks to use sprint planning.
          </p>
        )
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={!cursor || editing !== null}
          onClick={() => {
            if (guard?.mayLeave() !== false) setCursor(undefined);
          }}
        >
          First page
        </Button>
        {query.data?.has_more === true ? (
          <Button
            variant="outline"
            disabled={editing !== null}
            onClick={() => {
              if (guard?.mayLeave() !== false) setCursor(notionString(query.data?.next_cursor));
            }}
          >
            Next API page
          </Button>
        ) : null}
      </div>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(async () => {
            const titleColumn = columns.find((column) => column.type === "title");
            if (!titleColumn) throw new Error("No title property is available.");
            await action.write({
              connectionId,
              kind: "createPage",
              id,
              base: {},
              changes: { properties: { [titleColumn.id]: { title: plainNotionText(newTitle) } } },
            });
            setNewTitle("");
            await query.refetch();
          });
        }}
      >
        <Input
          aria-label="New record title"
          placeholder="New record title"
          maxLength={500}
          value={newTitle}
          disabled={action.pending || action.awaitingConfirmation}
          onChange={(event) => setNewTitle(event.target.value)}
        />
        <Button type="submit" disabled={!newTitle.trim() || action.pending}>
          Create record
        </Button>
        {newTitle ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => setNewTitle("")}
            disabled={action.pending}
          >
            Discard
          </Button>
        ) : null}
      </form>
    </div>
  );
}
