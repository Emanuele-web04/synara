// FILE: ProviderUsageResetCredits.tsx
// Purpose: Shared Codex "Banked resets" section for Settings and compact usage popovers.
// Lists pending rate-limit reset credits with expiry and a confirm-gated action per row.

import type { CodexResetCreditOutcome, ServerCodexResetCredit } from "@synara/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { consumeCodexResetCredit, serverQueryKeys } from "~/lib/serverReactQuery";
import { toastManager } from "~/components/ui/toast";

function formatExpiry(expiresAt: string | undefined, now: number): string {
  if (!expiresAt) return "No expiry listed";
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return "Expires now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `Expires in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) {
    const rem = mins % 60;
    return rem > 0 ? `Expires in ${hours}h ${rem}m` : `Expires in ${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `Expires in ${days}d ${remHours}h` : `Expires in ${days}d`;
}

export function ProviderUsageResetCredits({
  credits,
  availableCount,
  surface = "settings",
}: {
  credits: ReadonlyArray<ServerCodexResetCredit>;
  availableCount: number;
  surface?: "settings" | "popover";
}) {
  const queryClient = useQueryClient();
  const [confirmCredit, setConfirmCredit] = useState<ServerCodexResetCredit | null>(null);
  const consumeMutation = useMutation({
    mutationFn: (creditId: string) => consumeCodexResetCredit({ creditId }),
    onSuccess: (result) => {
      const messages: Record<CodexResetCreditOutcome, string> = {
        reset: "Codex limits reset.",
        nothingToReset: "Nothing to reset right now.",
        noCredit: "No banked resets available.",
        alreadyRedeemed: "That reset was already used.",
      };
      toastManager.add({
        type: result.outcome === "reset" ? "success" : "error",
        title: messages[result.outcome],
      });
      void queryClient.invalidateQueries({ queryKey: serverQueryKeys.allProviderUsage() });
    },
    onError: (error: unknown) => {
      toastManager.add({
        type: "error",
        title: "Could not use this reset",
        description: error instanceof Error ? error.message : "The reset request failed.",
      });
    },
  });
  const now = Date.now();
  const classes = surface === "popover"
    ? {
        section: "space-y-0.5 border-t border-[color:var(--color-border)] pt-2",
        row: "flex items-center justify-between gap-2 text-[length:var(--app-font-size-chat-meta,10px)] leading-tight",
        label: "font-medium text-foreground",
        value: "text-right tabular-nums text-muted-foreground",
        subtitle: "text-[length:var(--app-font-size-chat-meta,10px)] leading-tight text-muted-foreground/80",
        list: "mt-1.5 space-y-1.5",
      }
    : {
        section: "space-y-0.5 border-t border-[color:var(--color-border)] pt-3",
        row: "flex items-center justify-between gap-2 text-xs",
        label: "font-medium text-foreground",
        value: "text-right tabular-nums text-muted-foreground",
        subtitle: "text-[11px] text-muted-foreground/80",
        list: "mt-1.5 space-y-1.5",
      };

  if (availableCount <= 0) return null;

  return (
    <div className={classes.section}>
      <div className={classes.row}>
        <span className={classes.label}>Banked resets</span>
        <span className={classes.value}>{`${availableCount} available`}</span>
      </div>
      <p className={classes.subtitle}>
        Using one resets Codex limits immediately.
      </p>

      {credits.length > 0 ? (
        <div className={classes.list}>
          {credits.map((credit, index) => {
            const isPending = consumeMutation.isPending;
            return (
              <div key={credit.id}>
                <div className={classes.row}>
                  <span className={classes.label}>Reset {index + 1}</span>
                  <Button
                    size="xs"
                    variant="outline"
                    className="shrink-0"
                    disabled={consumeMutation.isPending}
                    onClick={() => setConfirmCredit(credit)}
                  >
                    {isPending ? "Applying…" : "Use reset"}
                  </Button>
                </div>
                <div
                  className={`${classes.subtitle} tabular-nums`}
                  title={credit.expiresAt ?? undefined}
                >
                  {formatExpiry(credit.expiresAt, now)}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {/*
        Spending a banked reset takes effect immediately and cannot be undone,
        so it asks first like every other destructive action here.
      */}
      <AlertDialog open={confirmCredit !== null} onOpenChange={(open) => !open && setConfirmCredit(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Use this banked reset?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmCredit?.title ?? "This reset"} will be spent now and your Codex rate limits
              reset immediately. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              Cancel
            </AlertDialogClose>
            <Button
              size="sm"
              disabled={consumeMutation.isPending}
              onClick={() => {
                const credit = confirmCredit;
                setConfirmCredit(null);
                if (credit) consumeMutation.mutate(credit.id);
              }}
            >
              {consumeMutation.isPending ? "Applying…" : "Use reset"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
