/** record durably before the renderer answers quit (survives teardown; a failed write falls back to plain interrupt-and-quit); a cancelled quit's record is removed after QUIT_RESUME_ABANDON_AFTER_MS; at next start the record is claimed atomically before commands admit, filtered for threads that moved on, and each resume carries a resumePrecondition the decider re-checks inside serialized dispatch */
import type {
  OrchestrationCommand,
  OrchestrationPrepareQuitResumeInput,
  OrchestrationPrepareQuitResumeResult,
  OrchestrationProject,
  OrchestrationThread,
} from "@synara/contracts";
import {
  CommandId,
  IsoDateTime,
  MessageId,
  QUIT_RESUME_MAX_PROMPT_CHARS,
  QUIT_RESUME_MAX_THREADS,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "@synara/contracts";
import { Duration, Effect, FileSystem, Schema } from "effect";
import { randomUUID } from "node:crypto";

import { writeFileStringAtomically } from "../atomicWrite";
import { ServerConfig } from "../config";
import {
  threadHasInFlightTurn,
  threadResumePreconditionViolation,
  type ThreadResumePreconditionViolation,
} from "./commandInvariants.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";

/** a quit normally stops this process within seconds — a record still owned by a live process this long belongs to a cancelled quit */
export const QUIT_RESUME_ABANDON_AFTER_MS = 30_000;

/** sleep without keeping the Node process alive during a normal desktop shutdown */
const sleepUnref = (duration: Duration.Input) =>
  Effect.callback<void>((resume) => {
    const timer = setTimeout(
      () => resume(Effect.void),
      Duration.toMillis(Duration.fromInputUnsafe(duration)),
    );
    timer.unref();
    return Effect.sync(() => clearTimeout(timer));
  });

export const QuitResumeRecord = Schema.Struct({
  version: Schema.Literal(1),
  /** unique per quit — command/message ids derive from it so replays dedup and quits never collide */
  recordId: TrimmedNonEmptyString,
  recordedAt: IsoDateTime,
  continuationPrompt: TrimmedNonEmptyString.check(Schema.isMaxLength(QUIT_RESUME_MAX_PROMPT_CHARS)),
  threads: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      /** the turn in flight when recorded; null while the provider was connecting */
      turnId: Schema.NullOr(TurnId),
    }),
  ).check(Schema.isMaxLength(QUIT_RESUME_MAX_THREADS)),
});
export type QuitResumeRecord = typeof QuitResumeRecord.Type;

const decodeQuitResumeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(QuitResumeRecord));

type ThreadTurnStartCommand = Extract<OrchestrationCommand, { readonly type: "thread.turn.start" }>;
type ThreadTurnInterruptCommand = Extract<
  OrchestrationCommand,
  { readonly type: "thread.turn.interrupt" }
>;

export type QuitResumeRecordableThread = Pick<
  OrchestrationThread,
  "id" | "deletedAt" | "latestTurn" | "session"
>;

export type QuitResumeThread = Pick<
  OrchestrationThread,
  | "id"
  | "projectId"
  | "deletedAt"
  | "archivedAt"
  | "latestTurn"
  | "session"
  | "runtimeMode"
  | "interactionMode"
>;
export type QuitResumeProject = Pick<OrchestrationProject, "id" | "deletedAt">;

export type QuitResumeSkipReason =
  | "thread-missing"
  | "thread-deleted"
  | "project-missing"
  | ThreadResumePreconditionViolation;

export interface QuitResumePlan {
  readonly commands: ReadonlyArray<ThreadTurnStartCommand>;
  readonly skipped: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly reason: QuitResumeSkipReason;
  }>;
}

function inFlightTurnId(thread: QuitResumeRecordableThread): TurnId | null {
  return (
    thread.session?.activeTurnId ??
    (thread.latestTurn?.state === "running" ? thread.latestTurn.turnId : null)
  );
}

/** only threads genuinely in flight are remembered — the dialog shows a snapshot and a chat that finished while it was open has nothing to resume; unknown/deleted dropped, duplicates collapse */
export function buildQuitResumeRecord(input: {
  readonly request: OrchestrationPrepareQuitResumeInput;
  readonly threads: ReadonlyArray<QuitResumeRecordableThread>;
  readonly recordId: string;
  readonly now: string;
}): QuitResumeRecord {
  const threadsById = new Map(input.threads.map((thread) => [thread.id, thread] as const));
  const seen = new Set<ThreadId>();
  const threads: Array<QuitResumeRecord["threads"][number]> = [];
  for (const threadId of input.request.threadIds) {
    if (seen.has(threadId)) {
      continue;
    }
    seen.add(threadId);
    const thread = threadsById.get(threadId);
    if (!thread || thread.deletedAt !== null || !threadHasInFlightTurn(thread)) {
      continue;
    }
    threads.push({ threadId, turnId: inFlightTurnId(thread) });
  }
  return {
    version: 1,
    recordId: input.recordId,
    recordedAt: input.now,
    continuationPrompt: input.request.continuationPrompt,
    threads,
  };
}

export function buildQuitInterruptCommand(input: {
  readonly threadId: ThreadId;
  readonly turnId: TurnId | null;
  readonly recordId: string;
  readonly recordedAt: string;
}): ThreadTurnInterruptCommand {
  return {
    type: "thread.turn.interrupt",
    commandId: CommandId.makeUnsafe(`quit-resume-interrupt:${input.recordId}:${input.threadId}`),
    threadId: input.threadId,
    ...(input.turnId !== null ? { turnId: input.turnId } : {}),
    createdAt: input.recordedAt,
  };
}

/** resumed only when the thread still exists, isn't deleted, its project exists, and the precondition is clear; uses the thread's own settings (model omitted → reactor uses current selection); ids derive from the record so a re-run collides with receipt dedup */
export function planQuitResumeTurns(input: {
  readonly record: QuitResumeRecord;
  readonly threads: ReadonlyArray<QuitResumeThread>;
  readonly projects: ReadonlyArray<QuitResumeProject>;
  readonly now: string;
}): QuitResumePlan {
  const threadsById = new Map(input.threads.map((thread) => [thread.id, thread] as const));
  const liveProjectIds = new Set(
    input.projects.filter((project) => project.deletedAt === null).map((project) => project.id),
  );
  const commands: ThreadTurnStartCommand[] = [];
  const skipped: Array<{ threadId: ThreadId; reason: QuitResumeSkipReason }> = [];
  const skip = (threadId: ThreadId, reason: QuitResumeSkipReason) => {
    skipped.push({ threadId, reason });
  };

  for (const entry of input.record.threads) {
    const thread = threadsById.get(entry.threadId);
    if (!thread) {
      skip(entry.threadId, "thread-missing");
      continue;
    }
    if (thread.deletedAt !== null) {
      skip(entry.threadId, "thread-deleted");
      continue;
    }
    if (!liveProjectIds.has(thread.projectId)) {
      skip(entry.threadId, "project-missing");
      continue;
    }
    const resumePrecondition = {
      recordedTurnId: entry.turnId,
      recordedAt: input.record.recordedAt,
    };
    const violation = threadResumePreconditionViolation(thread, resumePrecondition);
    if (violation) {
      skip(entry.threadId, violation);
      continue;
    }
    const key = `quit-resume:${input.record.recordId}:${entry.threadId}`;
    commands.push({
      type: "thread.turn.start",
      commandId: CommandId.makeUnsafe(key),
      threadId: entry.threadId,
      message: {
        messageId: MessageId.makeUnsafe(key),
        role: "user",
        text: input.record.continuationPrompt,
        attachments: [],
      },
      dispatchMode: "queue",
      dispatchOrigin: "automation",
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      resumePrecondition,
      createdAt: input.now,
    });
  }

  return { commands, skipped };
}

export const persistQuitResumeRecord = (input: {
  readonly path: string;
  readonly record: QuitResumeRecord;
}) =>
  writeFileStringAtomically({
    filePath: input.path,
    contents: `${JSON.stringify(input.record)}\n`,
  });

export const clearQuitResumeRecord = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(path, { force: true });
  });

export type QuitResumeRecordRead =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "record"; readonly record: QuitResumeRecord };

/** `absent` = no file; `invalid` = a file that isn't a readable record */
export const readQuitResumeRecord = (
  path: string,
): Effect.Effect<QuitResumeRecordRead, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return { kind: "absent" } as const;
    }
    const raw = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return { kind: "invalid" } as const;
    }
    return yield* decodeQuitResumeRecord(trimmed).pipe(
      Effect.map((record) => ({ kind: "record", record }) as const),
      Effect.orElseSucceed(() => ({ kind: "invalid" }) as const),
    );
  });

/** atomic rename to a claimant-unique private path — a second process can win at most once without deleting the first's file; a private copy left by a crash is never mistaken for a fresh record */
export const claimQuitResumeRecord = (
  path: string,
): Effect.Effect<QuitResumeRecordRead, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const claimedPath = `${path}.${process.pid}.${randomUUID()}.claimed`;
    const exists = yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return { kind: "absent" } as const;
    }
    const claimed = yield* fs.rename(path, claimedPath).pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logWarning("quit-resume record could not be claimed; skipping resume", {
          path,
          cause,
        }).pipe(Effect.as(false)),
      ),
    );
    if (!claimed) {
      return { kind: "absent" } as const;
    }
    const read = yield* readQuitResumeRecord(claimedPath);
    yield* clearQuitResumeRecord(claimedPath).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("claimed quit-resume record could not be removed", {
          path: claimedPath,
          cause,
        }),
      ),
    );
    return read;
  });

/** remove only if still the record with `recordId` — a newer quit may have replaced it */
const clearQuitResumeRecordIfOwned = (path: string, recordId: string) =>
  Effect.gen(function* () {
    const current = yield* readQuitResumeRecord(path);
    if (current.kind !== "record" || current.record.recordId !== recordId) {
      return false;
    }
    yield* clearQuitResumeRecord(path);
    return true;
  });

/** record first (failure fails the RPC so the renderer falls back), arm the abandon sweep immediately, then interrupt; interrupt failures are logged not surfaced — the record is durable and restart reconciliation heals any unreached turn */
export const prepareQuitResume = (input: {
  readonly request: OrchestrationPrepareQuitResumeInput;
  readonly recordPath: string;
  readonly getReadModel: () => Effect.Effect<
    { readonly threads: ReadonlyArray<QuitResumeRecordableThread> },
    never
  >;
  readonly dispatch: (command: OrchestrationCommand) => Effect.Effect<unknown, unknown>;
  readonly abandonAfter?: Duration.Input;
}): Effect.Effect<OrchestrationPrepareQuitResumeResult, unknown, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    // stamp before the snapshot — anything completing after is provably "completed since the record" for the precondition
    const now = new Date().toISOString();
    const readModel = yield* input.getReadModel();
    const record = buildQuitResumeRecord({
      request: input.request,
      threads: readModel.threads,
      recordId: randomUUID(),
      now,
    });
    yield* persistQuitResumeRecord({ path: input.recordPath, record });
    yield* Effect.logInfo("recorded running chats for resume after quit", {
      recordId: record.recordId,
      threadIds: record.threads.map((entry) => entry.threadId),
    });

    yield* sleepUnref(input.abandonAfter ?? Duration.millis(QUIT_RESUME_ABANDON_AFTER_MS)).pipe(
      Effect.andThen(clearQuitResumeRecordIfOwned(input.recordPath, record.recordId)),
      Effect.flatMap((cleared) =>
        cleared
          ? Effect.logWarning("quit did not complete; dropped the quit-resume record", {
              recordId: record.recordId,
            })
          : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("quit-resume abandon sweep failed", { recordId: record.recordId, cause }),
      ),
      // detached on purpose — the sweep must outlive this request; if the process exits first the fiber dies with it
      Effect.forkDetach,
    );

    // the durable write is the RPC acknowledgement contract — interrupts are best-effort and must not make the renderer miss its bounded quit wait
    yield* Effect.forEach(
      record.threads,
      (entry) =>
        input
          .dispatch(
            buildQuitInterruptCommand({
              threadId: entry.threadId,
              turnId: entry.turnId,
              recordId: record.recordId,
              recordedAt: record.recordedAt,
            }),
          )
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to interrupt chat for quit", {
                threadId: entry.threadId,
                cause,
              }),
            ),
          ),
      { discard: true, concurrency: "unbounded" },
    ).pipe(Effect.forkDetach);

    return {
      recordedThreadIds: record.threads.map((entry) => entry.threadId),
      recordedAt: record.recordedAt,
    };
  });

/** must run before commands are admitted so no freshly prepared quit can interleave; cheap when there's nothing to resume; never fails — resuming is best-effort */
export const claimQuitResumeRecordAtStartup: Effect.Effect<
  QuitResumeRecordRead,
  never,
  ServerConfig | FileSystem.FileSystem
> = Effect.gen(function* () {
  const config = yield* ServerConfig;
  // claim before dispatching — a second process or mid-dispatch crash must never resume twice; an unreadable record is consumed too so it isn't re-parsed every boot
  const claimed = yield* claimQuitResumeRecord(config.quitResumeStatePath);
  if (claimed.kind === "invalid") {
    yield* Effect.logWarning("dropped an unreadable quit-resume record", {
      path: config.quitResumeStatePath,
    });
  }
  return claimed;
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logWarning("claiming the quit-resume record failed", { cause }).pipe(
      Effect.as({ kind: "absent" } as const),
    ),
  ),
);

/** runs once after restart reconciliation settles orphaned turns; every failure contained and logged — resuming must never affect startup */
export const resumeQuitInterruptedChats = (
  claimed: QuitResumeRecordRead,
): Effect.Effect<void, never, OrchestrationEngineService> =>
  Effect.gen(function* () {
    if (claimed.kind !== "record") {
      return;
    }
    const record = claimed.record;
    const engine = yield* OrchestrationEngineService;

    const readModel = yield* engine.getReadModel();
    const plan = planQuitResumeTurns({
      record,
      threads: readModel.threads,
      projects: readModel.projects,
      now: new Date().toISOString(),
    });

    if (plan.skipped.length > 0) {
      yield* Effect.logInfo("skipping quit-resume for threads that moved on", {
        recordId: record.recordId,
        skipped: plan.skipped,
      });
    }
    if (plan.commands.length === 0) {
      return;
    }

    yield* Effect.logInfo("resuming chats interrupted by the previous quit", {
      recordId: record.recordId,
      recordedAt: record.recordedAt,
      threadIds: plan.commands.map((command) => command.threadId),
    });

    yield* Effect.forEach(
      plan.commands,
      (command) =>
        engine.dispatch(command).pipe(
          // the decider re-checks the precondition atomically — a rejection means the thread moved on between plan and dispatch
          Effect.catchTag("OrchestrationCommandInvariantError", (error) =>
            Effect.logInfo("quit-resume turn was not accepted", {
              threadId: command.threadId,
              detail: error.detail,
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("quit-resume turn failed to dispatch", {
              threadId: command.threadId,
              cause,
            }),
          ),
        ),
      { discard: true },
    );
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("resuming chats after quit failed", { cause })),
  );
