// FILE: CodexResetCreditCard.tsx
// Purpose: Displays Codex rate-limit reset credits in Settings → Usage, with a
// "Reset now" button that consumes one credit via the server RPC.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import type {
  CodexResetCredit,
  ServerProviderUsageLimit,
  ServerProviderUsageSnapshot,
} from "@synara/contracts";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { ChevronDownIcon } from "~/lib/icons";
import { formatRateLimitResetTime } from "~/lib/rateLimits";
import { consumeCodexResetCreditMutationOptions } from "~/lib/serverReactQuery";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";

export function CodexResetCreditCard({ snapshot }: { snapshot: ServerProviderUsageSnapshot }) {
  const credits = snapshot.rateLimitResetCredits;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const queryClient = useQueryClient();
  const mutation = useMutation(consumeCodexResetCreditMutationOptions({ queryClient }));

  const doConsume = useCallback(() => {
    mutation.mutate({ idempotencyKey: crypto.randomUUID() });
    setConfirmOpen(false);
  }, [mutation]);

  if (!credits || credits.availableCount <= 0) return null;

  return (
    <div className="border-t border-[color:var(--color-border)] pt-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <Popover>
            <PopoverTrigger className="inline-flex items-center gap-1 rounded text-xs font-medium text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background">
              {credits.availableCount === 1
                ? "1 reset credit available"
                : `${credits.availableCount} reset credits available`}
              <ChevronDownIcon className="size-3 text-muted-foreground" aria-hidden="true" />
            </PopoverTrigger>
            <PopoverPopup className="w-80 p-3" align="start">
              <ResetCreditInfo
                credits={credits.credits ?? []}
                availableCount={credits.availableCount}
                nextExpiresAt={credits.nextExpiresAt}
                limits={snapshot.limits}
              />
            </PopoverPopup>
          </Popover>
          {credits.nextExpiresAt && (
            <div className="text-[11px] text-muted-foreground">
              Expires {formatRateLimitResetTime(credits.nextExpiresAt)}
            </div>
          )}
        </div>

        <button
          type="button"
          className="inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-transparent px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent/60 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => setConfirmOpen(true)}
        >
          {mutation.isPending ? "Using reset…" : "Reset now"}
        </button>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Reset Codex limits?</DialogTitle>
            <DialogDescription>
              This uses one Codex reset credit and resets any eligible usage windows immediately.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button onClick={doConsume} disabled={mutation.isPending}>
              Reset now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ResetCreditInfo({
  credits,
  availableCount,
  nextExpiresAt,
  limits,
}: {
  credits: ReadonlyArray<CodexResetCredit>;
  availableCount: number;
  nextExpiresAt: string | undefined;
  limits: ReadonlyArray<ServerProviderUsageLimit>;
}) {
  const sorted = useMemo(
    () =>
      [...credits].sort((a, b) => {
        const aMs = a.expiresAt ? Date.parse(a.expiresAt) : Number.POSITIVE_INFINITY;
        const bMs = b.expiresAt ? Date.parse(b.expiresAt) : Number.POSITIVE_INFINITY;
        return aMs - bMs;
      }),
    [credits],
  );

  // Prefer an explicit per-credit expiry. When the backend doesn't return one, fall back to the
  // earliest known usage-window reset time so the user still has a concrete "use by" anchor.
  const fallbackExpiry = useMemo(() => {
    const resets = limits
      .map((limit) => limit.resetsAt)
      .filter((v): v is string => typeof v === "string")
      .map((iso) => Date.parse(iso))
      .filter((ms) => Number.isFinite(ms) && ms > Date.now())
      .sort((a, b) => a - b);
    return resets[0] !== undefined ? new Date(resets[0]).toISOString() : undefined;
  }, [limits]);

  const useByIso = nextExpiresAt ?? fallbackExpiry;

  return (
    <div className="space-y-3">
      <div>
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          What it resets
        </div>
        {limits.length > 0 ? (
          <ul className="mt-1.5 flex flex-wrap gap-1">
            {limits.map((limit) => (
              <li
                key={limit.window}
                className="rounded-md border border-[color:var(--color-border)] bg-background/40 px-2 py-0.5 text-[11px] text-foreground"
              >
                {limit.window}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">
            All eligible usage windows reset immediately.
          </p>
        )}
      </div>

      {useByIso && (
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Use by
          </div>
          <div className="mt-0.5 text-xs text-foreground">
            {formatRateLimitResetTime(useByIso)}
            {availableCount > 1 && sorted.length > 0
              ? " (earliest of " + availableCount + ")"
              : null}
          </div>
        </div>
      )}

      {sorted.length > 0 && (
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Each credit
          </div>
          <ul className="mt-1.5 space-y-1.5">
            {sorted.map((credit, index) => {
              const isNext = index === 0;
              const label = credit.expiresAt
                ? `Expires ${formatRateLimitResetTime(credit.expiresAt)}`
                : "Expires later";
              return (
                <li
                  key={`${credit.expiresAt ?? "no-expiry"}-${index}`}
                  className="flex items-center justify-between gap-2 rounded-md border border-[color:var(--color-border)] bg-background/40 px-2.5 py-1.5 text-xs"
                >
                  <span className="text-muted-foreground">
                    {credit.grantedAt
                      ? `Granted ${formatRateLimitResetTime(credit.grantedAt)}`
                      : "Available"}
                  </span>
                  <span className={isNext ? "font-medium text-foreground" : "text-foreground"}>
                    {label}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
