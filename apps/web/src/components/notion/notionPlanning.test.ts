import { describe, expect, it } from "vitest";
import {
  addNotionDays,
  moveNotionDate,
  moveNotionSprint,
  notionDay,
  notionSprintPhase,
} from "./notionPlanning";
const a = "11111111-1111-4111-8111-111111111111",
  b = "22222222-2222-4222-8222-222222222222",
  c = "33333333-3333-4333-8333-333333333333";
describe("Notion planning invariants", () => {
  it("rejects rolled-over dates and handles calendar boundaries", () => {
    expect(notionDay("2026-02-31")).toBe("");
    expect(addNotionDays("2026-12-31", 1)).toBe("2027-01-01");
  });
  it("moves a full date range without discarding its duration", () => {
    expect(
      moveNotionDate(
        { date: { start: "2026-10-01", end: "2026-10-05", time_zone: null } },
        "2026-10-20",
      ),
    ).toEqual({ start: "2026-10-20", end: "2026-10-24", time_zone: null });
  });
  it("refuses to flatten timed dates", () => {
    expect(() => moveNotionDate({ date: { start: "2026-10-01T10:00:00Z" } }, "2026-10-20")).toThrow(
      "Timed",
    );
  });
  it("preserves other sprint memberships when moving or removing one", () => {
    const original = { type: "relation", relation: [{ id: a }, { id: b }] };
    expect(moveNotionSprint(original, a, c)).toEqual([{ id: b }, { id: c }]);
    expect(moveNotionSprint(original, a, "")).toEqual([{ id: b }]);
    expect(original.relation).toHaveLength(2);
  });
  it("refuses incomplete or stale membership replacements", () => {
    expect(() =>
      moveNotionSprint({ type: "relation", relation: [{ id: a }], has_more: true }, a, b),
    ).toThrow("complete");
    expect(() => moveNotionSprint({ type: "relation", relation: [{ id: a }] }, b, c)).toThrow(
      "no longer",
    );
  });
  it("does not infer completed status from elapsed dates", () => {
    const plan = {
      dataSourceId: a,
      title: { id: "t", type: "title" },
      start: { id: "d", type: "date" },
      end: null,
      status: null,
      completedStatusIds: [],
    };
    expect(
      notionSprintPhase(
        {
          properties: {
            Date: { id: "d", type: "date", date: { start: "2026-10-01", end: "2026-10-03" } },
          },
        },
        plan,
        "2026-10-15",
      ),
    ).toBe("past");
  });
});
