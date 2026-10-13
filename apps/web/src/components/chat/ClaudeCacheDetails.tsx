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
      ? t("Likely warm")
      : assessment.state === "likely-expired"
        ? t("Likely expired")
        : t("Unknown");
  const usage = observation?.lastRequest;

  return (
    <div className="space-y-1.5 border-t border-border/50 pt-2 text-ui leading-snug text-muted-foreground">
      <div className="font-medium text-foreground">
        {t("Claude prompt cache:")} {label}
      </div>
      {observation?.ttlSeconds !== undefined ? (
        <div>
          {t("Observed lifetime:")}{" "}
          {observation.partialTtlSeconds !== undefined
            ? t("{{value0}} to ", { value0: formatCacheDuration(observation.partialTtlSeconds) })
            : ""}
          {formatCacheDuration(observation.ttlSeconds)}
        </div>
      ) : (
        <div>{t("Cache lifetime is unavailable.")}</div>
      )}
      {assessment.idleSeconds !== undefined ? (
        <div>
          {t("Last response: {{duration}} ago", {
            duration: formatCacheDuration(assessment.idleSeconds),
          })}
        </div>
      ) : null}
      {assessment.state === "likely-expired" && observation?.contextTokens !== undefined ? (
        <p className="max-w-72 leading-relaxed">
          {t("The next request may reprocess about")}{" "}
          {formatContextWindowTokens(observation.contextTokens)} {t("tokens.")}
        </p>
      ) : null}
      {usage ? (
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
          <dt>{t("Last request · cache read")}</dt>
          <dd className="text-right tabular-nums">
            {formatCacheTokens(usage.cacheReadInputTokens)}
          </dd>
          <dt>{t("Cache written")}</dt>
          <dd className="text-right tabular-nums">
            {formatCacheTokens(usage.cacheCreationInputTokens)}
          </dd>
          <dt>{t("Input outside cache")}</dt>
          <dd className="text-right tabular-nums">{formatCacheTokens(usage.inputTokens)}</dd>
        </dl>
      ) : null}
      <p className="max-w-72 leading-relaxed">
        {t("Cache state is estimated. It does not measure your plan's remaining usage.")}
      </p>
    </div>
  );
}

function formatCacheTokens(value: number | undefined): string {
  return value === undefined
    ? t("Unavailable")
    : t("{{count}} tokens", { count: formatContextWindowTokens(value) });
}

export function formatCacheDuration(seconds: number): string {
  if (seconds < 60) return t("less than a minute");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} ${t(minutes === 1 ? "minute" : "minutes")}`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours} ${t(hours === 1 ? "hour" : "hours")}${remainingMinutes > 0 ? ` ${remainingMinutes} min` : ""}`;
}
