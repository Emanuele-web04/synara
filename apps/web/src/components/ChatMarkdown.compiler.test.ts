// manual memoization was removed on the premise of compiler coverage — a single default value in destructuring (BuildHIR AssignmentPattern bailout) would silently drop it for this component, which renders every chat message

import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compileReactModule } from "../test/reactCompiler";

describe("ChatMarkdown React Compiler coverage", () => {
  it("compiles every function in ChatMarkdown.tsx without bailouts", () => {
    const events = compileReactModule(join(import.meta.dirname, "ChatMarkdown.tsx"));
    const errors = events
      .filter((event) => event.kind === "CompileError")
      .map(
        (event) =>
          `${event.fnName ?? "<anonymous>"}: ${event.detail?.reason ?? event.detail?.description ?? "unknown"}`,
      );
    expect(events.filter((event) => event.kind === "PipelineError")).toEqual([]);
    expect(errors).toEqual([]);
    expect(events.some((event) => event.kind === "CompileSuccess")).toBe(true);
  });
});
