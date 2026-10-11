import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { PersistenceSqlError } from "../../persistence/Errors.ts";

export interface DiagnosticThreadActivity {
  readonly activityId: string;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly tone: string;
  readonly kind: string;
  readonly summary: string;
  readonly payload: unknown;
  readonly sequence: number;
  readonly createdAt: string;
}

export interface OperationalDiagnostic {
  readonly sequence: number;
  readonly threadId: string | null;
  readonly source: "server" | "browser";
  readonly kind: string;
  readonly severity: "info" | "warning" | "error";
  readonly code: string | null;
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
  readonly occurredAt: string;
}

export interface DiagnosticPageInput {
  readonly threadId: string;
  readonly throughSequenceInclusive?: number;
  readonly beforeSequenceExclusive?: number;
  readonly limit: number;
  readonly turnId?: string;
  readonly kinds?: ReadonlyArray<string>;
}

export interface ThreadDiagnosticsQueryShape {
  readonly getActivityCoverage: (
    threadId: string,
  ) => Effect.Effect<
    { readonly highWaterSequence: number; readonly unsequencedCount: number },
    PersistenceSqlError
  >;
  readonly listActivities: (
    input: DiagnosticPageInput,
  ) => Effect.Effect<ReadonlyArray<DiagnosticThreadActivity>, PersistenceSqlError>;
  readonly recordOperationalDiagnostic: (input: {
    readonly threadId?: string;
    readonly source: "server" | "browser";
    readonly kind: string;
    readonly severity: "info" | "warning" | "error";
    readonly code?: string;
    readonly detail: Readonly<Record<string, string | number | boolean | null>>;
    readonly occurredAt: string;
  }) => Effect.Effect<void, PersistenceSqlError>;
  readonly listOperationalDiagnostics: (input: {
    readonly threadId: string;
    readonly beforeSequenceExclusive?: number;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<OperationalDiagnostic>, PersistenceSqlError>;
}

export class ThreadDiagnosticsQuery extends ServiceMap.Service<
  ThreadDiagnosticsQuery,
  ThreadDiagnosticsQueryShape
>()("synara/diagnostics/Services/ThreadDiagnosticsQuery") {}
