import { Schema } from "effect";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";

const DebugPath = TrimmedNonEmptyString.check(Schema.isMaxLength(4_096));
const DebugId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const DebugText = Schema.String.check(Schema.isMaxLength(16_384));
export const EditorDebugBreakpoint = Schema.Struct({
  relativePath: DebugPath,
  line: NonNegativeInt.check(Schema.isGreaterThan(0)),
  condition: Schema.optional(DebugText),
  hitCondition: Schema.optional(DebugText),
  logMessage: Schema.optional(DebugText),
});
export type EditorDebugBreakpoint = typeof EditorDebugBreakpoint.Type;
export const EditorDebugStartInput = Schema.Struct({
  cwd: DebugPath,
  request: Schema.Literals(["launch", "attach"]),
  program: DebugPath,
  args: Schema.Array(DebugText).check(Schema.isMaxLength(64)),
  port: NonNegativeInt.check(Schema.isLessThanOrEqualTo(65_535)),
  stopOnEntry: Schema.Boolean,
  breakpoints: Schema.Array(EditorDebugBreakpoint).check(Schema.isMaxLength(1_000)),
});
export type EditorDebugStartInput = typeof EditorDebugStartInput.Type;
export const EditorDebugStartResult = Schema.Struct({ sessionId: DebugId });
export const EditorDebugActionInput = Schema.Struct({
  sessionId: DebugId,
  connectionId: Schema.optional(DebugId),
  action: Schema.Literals([
    "continue",
    "pause",
    "next",
    "stepIn",
    "stepOut",
    "threads",
    "stackTrace",
    "scopes",
    "variables",
    "evaluate",
    "setBreakpoints",
    "disconnect",
  ]),
  threadId: Schema.optional(NonNegativeInt),
  frameId: Schema.optional(NonNegativeInt),
  variablesReference: Schema.optional(NonNegativeInt),
  expression: Schema.optional(DebugText),
  context: Schema.optional(Schema.Literals(["watch", "repl", "hover"])),
  relativePath: Schema.optional(DebugPath),
  breakpoints: Schema.optional(
    Schema.Array(EditorDebugBreakpoint).check(Schema.isMaxLength(1_000)),
  ),
});
export type EditorDebugActionInput = typeof EditorDebugActionInput.Type;
export const EditorDebugVariable = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
  type: Schema.optional(Schema.String),
  variablesReference: NonNegativeInt,
  evaluateName: Schema.optional(Schema.String),
});
export const EditorDebugFrame = Schema.Struct({
  id: NonNegativeInt,
  name: Schema.String,
  line: NonNegativeInt,
  column: NonNegativeInt,
  relativePath: Schema.optional(DebugPath),
  sourceName: Schema.String,
});
export type EditorDebugFrame = typeof EditorDebugFrame.Type;
export const EditorDebugActionResult = Schema.Struct({
  threads: Schema.optional(
    Schema.Array(Schema.Struct({ id: NonNegativeInt, name: Schema.String })),
  ),
  frames: Schema.optional(Schema.Array(EditorDebugFrame)),
  scopes: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        variablesReference: NonNegativeInt,
        expensive: Schema.Boolean,
      }),
    ),
  ),
  variables: Schema.optional(Schema.Array(EditorDebugVariable)),
  evaluation: Schema.optional(EditorDebugVariable),
  breakpoints: Schema.optional(
    Schema.Array(
      Schema.Struct({ verified: Schema.Boolean, line: NonNegativeInt, message: Schema.String }),
    ),
  ),
});
export type EditorDebugActionResult = typeof EditorDebugActionResult.Type;
export const EditorDebugEvent = Schema.Struct({
  id: NonNegativeInt,
  connectionId: DebugId,
  event: Schema.Literals([
    "stopped",
    "continued",
    "output",
    "terminated",
    "exited",
    "error",
    "thread",
    "breakpoint",
    "ready",
  ]),
  text: Schema.String,
  threadId: Schema.optional(NonNegativeInt),
  exitCode: Schema.optional(Schema.Number),
});
export type EditorDebugEvent = typeof EditorDebugEvent.Type;
export const EditorDebugPollInput = Schema.Struct({ sessionId: DebugId, after: NonNegativeInt });
export type EditorDebugPollInput = typeof EditorDebugPollInput.Type;
export const EditorDebugSnapshot = Schema.Struct({
  sessionId: DebugId,
  sequence: NonNegativeInt,
  terminated: Schema.Boolean,
  connections: Schema.Array(
    Schema.Struct({ id: DebugId, name: Schema.String, ready: Schema.Boolean }),
  ),
  events: Schema.Array(EditorDebugEvent),
});
export type EditorDebugSnapshot = typeof EditorDebugSnapshot.Type;
