// FILE: hotPathCompiler.ts
// Purpose: Shared React Compiler bailout guard for the chat hot-path test files.
// Layer: Web test helper
// Depends on: reactCompiler.ts (same plugin the Vite build uses) and
//             compilerEventCache.ts (CI replays events for unchanged bytes).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { cachedCompilerEvents } from "./compilerEventCache";
import { compileReactSource } from "./reactCompiler";

export interface HotPathModule {
  readonly relativePath: string;
  readonly requiredFunction?: string;
  // Exact multiset of bailout reasons that are deliberate and reviewed. Anything
  // else — including a second copy of an allowed reason — fails the test.
  readonly allowedBailoutReasons: readonly string[];
  // Pure logic modules contain no component or hook for the compiler to emit a
  // CompileSuccess for; they stay listed so a future hook/component that bails
  // is caught. Defaults to true.
  readonly requiresCompileSuccess?: boolean;
}

/**
 * These are among the largest modules in the app — a cold
 * Babel compile of it was measured at 66s while the rest of the workspace suite competed for CPU.
 * The budget only exists to stop a hang, so it is set far above the observed worst case rather
 * than near it; a tight bound here fails the suite for machine load, not for a real regression.
 */
const COMPILE_TIMEOUT_MS = 240_000;

/** Registers one bailout check per module, resolving paths from `directory`. */
export function describeHotPathCompilation(
  directory: string,
  modules: readonly HotPathModule[],
): void {
  describe("chat hot-path React Compiler coverage", () => {
    for (const module of modules) {
      it(
        `compiles ${module.relativePath} without unexpected bailouts`,
        () => {
          const filePath = join(directory, module.relativePath);
          const source = readFileSync(filePath, "utf8");
          const events = cachedCompilerEvents({
            filePath,
            source,
            compile: () => compileReactSource(filePath, source),
          });
          const bailoutReasons = events
            .filter((event) => event.kind === "CompileError")
            .map((event) => event.detail?.reason ?? event.detail?.description ?? "unknown")
            .toSorted();

          // Pipeline failures (including stack overflows) do not emit CompileError.
          // A successful helper must not mask failure to compile the main component.
          expect(events.filter((event) => event.kind === "PipelineError")).toEqual([]);
          expect(bailoutReasons).toEqual(module.allowedBailoutReasons.toSorted());
          if (module.requiredFunction) {
            expect(
              events.some(
                (event) =>
                  event.kind === "CompileSuccess" && event.fnName === module.requiredFunction,
              ),
            ).toBe(true);
          }
          if (module.requiresCompileSuccess !== false) {
            expect(events.some((event) => event.kind === "CompileSuccess")).toBe(true);
          }
        },
        COMPILE_TIMEOUT_MS,
      );
    }
  });
}
