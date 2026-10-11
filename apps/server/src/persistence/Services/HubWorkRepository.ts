import type { HubWorkRecord, ProjectId, ThreadId } from "@synara/contracts";
import { Effect, Schema, ServiceMap } from "effect";

export class HubWorkRepositoryError extends Schema.TaggedErrorClass<HubWorkRepositoryError>()(
  "HubWorkRepositoryError",
  {
    message: Schema.String,
    code: Schema.Literals(["storage", "conflict", "not-found"]),
    cause: Schema.optional(Schema.Defect),
  },
) {}

export interface HubWorkRepositoryShape {
  readonly submit: (
    records: readonly HubWorkRecord[],
  ) => Effect.Effect<
    { readonly items: readonly HubWorkRecord[]; readonly replayed: boolean },
    HubWorkRepositoryError
  >;
  readonly list: (
    projectId: ProjectId,
  ) => Effect.Effect<readonly HubWorkRecord[], HubWorkRepositoryError>;
  readonly get: (id: string) => Effect.Effect<HubWorkRecord | null, HubWorkRepositoryError>;
  readonly findByWorker: (
    threadId: ThreadId,
  ) => Effect.Effect<HubWorkRecord | null, HubWorkRepositoryError>;
  readonly listQueuedProjects: () => Effect.Effect<readonly ProjectId[], HubWorkRepositoryError>;
  readonly listPendingProjects: () => Effect.Effect<readonly ProjectId[], HubWorkRepositoryError>;
  readonly claimNext: (
    projectId: ProjectId,
  ) => Effect.Effect<HubWorkRecord | null, HubWorkRepositoryError>;
  readonly reserveWorker: (input: {
    readonly threadId: ThreadId;
    readonly commandId: string;
    readonly messageId: string;
  }) => Effect.Effect<HubWorkRecord | null, HubWorkRepositoryError>;
  readonly save: (input: {
    readonly record: HubWorkRecord;
    readonly expectedRevision: number;
  }) => Effect.Effect<HubWorkRecord, HubWorkRepositoryError>;
  readonly deleteProject: (projectId: ProjectId) => Effect.Effect<void, HubWorkRepositoryError>;
}

export class HubWorkRepository extends ServiceMap.Service<
  HubWorkRepository,
  HubWorkRepositoryShape
>()("synara/persistence/Services/HubWorkRepository") {}
