import { Schema } from "effect";

export class ProjectAgentServiceError extends Schema.TaggedErrorClass<ProjectAgentServiceError>()(
  "ProjectAgentServiceError",
  {
    message: Schema.String,
    code: Schema.optional(
      Schema.Literals([
        "not-found",
        "conflict",
        "forbidden",
        "invalid",
        "cycle",
        "limit",
        "unconfigured",
      ]),
    ),
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class LibraryError extends Schema.TaggedErrorClass<LibraryError>()("LibraryError", {
  message: Schema.String,
  code: Schema.optional(
    Schema.Literals(["not-found", "conflict", "forbidden", "invalid", "unconfigured"]),
  ),
  cause: Schema.optional(Schema.Defect),
}) {}
