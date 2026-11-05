import type { ClaudeCacheObservation } from "@synara/contracts";
import { assessClaudeCache } from "@synara/shared/claudeCache";
import { formatContextWindowTokens } from "~/lib/contextWindow";
import { t, useTranslation } from "~/i18n";

export function ClaudeCacheDetails({
  observation,
  nowMs,
}: {
  observation: ClaudeCacheObservation | undefined;
  nowMs: number;
}) {
  const { t } = useTranslation();

  const assessment = assessClaudeCache(observation, nowMs);
  const label =
    assessment.state === "likely-warm"
      ? t("chat:likelyWarm")
      : assessment.state === "likely-expired"
        ? t("chat:likelyExpired")
        : t("common:common_unknown");
  const usage = observation?.lastRequest;

  return (
    <div className="space-y-1.5 border-t border-border/50 pt-2 text-ui leading-snug text-muted-foreground">
      <div className="font-medium text-foreground">
        {t("chat:claudePromptCache")} {label}
      </div>
      {observation?.ttlSeconds !== undefined ? (
        <div>
          {t("chat:observedLifetime")}{" "}
          {observation.partialTtlSeconds !== undefined
            ? t("chat:to2", { value0: formatCacheDuration(observation.partialTtlSeconds) })
            : ""}
          {formatCacheDuration(observation.ttlSeconds)}
        </div>
      ) : (
        <div>{t("chat:cacheLifetimeIsUnavailable")}</div>
      )}
      {assessment.idleSeconds !== undefined ? (
        <div>
          {t("chat:lastResponseAgo", {
            duration: formatCacheDuration(assessment.idleSeconds),
          })}
        </div>
      ) : null}
      {assessment.state === "likely-expired" && observation?.contextTokens !== undefined ? (
        <p className="max-w-72 leading-relaxed">
          {t("chat:theNextRequestMayReprocessAbout")}{" "}
          {formatContextWindowTokens(observation.contextTokens)} {t("chat:tokens2")}
        </p>
      ) : null}
      {usage ? (
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
          <dt>{t("chat:lastRequestCacheRead")}</dt>
          <dd className="text-right tabular-nums">
            {formatCacheTokens(usage.cacheReadInputTokens)}
          </dd>
          <dt>{t("chat:cacheWritten")}</dt>
          <dd className="text-right tabular-nums">
            {formatCacheTokens(usage.cacheCreationInputTokens)}
          </dd>
          <dt>{t("chat:inputOutsideCache")}</dt>
          <dd className="text-right tabular-nums">{formatCacheTokens(usage.inputTokens)}</dd>
        </dl>
      ) : null}
      <p className="max-w-72 leading-relaxed">
        {t("chat:cacheStateIsEstimatedItDoesNotMeasureYour")}
      </p>
    </div>
  );
}

function formatCacheTokens(value: number | undefined): string {
  return value === undefined
    ? t("chat:providerModelPicker_unavailable")
    : t("chat:tokens3", { count: formatContextWindowTokens(value) });
}

export function formatCacheDuration(seconds: number): string {
  if (seconds < 60) return t("chat:lessThanAMinute");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("chat:cacheDurationMinutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0
    ? t("chat:cacheDurationHoursMinutes", { count: hours, minutes: remainingMinutes })
    : t("chat:cacheDurationHours", { count: hours });
}
