// FILE: GitCore.process.ts
// Purpose: Effect-bound git subprocess helpers — trace2 hook monitoring and bounded output collection.
// Layer: Server Git service (process-bound, services supplied via Effect context)
// Exports: createTrace2Monitor, collectOutput, and the Trace2Monitor shape.
import {
  Effect,
  FileSystem,
  Path,
  PlatformError,
  Ref,
  Result,
  Scope,
  Semaphore,
  Stream,
} from "effect";

import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import { GitCommandError } from "../Errors.ts";
import type { ExecuteGitInput, ExecuteGitProgress } from "../Services/GitCore.ts";
import type { TraceTailState } from "./GitCore.types.ts";
import { Trace2Record, quoteGitCommand, toGitCommandError } from "./GitCore.commands.ts";
import { trace2ChildKey } from "./GitCore.parsing.ts";

export interface Trace2Monitor {
  readonly env: NodeJS.ProcessEnv;
  readonly flush: Effect.Effect<void, never>;
}

export const createTrace2Monitor = Effect.fn(function* (
  input: Pick<ExecuteGitInput, "operation" | "cwd" | "args">,
  progress: ExecuteGitProgress | undefined,
): Effect.fn.Return<
  Trace2Monitor,
  PlatformError.PlatformError,
  Scope.Scope | FileSystem.FileSystem | Path.Path
> {
  if (!progress?.onHookStarted && !progress?.onHookFinished) {
    return {
      env: {},
      flush: Effect.void,
    };
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const traceFilePath = yield* fs.makeTempFileScoped({
    prefix: `t3code-git-trace2-${process.pid}-`,
    suffix: ".json",
  });
  const hookStartByChildKey = new Map<string, { hookName: string; startedAtMs: number }>();
  const traceTailState = yield* Ref.make<TraceTailState>({
    processedChars: 0,
    remainder: "",
  });

  const handleTraceLine = (line: string) =>
    Effect.gen(function* () {
      const trimmedLine = line.trim();
      if (trimmedLine.length === 0) {
        return;
      }

      const traceRecord = decodeJsonResult(Trace2Record)(trimmedLine);
      if (Result.isFailure(traceRecord)) {
        yield* Effect.logDebug(
          `GitCore.trace2: failed to parse trace line for ${quoteGitCommand(input.args)} in ${input.cwd}`,
          traceRecord.failure,
        );
        return;
      }

      if (traceRecord.success.child_class !== "hook") {
        return;
      }

      const event = traceRecord.success.event;
      const childKey = trace2ChildKey(traceRecord.success);
      if (childKey === null) {
        return;
      }
      const started = hookStartByChildKey.get(childKey);
      const hookNameFromEvent =
        typeof traceRecord.success.hook_name === "string"
          ? traceRecord.success.hook_name.trim()
          : "";
      const hookName = hookNameFromEvent.length > 0 ? hookNameFromEvent : (started?.hookName ?? "");
      if (hookName.length === 0) {
        return;
      }

      if (event === "child_start") {
        hookStartByChildKey.set(childKey, { hookName, startedAtMs: Date.now() });
        if (progress.onHookStarted) {
          yield* progress.onHookStarted(hookName);
        }
        return;
      }

      if (event === "child_exit") {
        hookStartByChildKey.delete(childKey);
        if (progress.onHookFinished) {
          const code = traceRecord.success.code;
          yield* progress.onHookFinished({
            hookName: started?.hookName ?? hookName,
            exitCode: typeof code === "number" && Number.isInteger(code) ? code : null,
            durationMs: started ? Math.max(0, Date.now() - started.startedAtMs) : null,
          });
        }
      }
    });

  const deltaMutex = yield* Semaphore.make(1);
  const readTraceDelta = deltaMutex.withPermit(
    fs.readFileString(traceFilePath).pipe(
      Effect.flatMap((contents) =>
        Effect.uninterruptible(
          Ref.modify(traceTailState, ({ processedChars, remainder }) => {
            if (contents.length <= processedChars) {
              return [[], { processedChars, remainder }];
            }

            const appended = contents.slice(processedChars);
            const combined = remainder + appended;
            const lines = combined.split("\n");
            const nextRemainder = lines.pop() ?? "";

            return [
              lines.map((line) => line.replace(/\r$/, "")),
              {
                processedChars: contents.length,
                remainder: nextRemainder,
              },
            ];
          }).pipe(
            Effect.flatMap((lines) => Effect.forEach(lines, handleTraceLine, { discard: true })),
          ),
        ),
      ),
      Effect.ignore({ log: true }),
    ),
  );
  const traceFileName = path.basename(traceFilePath);
  yield* Stream.runForEach(fs.watch(traceFilePath), (event) => {
    const eventPath = event.path;
    const isTargetTraceEvent =
      eventPath === traceFilePath ||
      eventPath === traceFileName ||
      path.basename(eventPath) === traceFileName;
    if (!isTargetTraceEvent) return Effect.void;
    return readTraceDelta;
  }).pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* readTraceDelta;
      const finalLine = yield* Ref.modify(traceTailState, ({ processedChars, remainder }) => [
        remainder.trim(),
        {
          processedChars,
          remainder: "",
        },
      ]);
      if (finalLine.length > 0) {
        yield* handleTraceLine(finalLine);
      }
    }),
  );

  return {
    env: {
      GIT_TRACE2_EVENT: traceFilePath,
    },
    flush: readTraceDelta,
  };
});

export const collectOutput = Effect.fn(function* <E>(
  input: Pick<ExecuteGitInput, "operation" | "cwd" | "args">,
  stream: Stream.Stream<Uint8Array, E>,
  maxOutputBytes: number,
  onLine: ((line: string) => Effect.Effect<void, never>) | undefined,
): Effect.fn.Return<string, GitCommandError> {
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  let lineBuffer = "";

  const emitCompleteLines = (flush: boolean) =>
    Effect.gen(function* () {
      let newlineIndex = lineBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = lineBuffer.slice(0, newlineIndex).replace(/\r$/, "");
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
        if (line.length > 0 && onLine) {
          yield* onLine(line);
        }
        newlineIndex = lineBuffer.indexOf("\n");
      }

      if (flush) {
        const trailing = lineBuffer.replace(/\r$/, "");
        lineBuffer = "";
        if (trailing.length > 0 && onLine) {
          yield* onLine(trailing);
        }
      }
    });

  yield* Stream.runForEach(stream, (chunk) =>
    Effect.gen(function* () {
      bytes += chunk.byteLength;
      if (bytes > maxOutputBytes) {
        return yield* new GitCommandError({
          operation: input.operation,
          command: quoteGitCommand(input.args),
          cwd: input.cwd,
          detail: `${quoteGitCommand(input.args)} output exceeded ${maxOutputBytes} bytes and was truncated.`,
        });
      }
      const decoded = decoder.decode(chunk, { stream: true });
      text += decoded;
      lineBuffer += decoded;
      yield* emitCompleteLines(false);
    }),
  ).pipe(Effect.mapError(toGitCommandError(input, "output stream failed.")));

  const remainder = decoder.decode();
  text += remainder;
  lineBuffer += remainder;
  yield* emitCompleteLines(true);
  return text;
});
