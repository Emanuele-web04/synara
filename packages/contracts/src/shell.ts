// FILE: shell.ts
// Purpose: Shared shell command contracts for detached process launch.
// Layer: Shared contracts
// Exports: RunDetachedShellCommandInput

import { Schema } from "effect";

import { TrimmedNonEmptyString } from "./baseSchemas";

export const RunDetachedShellCommandInput = Schema.Struct({
  command: TrimmedNonEmptyString,
});
export type RunDetachedShellCommandInput = typeof RunDetachedShellCommandInput.Type;
