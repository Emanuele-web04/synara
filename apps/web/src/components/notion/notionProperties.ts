import type {
  NotionField,
  NotionFieldMap,
  NotionMapping,
  NotionObject,
  NotionPropertyRef,
  ProjectId,
} from "@synara/contracts";
import {
  NOTION_FIELD_TYPES,
  notionArray,
  notionCanonical,
  notionComparableValue,
  notionObject,
  notionProperty,
  notionPropertySnapshot,
  notionResourceId,
  notionString,
  notionTitle,
  validateNotionMapping,
} from "@synara/shared/notion";

export interface NotionPropertyDescriptor {
  id: string;
  type: string;
  label: string;
  schema: NotionObject;
}

export function notionProperties(source: NotionObject): NotionPropertyDescriptor[] {
  return Object.entries(notionObject(source.properties))
    .map(([label, raw]) => {
      const schema = notionObject(raw);
      return { id: notionString(schema.id), type: notionString(schema.type), label, schema };
    })
    .filter((property) => property.id.length > 0);
}

export function notionOptions(property: NotionPropertyDescriptor | undefined) {
  return notionArray(notionObject(property?.schema[property.type]).options).flatMap((raw) => {
    const option = notionObject(raw);
    const value = notionString(option.id);
    return value ? [{ value, label: notionString(option.name) || value }] : [];
  });
}

export interface MappedNotionProperty extends NotionPropertyDescriptor {
  fields: NotionField[];
  original: NotionObject;
  readOnlyReason: string | null;
}

const EDITABLE_TYPES = new Set([
  "status",
  "select",
  "multi_select",
  "relation",
  "people",
  "number",
  "date",
  "checkbox",
]);

/** Never interpret a truncated relation or assignee list as a complete replacement value. */
export function notionPropertyReadOnlyReason(
  property: NotionObject,
  ref: NotionPropertyRef,
): string | null {
  if (property.type !== ref.type) return "The source schema changed. Review the property mapping.";
  if (!EDITABLE_TYPES.has(ref.type))
    return "Edit this content in the existing task or page editor.";
  if (!(ref.type in property)) return "Notion did not return this property's value.";
  if (
    property.has_more === true ||
    (ref.type === "people" && notionArray(property.people).length >= 25)
  ) {
    return "This property may be incomplete. Its values are preserved; edit it in Notion.";
  }
  if (["people", "relation", "multi_select"].includes(ref.type)) {
    try {
      ids(property[ref.type], ref.type !== "multi_select");
    } catch {
      return "Notion returned an incomplete or invalid selection list. Existing values are preserved.";
    }
  }
  if (ref.type === "date" && property.date !== null) {
    const date = notionObject(property.date);
    if (date.time_zone || !isDateOnly(date.start) || (date.end != null && !isDateOnly(date.end))) {
      return "This date includes a time or time zone. Its complete value is preserved.";
    }
  }
  return null;
}

export function mappedNotionProperties(
  mapping: NotionMapping,
  source: NotionObject,
  page: NotionObject,
): MappedNotionProperty[] {
  validateNotionMapping(mapping, source);
  const descriptors = notionProperties(source);
  const grouped = new Map<string, MappedNotionProperty>();
  for (const [name, ref] of Object.entries(mapping.fields)) {
    if (!ref) continue;
    const field = name as NotionField;
    if (field === "title" || field === "description") continue;
    const existing = grouped.get(ref.id);
    if (existing) {
      existing.fields.push(field);
      continue;
    }
    const descriptor = descriptors.find((property) => property.id === ref.id);
    if (!descriptor) continue;
    const original = notionProperty(page.properties, ref);
    grouped.set(ref.id, {
      ...descriptor,
      fields: [field],
      original,
      readOnlyReason: notionPropertyReadOnlyReason(original, ref),
    });
  }
  return [...grouped.values()];
}

function isDateOnly(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function ids(value: unknown, resources: boolean): { id: string }[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Choose at most 100 values.");
  const values = value.map((raw) => {
    const id = notionString(notionObject(raw).id);
    if (!id) throw new Error("Choose a value from the authorized source.");
    return { id: resources ? notionResourceId(id) : id };
  });
  if (new Set(values.map((value) => value.id)).size !== values.length)
    throw new Error("A value is selected more than once.");
  return values;
}

export function writablePropertyValue(property: MappedNotionProperty, value: unknown): unknown {
  switch (property.type) {
    case "status":
    case "select": {
      if (value === null) {
        if (property.type === "status")
          throw new Error("Choose a status; a Notion status cannot be cleared.");
        return null;
      }
      const id = notionString(notionObject(value).id);
      if (!notionOptions(property).some((option) => option.value === id))
        throw new Error("Choose an existing option from this source.");
      return { id };
    }
    case "multi_select": {
      const values = ids(value, false);
      const options = new Set(notionOptions(property).map((option) => option.value));
      if (values.some((item) => !options.has(item.id)))
        throw new Error("An option no longer exists in this source.");
      return values;
    }
    case "people":
    case "relation":
      return ids(value, true);
    case "number":
      if (value === null) return null;
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        (property.fields.includes("points") && value < 0)
      ) {
        throw new Error(
          "Enter a finite, non-negative story-point estimate, or clear the estimate.",
        );
      }
      return value;
    case "checkbox":
      if (typeof value !== "boolean") throw new Error("Choose a checked or unchecked value.");
      return value;
    case "date": {
      if (value === null) return null;
      const date = notionObject(value);
      if (
        !isDateOnly(date.start) ||
        (date.end != null && (!isDateOnly(date.end) || date.end < date.start)) ||
        date.time_zone
      ) {
        throw new Error("Choose valid dates with the end on or after the start.");
      }
      return { start: date.start, end: date.end ?? null, time_zone: null };
    }
    default:
      throw new Error("This property is read-only in the task editor.");
  }
}

/** Build a minimal patch against the frozen edit baseline, never against a background refetch. */
export function notionTaskPropertyPatch(
  mapping: NotionMapping,
  source: NotionObject,
  page: NotionObject,
  edits: NotionObject,
) {
  if (
    !mapping.enabled ||
    notionResourceId(notionString(notionObject(page.parent).data_source_id)) !==
      notionResourceId(mapping.dataSourceId)
  ) {
    throw new Error("This task no longer belongs to the enabled source mapping.");
  }
  const mapped = mappedNotionProperties(mapping, source, page);
  const changes: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(edits)) {
    const property = mapped.find((candidate) => candidate.id === id);
    if (
      !property ||
      !property.fields.every((field) => NOTION_FIELD_TYPES[field].includes(property.type))
    ) {
      throw new Error("Only explicitly mapped task properties can be edited here.");
    }
    if (property.readOnlyReason) throw new Error(property.readOnlyReason);
    const next = writablePropertyValue(property, value);
    if (
      notionCanonical(notionComparableValue(next, property.type)) !==
      notionCanonical(notionComparableValue(property.original[property.type], property.type))
    ) {
      changes[id] = { [property.type]: next };
    }
  }
  return { base: notionPropertySnapshot(page.properties, Object.keys(changes)), changes };
}

export interface NotionMappingEdits {
  id: string;
  connectionId: string;
  name: string;
  projectId: ProjectId | null;
  fields: NotionFieldMap;
  completedStatusIds: readonly string[];
  reopenedStatusId: string | null;
  priorityOptions: NotionMapping["priorityOptions"];
  agentAccess?: "none" | "read" | "write";
  sprintPlan?: NotionMapping["sprintPlan"];
}

export function editNotionMapping(
  existing: NotionMapping | undefined,
  source: NotionObject,
  edits: NotionMappingEdits,
): NotionMapping {
  if (
    existing &&
    (existing.id !== edits.id ||
      existing.connectionId !== edits.connectionId ||
      notionResourceId(existing.dataSourceId) !== notionResourceId(notionString(source.id)))
  ) {
    throw new Error("Create a new mapping to use a different workspace or data source.");
  }
  const mapping: NotionMapping = {
    ...existing,
    ...edits,
    dataSourceId: notionResourceId(notionString(source.id)),
    agentAccess: edits.agentAccess ?? existing?.agentAccess ?? "none",
    ...(edits.sprintPlan === undefined ? {} : { sprintPlan: edits.sprintPlan }),
    enabled: existing?.enabled ?? true,
  };
  validateNotionMapping(mapping, source);
  return mapping;
}

/** Validate related resources before rendering them; foreign or malformed pages never become choices. */
export function notionReferenceChoices(
  page: NotionObject,
  people: boolean,
  sourceId: string,
): { value: string; label: string }[] {
  if (!Array.isArray(page.results)) throw new Error("Notion returned an incomplete choice list.");
  const expected = people ? null : notionResourceId(sourceId);
  return page.results.flatMap((raw) => {
    const resource = notionObject(raw);
    if (people) {
      if (resource.object !== "user") throw new Error("Notion returned an invalid user choice.");
      if (resource.type !== "person") return [];
    } else {
      if (
        resource.object !== "page" ||
        notionResourceId(notionString(notionObject(resource.parent).data_source_id)) !== expected
      ) {
        throw new Error("A related record did not belong to the mapped data source.");
      }
      if (resource.in_trash === true || resource.archived === true) return [];
    }
    const value = notionResourceId(notionString(resource.id));
    return [
      { value, label: people ? notionString(resource.name) || value : notionTitle(resource) },
    ];
  });
}
