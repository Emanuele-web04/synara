import type { ClientOrchestrationCommand, OrchestrationCommand } from "@synara/contracts";
import { isWorkspaceRootWithin, workspaceRootsEqual } from "@synara/shared/threadWorkspace";
import type { FileSystem, Path } from "effect";
import { Effect, Schedule } from "effect";

import { createAttachmentId } from "../attachmentStore";

export interface DispatchCommandNormalizerResult<E> {
  readonly command: OrchestrationCommand;
  /** callers must run this only after the decider accepted the command — a rejected dispatch never mutates the filesystem */
  readonly prepareWorkspaceRoot: Effect.Effect<void, E> | null;
}

export interface DispatchCommandNormalizerOptions<E> {
  readonly attachmentsDir: string;
  readonly chatWorkspaceRoot?: string;
  readonly studioWorkspaceRoot?: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly canonicalizeProjectWorkspaceRoot: (
    workspaceRoot: string,
    options?: { readonly createIfMissing?: boolean },
  ) => Effect.Effect<string, E>;
  readonly prepareChatWorkspaceRoot?: (workspaceRoot: string) => Effect.Effect<void, E>;
  readonly prepareStudioWorkspaceRoot?: (workspaceRoot: string) => Effect.Effect<void, E>;
}

// scaffolding (idempotent mkdir) can transiently fail on a flaky fs; running AFTER acceptance means one failure would permanently strand the project row — chat roots have no other re-run site, so retry bounded with backoff
const WORKSPACE_ROOT_PREPARE_RETRY_SCHEDULE = Schedule.exponential("100 millis").pipe(
  Schedule.take(2),
);

export function makeDispatchCommandNormalizer<E>(options: DispatchCommandNormalizerOptions<E>) {
  // the kinds differ only in prepareWhenEqualToRoot: chat roots always live strictly WITHIN chatWorkspaceRoot (equality excluded — never scaffold into the shared parent), while the Studio container's root IS studioWorkspaceRoot (equality triggers)
  const maybePrepareWorkspaceRoot = (input: {
    readonly kind: "chat" | "studio";
    readonly command: Extract<
      ClientOrchestrationCommand,
      { type: "project.create" | "project.meta.update" }
    >;
    readonly workspaceRoot: string;
    readonly configuredWorkspaceRoot: string | undefined;
    readonly prepare: ((workspaceRoot: string) => Effect.Effect<void, E>) | undefined;
    readonly prepareWhenEqualToRoot: boolean;
  }) => {
    const {
      kind,
      command,
      workspaceRoot,
      configuredWorkspaceRoot,
      prepare,
      prepareWhenEqualToRoot,
    } = input;
    if (
      command.kind !== kind ||
      command.createWorkspaceRootIfMissing !== true ||
      !configuredWorkspaceRoot ||
      !prepare
    ) {
      return Effect.void;
    }
    const isWithin = isWorkspaceRootWithin(workspaceRoot, configuredWorkspaceRoot);
    const isEqual = workspaceRootsEqual(workspaceRoot, configuredWorkspaceRoot);
    const shouldPrepare = prepareWhenEqualToRoot ? isWithin || isEqual : isWithin && !isEqual;
    if (!shouldPrepare) {
      return Effect.void;
    }
    return prepare(workspaceRoot).pipe(Effect.retry(WORKSPACE_ROOT_PREPARE_RETRY_SCHEDULE));
  };
  const maybePrepareChatWorkspaceRoot = (
    command: Extract<
      ClientOrchestrationCommand,
      { type: "project.create" | "project.meta.update" }
    >,
    workspaceRoot: string,
  ) =>
    maybePrepareWorkspaceRoot({
      kind: "chat",
      command,
      workspaceRoot,
      configuredWorkspaceRoot: options.chatWorkspaceRoot,
      prepare: options.prepareChatWorkspaceRoot,
      prepareWhenEqualToRoot: false,
    });
  const maybePrepareStudioWorkspaceRoot = (
    command: Extract<
      ClientOrchestrationCommand,
      { type: "project.create" | "project.meta.update" }
    >,
    workspaceRoot: string,
  ) =>
    maybePrepareWorkspaceRoot({
      kind: "studio",
      command,
      workspaceRoot,
      configuredWorkspaceRoot: options.studioWorkspaceRoot,
      prepare: options.prepareStudioWorkspaceRoot,
      prepareWhenEqualToRoot: true,
    });

  // the decision logic is evaluated eagerly here (pure, side-effect-free) but the `prepare` effect is only constructed, never run until the caller executes it
  const deferredPrepareWorkspaceRoot = (
    command: Extract<
      ClientOrchestrationCommand,
      { type: "project.create" | "project.meta.update" }
    >,
    workspaceRoot: string,
  ): Effect.Effect<void, E> =>
    Effect.all(
      [
        maybePrepareChatWorkspaceRoot(command, workspaceRoot),
        maybePrepareStudioWorkspaceRoot(command, workspaceRoot),
      ],
      { discard: true },
    );

  return Effect.fnUntraced(function* (input: { readonly command: ClientOrchestrationCommand }) {
    if (input.command.type === "project.create") {
      // canonicalization may create the (empty) root before the decider validates ownership — realpath needs it to exist and lexical comparison mishandles symlinks; a rejected command can leave an empty dir but never scaffolding
      const workspaceRoot = yield* options.canonicalizeProjectWorkspaceRoot(
        input.command.workspaceRoot,
        {
          createIfMissing: input.command.createWorkspaceRootIfMissing === true,
        },
      );
      const command = {
        ...input.command,
        workspaceRoot,
        createWorkspaceRootIfMissing: input.command.createWorkspaceRootIfMissing === true,
      } satisfies OrchestrationCommand;
      return {
        command,
        prepareWorkspaceRoot: deferredPrepareWorkspaceRoot(input.command, workspaceRoot),
      };
    }

    if (input.command.type === "project.meta.update" && input.command.workspaceRoot !== undefined) {
      const workspaceRoot = yield* options.canonicalizeProjectWorkspaceRoot(
        input.command.workspaceRoot,
        {
          createIfMissing: input.command.createWorkspaceRootIfMissing === true,
        },
      );
      const command = {
        ...input.command,
        workspaceRoot,
        createWorkspaceRootIfMissing: input.command.createWorkspaceRootIfMissing === true,
      } satisfies OrchestrationCommand;
      return {
        command,
        prepareWorkspaceRoot: deferredPrepareWorkspaceRoot(input.command, workspaceRoot),
      };
    }

    if (input.command.type !== "thread.turn.start") {
      return {
        command: input.command as OrchestrationCommand,
        prepareWorkspaceRoot: null,
      };
    }
    const turnStartCommand = input.command;

    const normalizedAttachments = yield* Effect.forEach(
      turnStartCommand.message.attachments,
      (attachment) =>
        Effect.gen(function* () {
          if (attachment.type === "assistant-selection") {
            const attachmentId = createAttachmentId(turnStartCommand.threadId);
            if (!attachmentId) {
              return yield* Effect.fail(new Error("Failed to create a safe attachment id."));
            }

            return {
              type: "assistant-selection" as const,
              id: attachmentId,
              assistantMessageId: attachment.assistantMessageId,
              text: attachment.text,
            };
          }

          // binary attachment metadata resolves from the durable ledger immediately before the atomic event/receipt claim — client metadata is never authoritative
          return attachment;
        }),
      { concurrency: 1 },
    );

    return {
      command: {
        ...turnStartCommand,
        message: {
          ...turnStartCommand.message,
          attachments: normalizedAttachments,
        },
      } satisfies OrchestrationCommand,
      prepareWorkspaceRoot: null,
    };
  });
}
