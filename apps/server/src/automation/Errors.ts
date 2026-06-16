import { Schema } from "effect";

export class AutomationServiceError extends Schema.TaggedErrorClass<AutomationServiceError>()(
  "AutomationServiceError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}
