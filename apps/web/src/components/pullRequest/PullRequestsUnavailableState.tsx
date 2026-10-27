// FILE: PullRequestsUnavailableState.tsx
// Purpose: Actionable empty state for the pull requests surface when the GitHub CLI is missing,
//          unauthenticated, rate-limited, or a request otherwise failed — each case gets a short
//          explanation and a copyable terminal command or reset time instead of a dead end.
// Layer: Pull request presentation
// Exports: PullRequestsUnavailableState, isPullRequestsUnavailableError

import { useEffect, useRef, useState } from "react";

import { useAppSettings } from "~/appSettings";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { CheckIcon, CopyIcon, GitPullRequestIcon, TriangleAlertIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { formatShortTimestamp } from "~/timestampFormat";
import { PR_FINE_TEXT_CLASS_NAME, PR_META_TEXT_CLASS_NAME } from "./pullRequestText";
import { useTranslation } from "~/i18n";

export function isPullRequestsUnavailableError(error: unknown): error is {
  _tag: "PullRequestsUnavailableError";
  reason: string;
  message: string;
  retryAt?: string;
} {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "PullRequestsUnavailableError"
  );
}

function githubCliInstallCommand(platform: string): string | null {
  if (/mac/i.test(platform)) return "brew install gh";
  if (/win/i.test(platform)) return "winget install --id GitHub.cli";
  return null;
}

/** A single copyable terminal command — the `brew install gh` / `gh auth login` affordances. */
function CommandLine({ command }: { command: string }) {
  const { t } = useTranslation();

  const [copied, setCopied] = useState(false);
  const mountedRef = useRef(true);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    };
  }, []);

  return (
    <button
      type="button"
      onClick={() => {
        void copyTextToClipboard(command).then(
          () => {
            if (!mountedRef.current) return;
            setCopied(true);
            if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
            resetTimerRef.current = window.setTimeout(() => {
              resetTimerRef.current = null;
              setCopied(false);
            }, 1500);
          },
          (error) => {
            if (!mountedRef.current) return;
            toastManager.add({
              type: "error",
              title: t("git:couldNotCopyCommand"),
              description: error instanceof Error ? error.message : t("git:clipboardAccessFailed"),
            });
          },
        );
      }}
      title={t("chat:messageCopy_copyToClipboard")}
      className="group flex w-full items-center gap-2 rounded-lg border border-border/60 bg-[var(--color-background-elevated-secondary)] px-3 py-2 text-left transition-colors hover:border-border"
    >
      <code
        className={cn(PR_META_TEXT_CLASS_NAME, "min-w-0 flex-1 truncate font-mono text-foreground")}
      >
        {command}
      </code>
      <span
        className={cn(
          PR_FINE_TEXT_CLASS_NAME,
          "flex shrink-0 items-center gap-1 text-muted-foreground transition-colors group-hover:text-foreground",
          copied && "text-emerald-600 dark:text-emerald-400",
        )}
      >
        {copied ? (
          <>
            <CheckIcon className="size-3" /> {t("chat:theme_copied")}
          </>
        ) : (
          <>
            <CopyIcon className="size-3" /> {t("workspace:share_copy")}
          </>
        )}
      </span>
    </button>
  );
}

export function PullRequestsUnavailableState({
  error,
  onRetry,
  subject: subjectProp,
}: {
  error: unknown;
  /** Optional refetch hook so "Retry" re-runs the failed query instead of reloading the app. */
  onRetry?: () => void;
  /** What failed to load, as a plural noun for the title ("Pull requests are unavailable"). */
  subject?: string;
}) {
  const { t, formatLocale } = useTranslation();

  const subject = subjectProp ?? "Pull requests";
  const { settings } = useAppSettings();
  const unavailable = isPullRequestsUnavailableError(error) ? error : null;
  const notInstalled = unavailable?.reason === "gh-not-installed";
  const notAuthenticated = unavailable?.reason === "gh-not-authenticated";
  const rateLimited = unavailable?.reason === "rate-limited";
  const resetTime =
    rateLimited && unavailable?.retryAt
      ? formatShortTimestamp(unavailable.retryAt, settings.timestampFormat, formatLocale)
      : null;
  const installCommand =
    notInstalled && typeof navigator !== "undefined"
      ? githubCliInstallCommand(navigator.platform)
      : null;

  return (
    <Empty className="py-16">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <GitPullRequestIcon />
        </EmptyMedia>
        <EmptyTitle>
          {notInstalled
            ? t("git:gitHubCLIIsRequired")
            : notAuthenticated
              ? t("git:signInToGitHubCLI")
              : rateLimited
                ? t("git:gitHubRateLimitReached")
                : t("git:areUnavailable", { value0: subject })}
        </EmptyTitle>
        <EmptyDescription>
          {notInstalled
            ? t("git:synaraReadsGitHubDataOnlyThroughTheGhCLI")
            : notAuthenticated
              ? t("git:authenticateTheGitHubCLIInATerminalThenRetry")
              : rateLimited
                ? resetTime
                  ? t("git:synaraPausesGitHubRequestsUntilTheLimitResetsAt", {
                      value0: resetTime,
                    })
                  : t("git:synaraPausesGitHubRequestsUntilTheLimitResets")
                : error instanceof Error
                  ? error.message
                  : t("git:theRequestToGitHubFailed")}
        </EmptyDescription>
      </EmptyHeader>
      {notInstalled || notAuthenticated ? (
        <EmptyContent>
          {notAuthenticated ? <CommandLine command="gh auth login" /> : null}
          {installCommand ? <CommandLine command={installCommand} /> : null}
          <div className="flex w-full items-center gap-2">
            {notInstalled ? (
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() => void ensureNativeApi().shell.openExternal("https://cli.github.com/")}
              >
                {t("git:installInstructions")}
              </Button>
            ) : null}
            {onRetry ? (
              <Button
                variant={notInstalled ? "ghost" : "outline"}
                size="sm"
                className="flex-1"
                onClick={onRetry}
              >
                {t("common:common_retry")}
              </Button>
            ) : null}
          </div>
        </EmptyContent>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <div
            className={cn(
              PR_META_TEXT_CLASS_NAME,
              "flex items-center gap-1.5 text-muted-foreground",
            )}
          >
            <TriangleAlertIcon className="size-3.5" />
            <span>
              {rateLimited
                ? t("git:theListRefreshesOnItsOwnOnceTheLimit")
                : t("git:checkYourConnectionAndTryAgain")}
            </span>
          </div>
          {onRetry ? (
            <Button variant="outline" size="sm" onClick={onRetry}>
              {t("common:common_retry")}
            </Button>
          ) : null}
        </div>
      )}
    </Empty>
  );
}
