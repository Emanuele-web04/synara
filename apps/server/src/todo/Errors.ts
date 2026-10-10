import { Schema } from "effect";

export class TodoServiceError extends Schema.TaggedErrorClass<TodoServiceError>()(
  "TodoServiceError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}
