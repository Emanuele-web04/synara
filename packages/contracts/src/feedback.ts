import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";

export const FeedbackCategory = Schema.Literals([
  "bug",
  "session",
  "ui",
  "performance",
  "idea",
  "other",
]);
export type FeedbackCategory = typeof FeedbackCategory.Type;

// Explicit feedback contains only what the reporter chooses to write.
// The default Struct decoder strips legacy diagnostics and unknown fields.
export const FeedbackSubmission = Schema.Struct({
  category: Schema.NullOr(FeedbackCategory),
  details: TrimmedNonEmptyString.check(Schema.isMaxLength(5_000)),
});
export type FeedbackSubmission = typeof FeedbackSubmission.Type;
