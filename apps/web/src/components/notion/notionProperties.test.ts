import assert from "node:assert/strict";
import { test } from "vitest";
import type { NotionMapping, NotionObject } from "@synara/contracts";
import { notionPatchConflicts, notionPropertySnapshot } from "@synara/shared/notion";
import {
  editNotionMapping,
  mappedNotionProperties,
  notionProperties,
  notionReferenceChoices,
  notionTaskPropertyPatch,
} from "./notionProperties";

const SOURCE = "00000000-0000-4000-8000-000000000001";
const SPRINT = "00000000-0000-4000-8000-000000000002";
const PAGE = "00000000-0000-4000-8000-000000000003";
const NEXT = "00000000-0000-4000-8000-000000000004";
function fixture() {
  const source: NotionObject = {
    id: SOURCE,
    properties: {
      "Renamed title": { id: "title", type: "title", title: {} },
      Workflow: {
        id: "st",
        type: "status",
        status: {
          options: [
            { id: "todo", name: "To do" },
            { id: "done", name: "Done" },
            { id: "closed", name: "Closed" },
          ],
        },
      },
      Urgency: {
        id: "pr",
        type: "select",
        select: {
          options: [
            { id: "p1", name: "Critical" },
            { id: "p2", name: "Normal" },
          ],
        },
      },
      Iteration: { id: "sp", type: "relation", relation: { data_source_id: SPRINT } },
      Estimate: { id: "pts", type: "number", number: {} },
      Schedule: { id: "dt", type: "date", date: {} },
      Owner: { id: "who", type: "people", people: {} },
      Formula: { id: "computed", type: "formula", formula: { expression: "1" } },
    },
  };
  const mapping: NotionMapping = {
    id: "mapping",
    connectionId: "workspace",
    dataSourceId: SOURCE,
    name: "Team work",
    projectId: null,
    fields: {
      title: { id: "title", type: "title" },
      status: { id: "st", type: "status" },
      priority: { id: "pr", type: "select" },
      sprint: { id: "sp", type: "relation" },
      points: { id: "pts", type: "number" },
      start: { id: "dt", type: "date" },
      due: { id: "dt", type: "date" },
      assignee: { id: "who", type: "people" },
    },
    completedStatusIds: ["done", "closed"],
    reopenedStatusId: "todo",
    priorityOptions: { p1: "urgent", p2: "medium" },
    agentAccess: "none",
    agentPageIds: [PAGE],
    enabled: true,
    sprintPlan: {
      dataSourceId: SPRINT,
      title: { id: "title", type: "title" },
      start: null,
      end: null,
      status: null,
      completedStatusIds: [],
    },
  };
  const page: NotionObject = {
    id: PAGE,
    object: "page",
    parent: { data_source_id: SOURCE },
    properties: {
      "Renamed title": {
        id: "title",
        type: "title",
        title: [{ type: "text", text: { content: "Do work" } }],
      },
      Workflow: { id: "st", type: "status", status: { id: "todo", name: "To do" } },
      Urgency: { id: "pr", type: "select", select: { id: "p2", name: "Normal" } },
      Iteration: { id: "sp", type: "relation", relation: [{ id: PAGE }], has_more: false },
      Estimate: { id: "pts", type: "number", number: 3 },
      Schedule: {
        id: "dt",
        type: "date",
        date: { start: "2026-10-15", end: "2026-10-22", time_zone: null },
      },
      Owner: { id: "who", type: "people", people: [] },
      Untouched: {
        id: "computed",
        type: "formula",
        formula: { type: "number", number: 1 },
        opaque: { preserve: true },
      },
    },
  };
  return { source, mapping, page };
}

test("maps renamed properties by ID and groups a shared start/due range once", () => {
  const { source, mapping, page } = fixture();
  assert.equal(
    notionProperties(source).find((property) => property.id === "st")?.label,
    "Workflow",
  );
  const properties = mappedNotionProperties(mapping, source, page);
  assert.deepEqual(properties.find((property) => property.id === "dt")?.fields, ["start", "due"]);
  assert.equal(properties.filter((property) => property.id === "dt").length, 1);
});

test("changes only explicitly edited properties without mutating the page or mapping", () => {
  const { source, mapping, page } = fixture();
  const original = structuredClone({ source, mapping, page });
  const patch = notionTaskPropertyPatch(mapping, source, page, { pts: 8, sp: [{ id: NEXT }] });
  assert.deepEqual(patch.changes, { pts: { number: 8 }, sp: { relation: [{ id: NEXT }] } });
  assert.deepEqual(patch.base, { pts: { number: 3 }, sp: { relation: [{ id: PAGE }] } });
  assert.deepEqual({ source, mapping, page }, original);
});

test("clearing sprint membership returns only a relation patch", () => {
  const { source, mapping, page } = fixture();
  assert.deepEqual(notionTaskPropertyPatch(mapping, source, page, { sp: [] }).changes, {
    sp: { relation: [] },
  });
});

test("does not turn equivalent IDs, metadata, or estimates into writes", () => {
  const { source, mapping, page } = fixture();
  const patch = notionTaskPropertyPatch(mapping, source, page, {
    pts: 3,
    sp: [{ id: PAGE.replaceAll("-", "").toUpperCase() }],
    st: { id: "todo" },
  });
  assert.deepEqual(patch, { base: {}, changes: {} });
});

test("rejects unknown fields, schema drift, and a foreign or disabled source", () => {
  const { source, mapping, page } = fixture();
  assert.throws(() => notionTaskPropertyPatch(mapping, source, page, { computed: 99 }), /mapped/);
  assert.throws(
    () => notionTaskPropertyPatch({ ...mapping, enabled: false }, source, page, { pts: 5 }),
    /enabled/,
  );
  assert.throws(
    () =>
      notionTaskPropertyPatch(
        mapping,
        source,
        { ...page, parent: { data_source_id: SPRINT } },
        { pts: 5 },
      ),
    /source/,
  );
  assert.throws(
    () =>
      notionTaskPropertyPatch(
        { ...mapping, fields: { ...mapping.fields, points: { id: "pts", type: "formula" } } },
        source,
        page,
        { pts: 5 },
      ),
    /mapping/,
  );
});

test("refuses to replace a truncated relation or assignee list", () => {
  const { source, mapping, page } = fixture();
  const properties = page.properties as Record<string, Record<string, unknown>>;
  properties.Iteration!.has_more = true;
  assert.throws(() => notionTaskPropertyPatch(mapping, source, page, { sp: [] }), /incomplete/);
  properties.Owner!.people = Array.from({ length: 25 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  }));
  assert.throws(() => notionTaskPropertyPatch(mapping, source, page, { who: [] }), /incomplete/);
});

test("retains complete timed dates and validates editable calendar ranges", () => {
  const { source, mapping, page } = fixture();
  const properties = page.properties as Record<string, Record<string, unknown>>;
  properties.Schedule!.date = { start: "2026-10-15T10:00:00+02:00", end: null, time_zone: null };
  assert.throws(() => notionTaskPropertyPatch(mapping, source, page, { dt: null }), /time/);
  properties.Schedule!.date = null;
  for (const date of [{ start: "2026-02-30" }, { start: "2026-10-15", end: "2026-10-14" }]) {
    assert.throws(
      () => notionTaskPropertyPatch(mapping, source, page, { dt: date }),
      /valid dates/,
    );
  }
  assert.deepEqual(
    notionTaskPropertyPatch(mapping, source, page, {
      dt: { start: "2026-10-15", end: "2026-10-22" },
    }).changes,
    { dt: { date: { start: "2026-10-15", end: "2026-10-22", time_zone: null } } },
  );
});

test("requires valid status options, finite estimates, and distinct relation IDs", () => {
  const { source, mapping, page } = fixture();
  for (const pts of [NaN, Infinity, -1, "8"])
    assert.throws(() => notionTaskPropertyPatch(mapping, source, page, { pts }), /finite/);
  assert.throws(
    () => notionTaskPropertyPatch(mapping, source, page, { st: null }),
    /cannot be cleared/,
  );
  assert.throws(
    () => notionTaskPropertyPatch(mapping, source, page, { st: { id: "invented" } }),
    /existing option/,
  );
  assert.throws(
    () => notionTaskPropertyPatch(mapping, source, page, { sp: [{ id: NEXT }, { id: NEXT }] }),
    /more than once/,
  );
  assert.throws(
    () => notionTaskPropertyPatch(mapping, source, page, { sp: [{ id: "malformed" }] }),
    /resource ID/,
  );
});

test("keeps a frozen baseline that detects a concurrent Notion edit", () => {
  const { source, mapping, page } = fixture();
  const patch = notionTaskPropertyPatch(mapping, source, page, { pts: 8 });
  const remote = structuredClone(page);
  (remote.properties as Record<string, Record<string, unknown>>).Estimate!.number = 13;
  assert.deepEqual(
    notionPatchConflicts(
      patch.base,
      notionPropertySnapshot(remote.properties, ["pts"]),
      patch.changes,
    ),
    ["pts"],
  );
});

test("saving mapping settings preserves sprint metadata, multiple completion statuses and paused state", () => {
  const { source, mapping } = fixture();
  const paused = { ...mapping, enabled: false };
  const next = editNotionMapping(paused, source, {
    id: mapping.id,
    connectionId: mapping.connectionId,
    name: "New label",
    projectId: null,
    fields: mapping.fields,
    completedStatusIds: mapping.completedStatusIds,
    reopenedStatusId: mapping.reopenedStatusId,
    priorityOptions: mapping.priorityOptions,
  });
  assert.deepEqual(next.sprintPlan, mapping.sprintPlan);
  assert.deepEqual(next.agentPageIds, [PAGE]);
  assert.deepEqual(next.completedStatusIds, ["done", "closed"]);
  assert.deepEqual(next.priorityOptions, { p1: "urgent", p2: "medium" });
  assert.equal(next.enabled, false);
  assert.equal(mapping.name, "Team work");
});

test("reference choices exclude bots and archived records and reject other sources", () => {
  const page = {
    id: PAGE,
    object: "page",
    parent: { data_source_id: SPRINT },
    properties: { Name: { type: "title", title: [{ plain_text: "Sprint 42" }] } },
  };
  assert.deepEqual(
    notionReferenceChoices({ results: [page, { ...page, archived: true }] }, false, SPRINT),
    [{ value: PAGE, label: "Sprint 42" }],
  );
  assert.deepEqual(
    notionReferenceChoices(
      {
        results: [
          { object: "user", id: PAGE, type: "person", name: "Ada" },
          { object: "user", id: NEXT, type: "bot" },
        ],
      },
      true,
      "",
    ),
    [{ value: PAGE, label: "Ada" }],
  );
  assert.throws(
    () => notionReferenceChoices({ results: [page] }, false, SOURCE),
    /mapped data source/,
  );
  assert.throws(() => notionReferenceChoices({}, true, ""), /incomplete/);
});
