import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { TodoDueDate } from "./todo";

describe("TodoDueDate", () => {
  it("accepts real calendar days only", () => {
    const isDueDate = Schema.is(TodoDueDate);
    expect(isDueDate("2026-09-27")).toBe(true);
    expect(isDueDate("2028-02-29")).toBe(true);
    expect(isDueDate("2026-02-29")).toBe(false);
    expect(isDueDate("2026-02-31")).toBe(false);
    expect(isDueDate("2026-13-01")).toBe(false);
    expect(isDueDate("2026-00-10")).toBe(false);
    expect(isDueDate("2026-9-27")).toBe(false);
  });
});
