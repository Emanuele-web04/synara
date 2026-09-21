import type {
  CodexResetCreditOutcome,
  ServerCodexResetCredit,
  ServerCodexResetCredits,
  ServerConsumeCodexResetCreditInput,
} from "@synara/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { showConfirmDialogFallback } from "~/confirmDialogFallback";
import {
  finishCodexResetAttempt,
  prepareCodexResetAttempt,
  readCodexResetAttempt,
} from "~/lib/codexResetAttempt";
import { consumeCodexResetCredit, serverQueryKeys } from "~/lib/serverReactQuery";
import { readNativeApi } from "~/nativeApi";

function formatExpiry(expiresAt: string | undefined, now: number): string {
  if (!expiresAt) return "No expiry listed";
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return "Expired";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `Expires in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `Expires in ${hours}h ${mins % 60}m`;
  return `Expires in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function ProviderUsageResetCredits({
  resetCredits,
  surface = "settings",
}: {
  resetCredits: ServerCodexResetCredits;
  surface?: "settings" | "popover";
}) {
  const { accountId, availableCount, canUse, credits } = resetCredits;
  const queryClient = useQueryClient();
  const locked = useRef(false);
  const [confirming, setConfirming] = useState(false);
  let pendingAttempt: ServerConsumeCodexResetCreditInput | null = null;
  let storageUnavailable = false;
  try {
    pendingAttempt = accountId ? readCodexResetAttempt(accountId) : null;
  } catch {
    storageUnavailable = true;
  }
  const consumeMutation = useMutation({
    mutationFn: consumeCodexResetCredit,
    onSuccess: (result, attempt) => {
      // Every recognized outcome completes the attempt, even if the subsequent usage read fails.
      try {
        finishCodexResetAttempt(attempt);
      } catch {
        /* Retaining the same key remains safe. */
      }
      const messages: Record<CodexResetCreditOutcome, string> = {
        reset: "Codex limits reset.",
        nothingToReset: "Codex limits do not need a reset right now.",
        noCredit: "No banked resets available.",
        alreadyRedeemed: "That reset was already used.",
      };
      toastManager.add({
        type:
          result.outcome === "reset" || result.outcome === "alreadyRedeemed" ? "success" : "info",
        title: messages[result.outcome],
      });
    },
  });
  const confirmAndConsume = async (creditId?: string) => {
    if (!accountId || locked.current) return;
    locked.current = true;
    setConfirming(true);
    try {
      const api = readNativeApi();
      const message =
        "Use one Codex reset?\nThis spends one banked reset and cannot be undone. Synara will check your current account and usage first.";
      const confirmed = api
        ? await api.dialogs.confirm(message)
        : await showConfirmDialogFallback(message);
      if (confirmed)
        await consumeMutation.mutateAsync(prepareCodexResetAttempt(accountId, creditId));
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Reset result not confirmed",
        description:
          error instanceof Error ? error.message : "Retry this reset to check the same attempt.",
      });
    } finally {
      void queryClient.invalidateQueries({ queryKey: serverQueryKeys.allProviderUsage() });
      locked.current = false;
      setConfirming(false);
    }
  };
  if (availableCount <= 0 && !pendingAttempt) return null;
  const now = Date.now();
  const availableCredits = (credits ?? []).filter(
    (credit) =>
      credit.status === "available" && (!credit.expiresAt || Date.parse(credit.expiresAt) > now),
  );
  const rows: Array<ServerCodexResetCredit | undefined> = [...availableCredits];
  if (pendingAttempt && !rows.some((credit) => credit?.id === pendingAttempt.creditId)) {
    rows.unshift(pendingAttempt.creditId ? { id: pendingAttempt.creditId } : undefined);
  } else if (credits === undefined && availableCount > 0) rows.push(undefined);
  const busy = consumeMutation.isPending || confirming;
  const compact = surface === "popover";
  const rowClass = `flex items-center justify-between gap-2 ${compact ? "text-chat-meta leading-tight" : "text-ui leading-snug"}`;
  const subtitleClass = compact
    ? "text-chat-meta leading-tight text-muted-foreground/80"
    : "text-ui-sm text-muted-foreground/80";
  return (
    <div
      className={`space-y-0.5 border-t border-[color:var(--color-border)] ${compact ? "pt-2" : "pt-3"}`}
    >
      <div className={rowClass}>
        <span className="font-medium text-foreground">Banked resets</span>
        <span className="text-right tabular-nums text-muted-foreground">
          {availableCount} available
        </span>
      </div>
      <p className={subtitleClass}>
        {pendingAttempt
          ? "A previous reset is unconfirmed. Retry checks the same attempt."
          : "Use when your 5-hour or weekly limit has 10% or less remaining."}
      </p>
      {rows.length > 0 ? (
        <div className="mt-1.5 space-y-1.5">
          {rows.map((credit, index) => {
            const isRetry = pendingAttempt !== null && pendingAttempt.creditId === credit?.id;
            return (
              <div key={credit?.id ?? "next-available"}>
                <div className={rowClass}>
                  <span className="font-medium text-foreground">
                    {credit ? `Reset ${index + 1}` : "Next available reset"}
                  </span>
                  <Button
                    size="xs"
                    variant="outline"
                    className="shrink-0"
                    disabled={
                      busy ||
                      storageUnavailable ||
                      !accountId ||
                      (!isRetry && (canUse !== true || pendingAttempt !== null))
                    }
                    onClick={() => void confirmAndConsume(credit?.id)}
                  >
                    {busy ? "Applying…" : isRetry ? "Retry reset" : "Use reset"}
                  </Button>
                </div>
                {credit ? (
                  <div className={`${subtitleClass} tabular-nums`} title={credit.expiresAt}>
                    {formatExpiry(credit.expiresAt, now)}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
