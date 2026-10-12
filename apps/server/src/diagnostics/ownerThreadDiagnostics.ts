import {
  ServerReadThreadDiagnosticsResult,
  type ServerReadThreadDiagnosticsInput,
} from "@synara/contracts";
import { Effect, Schema } from "effect";
import {
  makeThreadDiagnosticPageReaders,
  type ThreadDiagnosticPageDependencies,
} from "../agentGateway/threadDiagnosticTools.ts";

/** The authenticated owner WS route and provider MCP transport use the same
 * readers, retention boundaries, cursor validation and payload sanitizer. */
export function makeOwnerThreadDiagnosticReader(input: ThreadDiagnosticPageDependencies) {
  const readers = makeThreadDiagnosticPageReaders(input);
  return (
    request: ServerReadThreadDiagnosticsInput,
  ): Effect.Effect<ServerReadThreadDiagnosticsResult, Error> => {
    const { source, ...args } = request;
    if (
      (source === "events" && (args.turnId !== undefined || args.includeDetails !== undefined)) ||
      (source === "runtime" && args.payloadMode !== undefined)
    ) {
      return Effect.fail(new Error("Diagnostic options do not match the requested source."));
    }
    const reader = source === "events" ? readers.readEvents : readers.readRuntimeEvents;
    return Effect.suspend(() => reader.handler(args)).pipe(
      // Validation and storage failures can fail the Effect directly instead
      // of returning an MCP error result. Keep both paths behind the same
      // owner-facing redaction boundary.
      Effect.catchDefect(() => Effect.fail(new Error("Thread diagnostic request was refused."))),
      Effect.mapError(() => new Error("Thread diagnostic request was refused.")),
      Effect.flatMap((result) => {
        const content = result.content[0];
        if (result.isError || result.content.length !== 1 || content?.type !== "text") {
          // Errors may include source paths or arbitrary provider text. The
          // owner receives an honest failure, never an unredacted error body.
          return Effect.fail(new Error("Thread diagnostic request was refused."));
        }
        return Effect.try({
          try: () =>
            Schema.decodeUnknownSync(ServerReadThreadDiagnosticsResult)(JSON.parse(content.text)),
          catch: () => new Error("Thread diagnostic response was invalid."),
        });
      }),
    );
  };
}
