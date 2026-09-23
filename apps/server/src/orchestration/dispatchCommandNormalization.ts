import type {
  ClientOrchestrationCommand,
  OrchestrationCommand,
  ProjectId,
} from "@synara/contracts";
import { isWorkspaceRootWithin, workspaceRootsEqual } from "@synara/shared/threadWorkspace";
import type { FileSystem, Path } from "effect";
import { Effect, Schedule } from "effect";

import { createAttachmentId } from "../attachmentStore";
import { slugifyGroupTitle } from "../groupWorkspaceScaffold";

export interface DispatchCommandNormalizerResult<E> {
  readonly command: OrchestrationCommand;
  /**
   * Deferred workspace-root scaffolding decided during normalization but NOT yet executed.
   * Callers must run this only after the normalized command has been successfully accepted
   * by the orchestration decider (e.g. after `orchestrationEngine.dispatch` resolves), so a
   * rejected dispatch (for example a cross-kind workspace-root ownership conflict) never
   * mutates the filesystem.
   */
  readonly prepareWorkspaceRoot: Effect.Effect<void, E> | null;
}

export interface DispatchCommandNormalizerOptions<E> {
  readonly attachmentsDir: string;
  readonly chatWorkspaceRoot?: string;
  readonly studioWorkspaceRoot?: string;
  readonly groupsWorkspaceRoot?: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly canonicalizeProjectWorkspaceRoot: (
    workspaceRoot: string,
    options?: { readonly createIfMissing?: boolean },
  ) => Effect.Effect<string, E>;
  /**
   * Workspace roots already claimed by live group projects. Used to keep the
   * derived group folder unique across renames and same-title creates.
   */
  readonly listGroupWorkspaceRoots?: () => Effect.Effect<
    ReadonlyArray<{ readonly projectId: ProjectId; readonly workspaceRoot: string }>,
    E
  >;
  readonly prepareChatWorkspaceRoot?: (workspaceRoot: string) => Effect.Effect<void, E>;
  readonly prepareStudioWorkspaceRoot?: (workspaceRoot: string) => Effect.Effect<void, E>;
  readonly prepareGroupWorkspaceRoot?: (workspaceRoot: string) => Effect.Effect<void, E>;
}

// Deferred workspace-root scaffolding (mkdir of managed subdirectories like Inbox/Outbox/
// work/outputs) can transiently fail on a flaky filesystem even though the underlying
// operation is safe to retry (it's idempotent recursive directory creation). Since this runs
// AFTER the orchestration decider has already accepted the dispatch (see wsRpc), a single
// transient failure here would otherwise permanently strand the project row without its
// managed subdirectories — Studio self-heals via studio.listThreadOutputs, but per-thread CHAT
// workspace roots have no other re-run site. Retry a bounded number of times with a short
// backoff before letting the failure surface to the caller.
const WORKSPACE_ROOT_PREPARE_RETRY_SCHEDULE = Schedule.exponential("100 millis").pipe(
  Schedule.take(2),
);

export function makeDispatchCommandNormalizer<E>(options: DispatchCommandNormalizerOptions<E>) {
  // Group folders are derived from the title alone, so same-slug titles (or
  // titles that collapse to the same slug) must not share one folder. Reserve
  // the first free slug against both the live group read-model rows (excluding
  // the command's own project on meta.update) and the directories already on
  // disk under groupsWorkspaceRoot.
  const resolveGroupWorkspaceRoot = (input: {
    readonly kind: string | undefined;
    readonly title: string | undefined;
    readonly workspaceRoot: string;
    readonly excludeProjectId?: ProjectId | undefined;
  }): Effect.Effect<string, E> => {
    const { kind, title, workspaceRoot, excludeProjectId } = input;
    if (kind !== "group" || !options.groupsWorkspaceRoot) {
      return Effect.succeed(workspaceRoot);
    }
    const groupsWorkspaceRoot = options.groupsWorkspaceRoot;
    const baseSlug = slugifyGroupTitle(title?.trim() || workspaceRoot);
    return Effect.gen(function* () {
      const takenRoots: string[] = [];
      let ownRoot: string | null = null;
      if (options.listGroupWorkspaceRoots) {
        const groupRoots = yield* options.listGroupWorkspaceRoots();
        for (const row of groupRoots) {
          if (excludeProjectId !== undefined && row.projectId === excludeProjectId) {
            // The project's own folder must not push itself to a -2 suffix
            // when meta.update re-derives the root.
            ownRoot = row.workspaceRoot;
            continue;
          }
          takenRoots.push(row.workspaceRoot);
        }
      }
      const ownDirName = ownRoot === null ? null : options.path.basename(ownRoot).toLowerCase();
      const directoryNames: ReadonlyArray<string> =
        typeof options.fileSystem.readDirectory === "function"
          ? yield* options.fileSystem
              .readDirectory(groupsWorkspaceRoot)
              .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)))
          : [];
      const takenDirNames = new Set(
        directoryNames.map((name) => name.toLowerCase()).filter((name) => name !== ownDirName),
      );
      for (let suffix = 1; ; suffix += 1) {
        const slug = suffix === 1 ? baseSlug : `${baseSlug}-${suffix}`;
        const candidateRoot = options.path.join(groupsWorkspaceRoot, slug);
        const claimedByProject = takenRoots.some((root) =>
          workspaceRootsEqual(root, candidateRoot),
        );
        if (!claimedByProject && !takenDirNames.has(slug.toLowerCase())) {
          return candidateRoot;
        }
      }
    });
  };

  // Shared "should we scaffold this managed workspace root's subdirectories" guard for both
  // container kinds. The two kinds intentionally differ in exactly one respect
  // (`prepareWhenEqualToRoot`):
  //   - chat: per-thread project workspace roots always live strictly WITHIN chatWorkspaceRoot
  //     (see buildChatWorkspaceFolderPath in chatFirstSend.ts); the shared chatWorkspaceRoot
  //     itself is never used directly as a project's root, so exact equality must be excluded
  //     to avoid ever scaffolding "work"/"outputs" straight into the shared parent directory.
  //   - studio: the legacy Studio container's workspace root IS exactly
  //     studioWorkspaceRoot, so exact equality must trigger prepare.
  //   - group: each group lives in its own subfolder under groupsWorkspaceRoot, never at the
  //     Groups parent itself, so exact equality must be excluded like chat.
  const maybePrepareWorkspaceRoot = (input: {
    readonly kind: "chat" | "studio" | "group";
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
  const maybePrepareGroupWorkspaceRoot = (
    command: Extract<
      ClientOrchestrationCommand,
      { type: "project.create" | "project.meta.update" }
    >,
    workspaceRoot: string,
  ) =>
    maybePrepareWorkspaceRoot({
      kind: "group",
      command,
      workspaceRoot,
      configuredWorkspaceRoot: options.groupsWorkspaceRoot,
      prepare: options.prepareGroupWorkspaceRoot,
      prepareWhenEqualToRoot: false,
    });

  // Combines the chat + studio scaffolding decisions into a single deferred effect. The
  // decision logic (kinds, prepareWhenEqualToRoot, isWorkspaceRootWithin/workspaceRootsEqual)
  // is evaluated eagerly here (it's pure and side-effect-free), but the resulting `prepare`
  // effect is only *constructed*, never run, until the caller explicitly executes it.
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
        maybePrepareGroupWorkspaceRoot(command, workspaceRoot),
      ],
      { discard: true },
    );

  return Effect.fnUntraced(function* (input: { readonly command: ClientOrchestrationCommand }) {
    if (input.command.type === "project.create") {
      // Known trade-off: canonicalization may create the (empty) root directory before the
      // decider validates ownership — realpath-based canonicalization needs the directory to
      // exist, and comparing lexical paths instead would mis-handle symlinked roots. A rejected
      // command can therefore leave an empty directory behind, but never scaffolding: the
      // subdirectory prepare is deferred until the dispatch is accepted (see wsRpc).
      const requestedWorkspaceRoot = yield* resolveGroupWorkspaceRoot({
        kind: input.command.kind,
        title: input.command.title,
        workspaceRoot: input.command.workspaceRoot,
      });
      const workspaceRoot = yield* options.canonicalizeProjectWorkspaceRoot(
        requestedWorkspaceRoot,
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
      const requestedWorkspaceRoot = yield* resolveGroupWorkspaceRoot({
        kind: input.command.kind,
        title: input.command.title,
        workspaceRoot: input.command.workspaceRoot,
        excludeProjectId: input.command.projectId,
      });
      const workspaceRoot = yield* options.canonicalizeProjectWorkspaceRoot(
        requestedWorkspaceRoot,
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

          // Binary attachment metadata is resolved from the durable managed
          // attachment ledger by OrchestrationEngine immediately before its
          // atomic event/receipt claim. Client metadata is never authoritative.
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
