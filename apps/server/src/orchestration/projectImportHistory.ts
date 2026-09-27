import type {
  ProjectImportProvider,
  ProviderInstanceId,
  ProviderStartOptions,
  ThreadHandoffImportedMessage,
  ThreadId,
} from "@synara/contracts";
import { Data, Effect } from "effect";
import { readClaudeImportMessageDates } from "../provider/claudeProjectImport";
import type { ProviderAdapterRegistryShape } from "../provider/Services/ProviderAdapterRegistry";
import { readClaudeSessionMessagesInEnvironment } from "./importThreadRoute";
import { mapClaudeSessionMessages, mapCodexSnapshotMessages } from "./importedThreadMessages";

export class ProjectImportError extends Data.TaggedError("ProjectImportError")<{
  readonly message: string;
}> {}

export const projectImportPromise = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new ProjectImportError({ message: cause instanceof Error ? cause.message : String(cause) }),
  });

export function nativeImportId(provider: ProjectImportProvider, cursor: unknown): string | null {
  if (!cursor || typeof cursor !== "object") return null;
  const value =
    provider === "codex"
      ? (cursor as { threadId?: unknown }).threadId
      : (cursor as { resume?: unknown }).resume;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export interface ReadProjectImportHistoryInput {
  readonly provider: ProjectImportProvider;
  readonly threadId: ThreadId;
  readonly nativeId: string;
  readonly sourceHome: string;
  readonly sourceCwd: string;
  readonly sourceCreatedAt: string;
  readonly providerOptions?: ProviderStartOptions;
  readonly providerInstanceId?: ProviderInstanceId;
  /** Claude account environment when its config dir is not the server's own. */
  readonly claudeEnvironment?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

export function makeProjectImportHistoryReader(registry: ProviderAdapterRegistryShape) {
  return Effect.fn(function* (
    input: ReadProjectImportHistoryInput,
  ): Effect.fn.Return<ReadonlyArray<ThreadHandoffImportedMessage>, unknown> {
    if (input.provider === "claudeAgent") {
      const messages = yield* projectImportPromise(async () => {
        // The fork has a new identity. Read that frozen copy, never the mutable original.
        const [history, dates] = await Promise.all([
          readClaudeSessionMessagesInEnvironment({
            sessionId: input.nativeId,
            dir: input.sourceCwd,
            environment: input.claudeEnvironment,
          }),
          readClaudeImportMessageDates({ sessionId: input.nativeId, configDir: input.sourceHome }),
        ]);
        return history.map((message) => ({ ...message, timestamp: dates.get(message.uuid) }));
      });
      return mapClaudeSessionMessages({
        threadId: input.threadId,
        importedAt: input.sourceCreatedAt,
        messages,
      });
    }
    const adapter = yield* registry.getByProvider("codex");
    const snapshot = (yield* adapter.hasSession(input.threadId))
      ? yield* adapter.readThread(input.threadId)
      : adapter.readExternalThread
        ? yield* adapter.readExternalThread({
            externalThreadId: input.nativeId,
            ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
            ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
            ...(input.cwd ? { cwd: input.cwd } : {}),
          })
        : yield* new ProjectImportError({ message: "Codex history discovery is unavailable." });
    return mapCodexSnapshotMessages({
      threadId: input.threadId,
      importedAt: input.sourceCreatedAt,
      turns: snapshot.turns,
    });
  });
}
