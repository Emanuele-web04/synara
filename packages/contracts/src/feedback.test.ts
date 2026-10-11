import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { FeedbackSubmission } from "./feedback";

const decode = Schema.decodeUnknownSync(FeedbackSubmission);

describe("explicit feedback contract", () => {
  it("accepts manual reports and strips legacy automatic context", () => {
    expect(
      decode({
        category: "bug",
        details: "  Sending stopped.  ",
        diagnostics: {
          provider: "synthetic-provider",
          model: "synthetic-private-model",
          userAgent: "synthetic-browser",
        },
        summary: "synthetic-hidden-context",
      }),
    ).toEqual({ category: "bug", details: "Sending stopped." });
  });
  it("accepts uncategorized manual reports", () => {
    expect(decode({ category: null, details: "A suggestion" })).toEqual({
      category: null,
      details: "A suggestion",
    });
  });
  it.each(["constructor", "toString", "unknown"])(
    "rejects an unrecognized category %s",
    (category) => {
      expect(() => decode({ category, details: "A report" })).toThrow();
    },
  );
  it.each(["", "  ", "x".repeat(5_001)])("rejects empty or oversized reporter text", (details) => {
    expect(() => decode({ category: "bug", details })).toThrow();
  });
});
