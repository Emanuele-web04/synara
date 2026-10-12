// Scope every measurement to an exact provider turn; context-window totals are cumulative.
export interface RetryAttemptActivity {
  readonly kind: string;
  readonly turnId: string | null;
  readonly createdAt: string;
  readonly payload: unknown;
}

export interface RetryAttemptMetrics {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly durationMs?: number;
  readonly costUsd?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeTokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Never turn missing or malformed historical provider usage into zero-valued estimates. */
export function parseRetryAttemptMetrics(value: unknown): RetryAttemptMetrics {
  const data = asRecord(value);
  if (!data) return {};
  const inputTokens = safeTokens(data.inputTokens);
  const outputTokens = safeTokens(data.outputTokens);
  const totalTokens = safeTokens(data.totalTokens);
  const validTokens =
    inputTokens !== undefined &&
    outputTokens !== undefined &&
    totalTokens !== undefined &&
    inputTokens + outputTokens === totalTokens;
  const durationMs = safeNumber(data.durationMs);
  const costUsd = safeNumber(data.costUsd);
  return {
    ...(validTokens ? { inputTokens, outputTokens, totalTokens } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

/** Read only the named turn's completed runtime event; no session-wide token inference. */
export function deriveRetryAttemptMetrics(
  activities: ReadonlyArray<RetryAttemptActivity>,
  turnId: string | null | undefined,
): RetryAttemptMetrics {
  if (!turnId) return {};
  const ours = activities.filter((row) => row.turnId === turnId);
  const completed = ours.findLast((row) => row.kind === "turn.completed");
  if (!completed) return {};
  const payload = asRecord(completed.payload);
  const modelUsage = asRecord(payload?.modelUsage);
  let usage: RetryAttemptMetrics = {};
  if (modelUsage && Object.keys(modelUsage).length > 0) {
    let inputTokens = 0;
    let outputTokens = 0;
    let valid = true;
    for (const source of Object.values(modelUsage)) {
      const model = asRecord(source);
      const input = safeTokens(model?.inputTokens);
      const output = safeTokens(model?.outputTokens);
      const total = safeTokens(model?.totalTokens);
      if (
        input === undefined ||
        output === undefined ||
        total === undefined ||
        input + output !== total
      ) {
        valid = false;
        break;
      }
      inputTokens += input;
      outputTokens += output;
      if (!Number.isSafeInteger(inputTokens + outputTokens)) {
        valid = false;
        break;
      }
    }
    if (valid) usage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
  }
  const started = ours.find((row) => row.kind === "turn.started");
  const from = Date.parse(started?.createdAt ?? "");
  const to = Date.parse(completed.createdAt);
  const durationMs =
    Number.isFinite(from) && Number.isFinite(to) && to >= from ? to - from : undefined;
  return {
    ...usage,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...parseRetryAttemptMetrics({ costUsd: payload?.totalCostUsd }),
  };
}
