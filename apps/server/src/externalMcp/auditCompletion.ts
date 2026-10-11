import { Effect } from "effect";

export interface ExternalMcpAuditCompletion {
  readonly auditId: string;
  readonly outcome: string;
  readonly createdTaskIds?: ReadonlyArray<string>;
  readonly detail?: string;
}

const describeFailure = (value: unknown) =>
  value instanceof Error ? value.message : String(value);

/**
 * Keep audit persistence best-effort without losing the intended completion.
 * A failed write stays pending so the request finalizer can retry the same
 * outcome; audit telemetry must never replace an already-produced tool result.
 */
export const makeExternalMcpAuditCompletion = (
  finishAudit: (input: ExternalMcpAuditCompletion) => Effect.Effect<void, unknown>,
) => {
  let pending: ExternalMcpAuditCompletion | null = null;

  const markPending = (input: ExternalMcpAuditCompletion): void => {
    pending = input;
  };

  const complete = (input: ExternalMcpAuditCompletion): Effect.Effect<void> => {
    markPending(input);
    return finishAudit(input).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          if (pending === input) pending = null;
        }),
      ),
      Effect.catch((error) =>
        Effect.logWarning("external MCP audit completion failed", {
          auditId: input.auditId,
          error: describeFailure(error),
        }),
      ),
      Effect.catchDefect((defect) =>
        Effect.logWarning("external MCP audit completion failed", {
          auditId: input.auditId,
          error: describeFailure(defect),
        }),
      ),
    );
  };

  const retryPending = () => (pending === null ? Effect.void : complete(pending));

  return { markPending, complete, retryPending } as const;
};
