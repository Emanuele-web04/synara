// FILE: ChatMarkdown.compiler.test.ts
// Purpose: Regression guard — ChatMarkdown must stay fully compilable by React
//          Compiler. Its manual memoization was removed on that premise: a
//          single default value in parameter destructuring (BuildHIR
//          AssignmentPattern bailout) would silently drop compiler coverage
//          for the whole component, which renders every chat message.
// Layer: Web build-integrity test

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
