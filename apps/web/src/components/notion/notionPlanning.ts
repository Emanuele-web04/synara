import type { NotionMapping, NotionObject, NotionSprintPlan } from "@synara/contracts";
import {
  notionArray,
  notionObject,
  notionProperty,
  notionResourceId,
  notionString,
} from "@synara/shared/notion";
export const NOTION_DAY_MS = 86_400_000;
export function notionDay(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : "";
}
export function addNotionDays(day: string, days: number): string {
  if (!notionDay(day) || !Number.isInteger(days)) throw new Error("Invalid calendar date.");
  const time = Date.parse(day + "T00:00:00Z") + days * NOTION_DAY_MS;
  if (!Number.isFinite(time)) throw new Error("Invalid calendar range.");
  return new Date(time).toISOString().slice(0, 10);
}
export function moveNotionDate(property: NotionObject, target: string): NotionObject {
  const date = notionObject(property.date);
  if (
    !notionDay(target) ||
    date.time_zone ||
    (date.start != null && !notionDay(date.start)) ||
    (date.end != null && !notionDay(date.end))
  )
    throw new Error(
      "Timed or incomplete dates cannot be moved on a date-only calendar. Use the original date editor.",
    );
  if (!date.start) return { start: target };
  const offset = (Date.parse(target) - Date.parse(notionString(date.start))) / NOTION_DAY_MS;
  return {
    ...date,
    start: target,
    ...(date.end ? { end: addNotionDays(notionString(date.end), offset) } : {}),
  };
}
export function moveNotionSprint(property: NotionObject, from: string, to: string): unknown[] {
  if (
    property.type !== "relation" ||
    property.has_more === true ||
    !Array.isArray(property.relation)
  )
    throw new Error("Load a complete Sprint relation before changing membership.");
  const source = from ? notionResourceId(from) : "";
  const target = to ? notionResourceId(to) : "";
  const selected = property.relation.map((raw) => ({
    raw,
    id: notionResourceId(notionString(notionObject(raw).id)),
  }));
  if (source && !selected.some((value) => value.id === source))
    throw new Error("The task is no longer in this sprint. Refresh planning.");
  const retained = selected.filter((value) => !source || value.id !== source);
  if (target && !retained.some((value) => value.id === target))
    return [...retained.map((value) => value.raw), { id: target }];
  return retained.map((value) => value.raw);
}
export function notionSprintPhase(
  page: NotionObject,
  plan: NotionSprintPlan | null | undefined,
  today: string,
): "current" | "upcoming" | "completed" | "past" | "unscheduled" {
  if (!plan) return "unscheduled";
  const status = notionProperty(page.properties, plan.status ?? undefined);
  if (
    plan.completedStatusIds.includes(
      notionString(notionObject(status[notionString(status.type)]).id),
    )
  )
    return "completed";
  const start = notionObject(notionProperty(page.properties, plan.start ?? undefined).date);
  const end = notionObject(notionProperty(page.properties, plan.end ?? undefined).date);
  const from = notionDay(start.start);
  const to = notionDay(end.end) || notionDay(end.start) || notionDay(start.end);
  if (from && from > today) return "upcoming";
  if (to && to < today) return "past";
  return from || to ? "current" : "unscheduled";
}
export function notionRecordDone(page: NotionObject, mapping: NotionMapping): boolean {
  const property = notionProperty(page.properties, mapping.fields.status);
  return property.type === "checkbox"
    ? property.checkbox === true
    : mapping.completedStatusIds.includes(
        notionString(notionObject(property[notionString(property.type)]).id),
      );
}
export function notionPlanningSummary(pages: readonly NotionObject[], mapping: NotionMapping) {
  let points = 0,
    completedPoints = 0,
    completed = 0;
  const workloads = new Map<string, { id: string; name: string; tasks: number; points: number }>();
  for (const page of pages) {
    const raw = notionProperty(page.properties, mapping.fields.points).number;
    const estimate = typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : 0;
    const done = notionRecordDone(page, mapping);
    points += estimate;
    if (done) {
      completed++;
      completedPoints += estimate;
    }
    for (const rawPerson of notionArray(
      notionProperty(page.properties, mapping.fields.assignee).people,
    )) {
      const person = notionObject(rawPerson);
      const id = notionString(person.id);
      if (!id) continue;
      const value = workloads.get(id) ?? {
        id,
        name: notionString(person.name) || id,
        tasks: 0,
        points: 0,
      };
      value.tasks++;
      value.points += estimate;
      workloads.set(id, value);
    }
  }
  return {
    total: pages.length,
    completed,
    points,
    completedPoints,
    workloads: [...workloads.values()],
  };
}
