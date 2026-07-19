import { Schema } from "effect";

import { TrimmedNonEmptyString } from "./baseSchemas";

/** Stable identity for one authenticated GitHub CLI account. */
export const GitHubAccountSelection = Schema.Struct({
  host: TrimmedNonEmptyString,
  login: TrimmedNonEmptyString,
});
export type GitHubAccountSelection = typeof GitHubAccountSelection.Type;
