/** Lossless data helpers for the Notion provider. No credentials or orchestration. */
import type {
  NotionField,
  NotionFieldMap,
  NotionMapping,
  NotionObject,
  NotionPropertyRef,
  NotionTodoReference,
  Todo,
  TodoPriority,
} from "@synara/contracts";
export function notionObject(value: unknown): NotionObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as NotionObject)
    : {};
}
export function notionArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
export function notionString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
export function notionText(value: unknown): string {
  return notionArray(value)
    .map((item) => {
      const part = notionObject(item);
      return (
        notionString(part.plain_text) ||
        notionString(notionObject(part.text).content) ||
        notionString(notionObject(part.equation).expression)
      );
    })
    .join("");
}
export function notionTitle(resource: NotionObject): string {
  if (Array.isArray(resource.title)) return notionText(resource.title);
  for (const value of Object.values(notionObject(resource.properties))) {
    const property = notionObject(value);
    if (property.type === "title") return notionText(property.title);
  }
  return "Untitled";
}
export function notionProperty(
  properties: unknown,
  ref: NotionPropertyRef | undefined,
): NotionObject {
  return ref
    ? (Object.values(notionObject(properties))
        .map(notionObject)
        .find((property) => property.id === ref.id) ?? {})
    : {};
}
export function notionRelationIds(value: unknown): string[] {
  return notionArray(value)
    .map((item) => notionString(notionObject(item).id))
    .filter(Boolean);
}
export function notionDate(value: unknown): string | null {
  const start = notionString(notionObject(value).start);
  return /^\d{4}-\d{2}-\d{2}(T.*)?$/.test(start) && Number.isFinite(Date.parse(start))
    ? start
    : null;
}
export function notionResourceId(value: string): string {
  if (!/^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(value))
    throw new Error("Invalid Notion resource ID.");
  const hex = value.replaceAll("-", "").toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function notionPageUrl(page: NotionObject): string {
  try {
    const url = new URL(notionString(page.url));
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      ["notion.so", "notion.com", "notion.site"].some(
        (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
      )
    )
      return url.href;
  } catch {
    /* Fall back to a validated provider-owned URL. */
  }
  return `https://www.notion.so/${notionResourceId(notionString(page.id)).replaceAll("-", "")}`;
}
export function safeNotionLink(value: unknown): string | null {
  try {
    const url = new URL(notionString(value));
    return ["https:", "http:", "mailto:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export const NOTION_FIELD_TYPES: Record<NotionField, readonly string[]> = {
  title: ["title"],
  description: ["rich_text"],
  status: ["status", "select", "checkbox"],
  priority: ["select", "status"],
  assignee: ["people"],
  due: ["date"],
  start: ["date"],
  project: ["relation", "select", "multi_select"],
  sprint: ["relation", "select", "multi_select"],
  epic: ["relation", "select", "multi_select"],
  milestone: ["relation", "select", "date"],
  dependencies: ["relation"],
  subtasks: ["relation"],
  points: ["number"],
};
export function suggestNotionFields(schema: NotionObject): NotionFieldMap | null {
  const title = Object.values(notionObject(schema.properties))
    .map(notionObject)
    .find((property) => property.type === "title");
  return title && notionString(title.id)
    ? { title: { id: notionString(title.id), type: "title" } }
    : null;
}
export function validateNotionMapping(mapping: NotionMapping, schema: NotionObject): void {
  const properties = Object.values(notionObject(schema.properties)).map(notionObject);
  const usedIds = new Map<string, NotionField>();
  for (const [key, ref] of Object.entries(mapping.fields)) {
    if (!ref) continue;
    const field = key as NotionField;
    const property = properties.find((candidate) => candidate.id === ref.id);
    if (!property || property.type !== ref.type || !NOTION_FIELD_TYPES[field]?.includes(ref.type))
      throw new Error(
        `The ${field} mapping no longer matches this data source. Review its property mapping.`,
      );
    const previous = usedIds.get(ref.id);
    const sharedRange =
      ref.type === "date" &&
      ((previous === "start" && field === "due") || (previous === "due" && field === "start"));
    if (previous && !sharedRange)
      throw new Error("Map each property to one task field, except a shared start/due date range.");
    usedIds.set(ref.id, field);
  }
  const status = notionProperty(schema.properties, mapping.fields.status);
  if (mapping.fields.status && mapping.fields.status.type !== "checkbox") {
    const ids = new Set(
      notionArray(notionObject(status[mapping.fields.status.type]).options).map((option) =>
        notionString(notionObject(option).id),
      ),
    );
    if (
      mapping.completedStatusIds.some((id) => !ids.has(id)) ||
      (mapping.reopenedStatusId !== null &&
        (!ids.has(mapping.reopenedStatusId) ||
          mapping.completedStatusIds.includes(mapping.reopenedStatusId)))
    )
      throw new Error(
        "Choose actual completion options and a distinct reopening option from this source.",
      );
  }
  if (mapping.fields.priority) {
    const property = notionProperty(schema.properties, mapping.fields.priority);
    const ids = new Set(
      notionArray(notionObject(property[mapping.fields.priority.type]).options).map((option) =>
        notionString(notionObject(option).id),
      ),
    );
    const assigned = Object.entries(mapping.priorityOptions);
    if (assigned.some(([id]) => !ids.has(id)))
      throw new Error("A mapped priority option no longer exists.");
    if (new Set(assigned.map(([, priority]) => priority)).size !== assigned.length)
      throw new Error("Map each Synara priority to at most one Notion option.");
  }
}
function propertyIds(property: NotionObject): string[] {
  if (property.type === "relation" || property.type === "multi_select")
    return notionRelationIds(property[notionString(property.type)]);
  const id = property.type === "select" ? notionString(notionObject(property.select).id) : "";
  return id ? [id] : [];
}
export function isPlainNotionText(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((raw) => {
      const part = notionObject(raw);
      const annotations = notionObject(part.annotations);
      return (
        (!part.type || part.type === "text") &&
        typeof notionObject(part.text).content === "string" &&
        !notionObject(part.text).link &&
        !["bold", "italic", "strikethrough", "underline", "code"].some(
          (key) => annotations[key] === true,
        ) &&
        (!annotations.color || annotations.color === "default")
      );
    })
  );
}
export function plainNotionText(value: string): NotionObject[] {
  const pieces: NotionObject[] = [];
  let chunk = "";
  for (const character of value) {
    if (chunk.length + character.length > 2_000) {
      pieces.push({ type: "text", text: { content: chunk } });
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) pieces.push({ type: "text", text: { content: chunk } });
  return pieces;
}
export interface NotionTaskProjection {
  title: string;
  notes: string;
  priority: TodoPriority;
  dueDate: string | null;
  completed: boolean;
  external: NotionTodoReference;
}
export function projectNotionTask(
  page: NotionObject,
  mapping: NotionMapping,
  workspaceName: string,
): NotionTaskProjection {
  const read = (field: NotionField) => notionProperty(page.properties, mapping.fields[field]);
  const status = read("status");
  const option = notionObject(status[notionString(status.type)]);
  const statusId =
    status.type === "checkbox" ? String(status.checkbox === true) : notionString(option.id) || null;
  const priority = read("priority");
  const priorityId = notionString(notionObject(priority[notionString(priority.type)]).id);
  const dueRange = notionObject(read("due").date);
  const due = notionDate({ ...dueRange, start: dueRange.end ?? dueRange.start });
  const points = read("points").number;
  const writableFields: NotionTodoReference["writableFields"][number][] = [];
  if (isPlainNotionText(read("title").title)) writableFields.push("title");
  if (mapping.fields.description && isPlainNotionText(read("description").rich_text))
    writableFields.push("notes");
  if (mapping.fields.priority) writableFields.push("priority");
  if (
    mapping.fields.due &&
    !dueRange.end &&
    !dueRange.time_zone &&
    !notionString(dueRange.start).includes("T")
  )
    writableFields.push("dueDate");
  if (
    mapping.fields.status &&
    (mapping.fields.status.type === "checkbox" ||
      (mapping.completedStatusIds.length === 1 && mapping.reopenedStatusId !== null))
  )
    writableFields.push("completed");
  return {
    title: notionText(read("title").title) || "Untitled",
    notes: notionText(read("description").rich_text),
    priority: mapping.priorityOptions[priorityId] ?? "none",
    dueDate: due?.slice(0, 10) ?? null,
    completed:
      status.type === "checkbox"
        ? status.checkbox === true
        : statusId !== null && mapping.completedStatusIds.includes(statusId),
    external: {
      provider: "notion",
      connectionId: mapping.connectionId,
      mappingId: mapping.id,
      dataSourceId: mapping.dataSourceId,
      pageId: notionResourceId(notionString(page.id)),
      url: notionPageUrl(page),
      workspaceName,
      status:
        status.type === "checkbox"
          ? status.checkbox === true
            ? "Done"
            : "To do"
          : notionString(option.name) || null,
      statusId,
      assignees: notionArray(read("assignee").people).map(
        (value) => notionString(notionObject(value).name) || notionString(notionObject(value).id),
      ),
      assigneeIds: notionRelationIds(read("assignee").people),
      sprintIds: propertyIds(read("sprint")),
      epicIds: propertyIds(read("epic")),
      milestoneIds: propertyIds(read("milestone")),
      dependencyIds: propertyIds(read("dependencies")),
      subtaskIds: propertyIds(read("subtasks")),
      startDate: notionDate(read("start").date) ?? (dueRange.end ? notionDate(dueRange) : null),
      storyPoints: typeof points === "number" && Number.isFinite(points) ? points : null,
      syncState: "synced",
      syncMessage: null,
      writableFields,
    },
  };
}
export function notionTodoPatch(
  page: NotionObject,
  mapping: NotionMapping,
  patch: Partial<Pick<Todo, "title" | "notes" | "priority" | "dueDate">> & { completed?: boolean },
): NotionObject {
  const properties: Record<string, unknown> = {};
  const write = (field: NotionField, value: unknown) => {
    const ref = mapping.fields[field];
    if (!ref) throw new Error(`Configure a ${field} property before editing this field.`);
    if (notionProperty(page.properties, ref).type !== ref.type)
      throw new Error("The source schema changed. Review its mapping.");
    properties[ref.id] = { [ref.type]: value };
  };
  const text = (field: "title" | "description", value: string) => {
    const ref = mapping.fields[field];
    if (!isPlainNotionText(notionProperty(page.properties, ref)[ref?.type ?? ""]))
      throw new Error(
        "This field contains rich text. Edit its individual runs in page details to preserve formatting and mentions.",
      );
    write(field, plainNotionText(value));
  };
  if (patch.title !== undefined) text("title", patch.title);
  if (patch.notes !== undefined) text("description", patch.notes);
  if (patch.priority !== undefined) {
    const id = Object.entries(mapping.priorityOptions).find(
      ([, value]) => value === patch.priority,
    )?.[0];
    if (!id && patch.priority !== "none")
      throw new Error("Map this priority to a Notion option first.");
    write("priority", id ? { id } : null);
  }
  if (patch.dueDate !== undefined) {
    const current = notionObject(notionProperty(page.properties, mapping.fields.due).date);
    if (current.end || current.time_zone || notionString(current.start).includes("T"))
      throw new Error("Edit this date's time or range in page details.");
    write("due", patch.dueDate === null ? null : { start: patch.dueDate });
  }
  if (patch.completed !== undefined) {
    if (mapping.fields.status?.type === "checkbox") write("status", patch.completed);
    else {
      const id = patch.completed
        ? mapping.completedStatusIds.length === 1
          ? mapping.completedStatusIds[0]
          : undefined
        : mapping.reopenedStatusId;
      if (!id) throw new Error("Configure unambiguous completion and reopening options first.");
      write("status", { id });
    }
  }
  return properties;
}

/** A sprint plan must describe the actual relation target and its current API schema. */
export function validateNotionSprintPlan(
  mapping: NotionMapping,
  taskSource: NotionObject,
  sprintSource: NotionObject,
): void {
  const plan = mapping.sprintPlan;
  if (!plan) return;
  const relationRef = mapping.fields.sprint;
  if (relationRef?.type !== "relation")
    throw new Error("Sprint planning requires a relation-based Sprint field.");
  const relation = notionObject(notionProperty(taskSource.properties, relationRef).relation);
  if (
    notionResourceId(notionString(relation.data_source_id)) !==
      notionResourceId(plan.dataSourceId) ||
    notionResourceId(notionString(sprintSource.id)) !== notionResourceId(plan.dataSourceId)
  ) {
    throw new Error("The Sprint relation no longer targets the configured Notion data source.");
  }
  const props = Object.values(notionObject(sprintSource.properties)).map(notionObject);
  const matches = (field: NotionPropertyRef | null, types: readonly string[]) =>
    field === null ||
    props.some(
      (value) => value.id === field.id && value.type === field.type && types.includes(field.type),
    );
  if (
    !matches(plan.title, ["title"]) ||
    !matches(plan.start, ["date"]) ||
    !matches(plan.end, ["date"]) ||
    !matches(plan.status, ["status", "select"])
  ) {
    throw new Error("A sprint planning property no longer matches the target data source.");
  }
  if (plan.status) {
    const property = props.find((value) => value.id === plan.status?.id);
    const valid = new Set(
      notionArray(notionObject(property?.[plan.status.type]).options).map((raw) =>
        notionString(notionObject(raw).id),
      ),
    );
    if (plan.completedStatusIds.some((value) => !valid.has(value)))
      throw new Error("Select real completed-sprint status options.");
  } else if (plan.completedStatusIds.length)
    throw new Error("Map a sprint status property before selecting completed options.");
}

export function notionCanonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(notionCanonical).join(",")}]`;
  const object = notionObject(value);
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${notionCanonical(object[key])}`)
    .join(",")}}`;
}
export function notionPatchConflicts(
  base: NotionObject,
  remote: NotionObject,
  desired: NotionObject,
): string[] {
  return Object.keys(desired).filter(
    (key) =>
      notionCanonical(base[key]) !== notionCanonical(remote[key]) &&
      notionCanonical(remote[key]) !== notionCanonical(desired[key]),
  );
}
export function notionWritableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(notionWritableValue);
  if (value === null || typeof value !== "object") return value;
  const object = notionObject(value);
  if (object.object === "user" && typeof object.id === "string") return { id: object.id };
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(object)) {
    if (
      ["plain_text", "href", "object"].includes(key) ||
      (["name", "color"].includes(key) && typeof object.id === "string")
    )
      continue;
    result[key] = notionWritableValue(object[key]);
  }
  return result;
}
/** Comparison-only normalization. Never replace raw stored content with this representation. */
export function notionComparableValue(value: unknown, context = ""): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item) => notionComparableValue(item, context));
    if (["people", "relation", "multi_select"].includes(context))
      return items.sort((a, b) => notionCanonical(a).localeCompare(notionCanonical(b)));
    if (["title", "rich_text", "caption"].includes(context)) {
      const runs: unknown[] = [];
      for (const item of items) {
        const current = notionObject(item);
        const previous = notionObject(runs.at(-1));
        const currentText = notionObject(current.text);
        const previousText = notionObject(previous.text);
        const currentStyle = Object.fromEntries(
          Object.entries(current).filter(([key]) => key !== "text"),
        );
        const previousStyle = Object.fromEntries(
          Object.entries(previous).filter(([key]) => key !== "text"),
        );
        if (
          typeof currentText.content === "string" &&
          typeof previousText.content === "string" &&
          notionCanonical(currentStyle) === notionCanonical(previousStyle) &&
          notionCanonical(currentText.link) === notionCanonical(previousText.link)
        )
          runs[runs.length - 1] = {
            ...previous,
            text: { ...previousText, content: previousText.content + currentText.content },
          };
        else runs.push(item);
      }
      return runs;
    }
    return items;
  }
  if (value === null || typeof value !== "object") return value;
  const object = notionObject(value);
  if (
    (["people", "relation", "multi_select", "select", "status", "user"].includes(context) ||
      object.object === "user") &&
    typeof object.id === "string"
  ) {
    const id = object.id;
    return {
      id: /^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(id)
        ? notionResourceId(id)
        : id,
    };
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(object)) {
    if (
      ["plain_text", "href", "object"].includes(key) ||
      (key === "type" && typeof object.type === "string" && object[object.type] !== undefined)
    )
      continue;
    if (
      ((context === "date" && ["end", "time_zone"].includes(key)) ||
        (context === "text" && key === "link")) &&
      child == null
    )
      continue;
    if (context === "annotations" && (child === false || (key === "color" && child === "default")))
      continue;
    const normalized = notionComparableValue(child, key);
    if (key === "annotations" && Object.keys(notionObject(normalized)).length === 0) continue;
    result[key] = normalized;
  }
  return result;
}
export function notionPropertySnapshot(properties: unknown, ids: readonly string[]): NotionObject {
  const all = Object.values(notionObject(properties)).map(notionObject);
  const snapshot: Record<string, unknown> = {};
  for (const id of ids) {
    const property = all.find((value) => value.id === id);
    if (!property) continue;
    const type = notionString(property.type);
    snapshot[id] = { [type]: notionComparableValue(property[type], type) };
  }
  return snapshot;
}
export function notionPropertyLabel(raw: unknown): string {
  const property = notionObject(raw);
  const value = property[notionString(property.type)];
  switch (property.type) {
    case "title":
    case "rich_text":
      return notionText(value);
    case "select":
    case "status":
      return notionString(notionObject(value).name);
    case "multi_select":
      return notionArray(value)
        .map((item) => notionString(notionObject(item).name))
        .join(", ");
    case "people":
      return notionArray(value)
        .map((item) => notionString(notionObject(item).name) || notionString(notionObject(item).id))
        .join(", ");
    case "relation":
      return notionRelationIds(value).join(", ");
    case "date":
      return [notionString(notionObject(value).start), notionString(notionObject(value).end)]
        .filter(Boolean)
        .join(" – ");
    case "checkbox":
      return value === true ? "Yes" : "No";
    case "formula":
    case "rollup":
      return notionPropertyLabel(value);
    case "files":
      return notionArray(value)
        .map((item) => notionString(notionObject(item).name))
        .join(", ");
    default:
      return typeof value === "string" || typeof value === "number" ? String(value) : "";
  }
}
