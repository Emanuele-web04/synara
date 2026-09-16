import type { ClaudeCacheObservation } from "@synara/contracts";
import { assessClaudeCache } from "@synara/shared/claudeCache";
import { formatContextWindowTokens } from "~/lib/contextWindow";

export function ClaudeCacheDetails({
  observation,
  nowMs,
}: {
  observation: ClaudeCacheObservation;
  nowMs: number;
}) {
  const assessment = assessClaudeCache(observation, nowMs);
  const label =
    assessment.state === "likely-warm"
      ? "Likely warm"
      : assessment.state === "likely-expired"
        ? "Likely expired"
        : "Unknown";
  const usage = observation.lastRequest;

  return (
    <div className="space-y-1.5 border-t border-border/50 pt-2 text-xs text-muted-foreground">
      <div className="font-medium text-foreground">Claude prompt cache: {label}</div>
      {observation.ttlSeconds !== undefined ? (
        <div>Observed lifetime: {formatCacheDuration(observation.ttlSeconds)}</div>
      ) : (
        <div>Cache lifetime is unavailable.</div>
      )}
      {assessment.idleSeconds !== undefined ? (
        <div>Last response: {formatCacheDuration(assessment.idleSeconds)} ago</div>
      ) : null}
      {assessment.state === "likely-expired" && observation.contextTokens !== undefined ? (
        <p className="max-w-72 leading-relaxed">
          The next request may reprocess about{" "}
          {formatContextWindowTokens(observation.contextTokens)} tokens.
        </p>
      ) : null}
      {usage ? (
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
          <dt>Last request · cache read</dt>
          <dd className="text-right tabular-nums">
            {formatCacheTokens(usage.cacheReadInputTokens)}
          </dd>
          <dt>Cache written</dt>
          <dd className="text-right tabular-nums">
            {formatCacheTokens(usage.cacheCreationInputTokens)}
          </dd>
          <dt>Input outside cache</dt>
          <dd className="text-right tabular-nums">{formatCacheTokens(usage.inputTokens)}</dd>
        </dl>
      ) : null}
      <p className="max-w-72 leading-relaxed">
        Cache state is estimated. It does not measure your plan's remaining usage.
      </p>
    </div>
  );
}

function formatCacheTokens(value: number | undefined): string {
  return value === undefined ? "Unavailable" : `${formatContextWindowTokens(value)} tokens`;
}

export function formatCacheDuration(seconds: number): string {
  if (seconds < 60) return "less than a minute";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours} ${hours === 1 ? "hour" : "hours"}${remainingMinutes > 0 ? ` ${remainingMinutes} min` : ""}`;
}
