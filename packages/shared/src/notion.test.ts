import { describe, expect, it } from "vitest";
import type { NotionMapping, NotionObject } from "@synara/contracts";
import {
  notionComparableValue,
  notionPatchConflicts,
  notionPropertySnapshot,
  notionResourceId,
  notionTodoPatch,
  plainNotionText,
  projectNotionTask,
  validateNotionMapping,
  validateNotionSprintPlan,
} from "./notion";
const source = "11111111-1111-4111-8111-111111111111";
const pageId = "22222222-2222-4222-8222-222222222222";
const mapping: NotionMapping = {
  id: "tasks",
  connectionId: "workspace:bot",
  dataSourceId: source,
  name: "Engineering",
  projectId: null,
  fields: {
    title: { id: "title", type: "title" },
    status: { id: "s", type: "status" },
    description: { id: "d", type: "rich_text" },
  },
  completedStatusIds: ["done"],
  reopenedStatusId: "todo",
  priorityOptions: {},
  agentAccess: "none",
  enabled: true,
};
const page: NotionObject = {
  id: pageId,
  properties: {
    Renamed: { id: "title", type: "title", title: plainNotionText("Ship OAuth") },
    Workflow: { id: "s", type: "status", status: { id: "todo", name: "To do", color: "default" } },
    Description: { id: "d", type: "rich_text", rich_text: plainNotionText("Preserve details") },
    Unknown: { id: "custom", type: "formula", formula: { type: "number", number: 42 } },
  },
};
describe("Notion lossless task adapter", () => {
  it("maps IDs rather than property display names", () => {
    const result = projectNotionTask(page, mapping, "Team");
    expect(result.title).toBe("Ship OAuth");
    expect(result.completed).toBe(false);
    expect(result.external.pageId).toBe(pageId);
  });
  it("patches only the intentionally mapped fields", () => {
    const patch = notionTodoPatch(page, mapping, { title: "Review OAuth", completed: true });
    expect(patch).toEqual({
      title: { title: plainNotionText("Review OAuth") },
      s: { status: { id: "done" } },
    });
    expect(JSON.stringify(page)).toContain('"custom"');
  });
  it("refuses to flatten rich text during native title editing", () => {
    const rich = {
      ...page,
      properties: {
        ...(page.properties as object),
        Renamed: {
          id: "title",
          type: "title",
          title: [{ type: "text", text: { content: "Bold" }, annotations: { bold: true } }],
        },
      },
    };
    expect(() => notionTodoPatch(rich, mapping, { title: "Replacement" })).toThrow("rich text");
  });
  it("normalizes API defaults and split text runs only for comparison", () => {
    const response = [
      {
        type: "text",
        plain_text: "A",
        href: null,
        annotations: { bold: false, italic: false, color: "default" },
        text: { content: "A", link: null },
      },
      { type: "text", text: { content: "B" } },
    ];
    expect(notionComparableValue({ title: response })).toEqual(
      notionComparableValue({ title: plainNotionText("AB") }),
    );
    expect(response[0]?.annotations).toEqual({ bold: false, italic: false, color: "default" });
  });
  it("ignores unrelated fields and reports genuine concurrent changes", () => {
    expect(
      notionPatchConflicts({ title: "old" }, { title: "other", custom: 2 }, { title: "mine" }),
    ).toEqual(["title"]);
    expect(notionPatchConflicts({ title: "old" }, { title: "mine" }, { title: "mine" })).toEqual(
      [],
    );
  });
  it("compares relation IDs independent of response ordering", () => {
    expect(notionComparableValue({ relation: [{ id: source }, { id: pageId }] })).toEqual(
      notionComparableValue({ relation: [{ id: pageId }, { id: source.replaceAll("-", "") }] }),
    );
  });
  it("chunks UTF-16 bounded rich text without breaking emoji", () => {
    const input = "😀".repeat(2001);
    const chunks = plainNotionText(input);
    expect(chunks.map((value) => (value.text as { content: string }).content).join("")).toBe(input);
    for (const chunk of chunks)
      expect((chunk.text as { content: string }).content.length).toBeLessThanOrEqual(2000);
  });
  it("rejects mappings whose property type changed", () => {
    expect(() =>
      validateNotionMapping(mapping, { properties: { Title: { id: "title", type: "rich_text" } } }),
    ).toThrow("title");
  });
  it("keeps status IDs in comparison snapshots and rejects malformed resource IDs", () => {
    expect(notionPropertySnapshot(page.properties, ["s"])).toEqual({
      s: { status: { id: "todo" } },
    });
    expect(() => notionResourceId("../../oauth/token")).toThrow();
  });
});

describe("Notion sprint-plan schema validation", () => {
  const sprintSourceId = "33333333-3333-4333-8333-333333333333";
  const sprintMapping: NotionMapping = {
    ...mapping,
    fields: { ...mapping.fields, sprint: { id: "rel", type: "relation" } },
    sprintPlan: {
      dataSourceId: sprintSourceId,
      title: { id: "name", type: "title" },
      start: { id: "from", type: "date" },
      end: { id: "to", type: "date" },
      status: { id: "state", type: "status" },
      completedStatusIds: ["finished"],
    },
  };
  const sourceData = {
    id: source,
    properties: {
      Sprint: { id: "rel", type: "relation", relation: { data_source_id: sprintSourceId } },
    },
  };
  const sprintData = {
    id: sprintSourceId,
    properties: {
      Name: { id: "name", type: "title" },
      From: { id: "from", type: "date" },
      To: { id: "to", type: "date" },
      State: {
        id: "state",
        type: "status",
        status: { options: [{ id: "finished" }, { id: "active" }] },
      },
    },
  };
  it("accepts property IDs from the actual relation target", () => {
    expect(() => validateNotionSprintPlan(sprintMapping, sourceData, sprintData)).not.toThrow();
  });
  it("does not accept unshared or substituted sprint sources", () => {
    expect(() =>
      validateNotionSprintPlan(
        sprintMapping,
        {
          ...sourceData,
          properties: {
            Sprint: { id: "rel", type: "relation", relation: { data_source_id: pageId } },
          },
        },
        sprintData,
      ),
    ).toThrow("relation");
  });
  it("rejects removed completed-status options and type changes", () => {
    const changed = {
      ...sprintData,
      properties: {
        ...sprintData.properties,
        State: {
          id: "state",
          type: "status",
          status: { options: [{ id: "active" }] },
        },
      },
    };
    expect(() => validateNotionSprintPlan(sprintMapping, sourceData, changed)).toThrow("completed");
  });
});
