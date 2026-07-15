// FILE: CodexResetCreditCard.tsx
// Purpose: Displays Codex rate-limit reset credits in Settings → Usage, with a
// "Reset now" button that consumes one credit via the server RPC.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import type { ServerProviderUsageSnapshot } from "@synara/contracts";

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
            <PopoverPopup className="w-64 p-3" align="start">
              <div className="space-y-1">
                <div className="text-xs text-foreground">
                  {credits.availableCount === 1
                    ? "1 reset credit"
                    : `${credits.availableCount} reset credits`}
                </div>
                {credits.nextExpiresAt ? (
                  <div className="text-[11px] text-muted-foreground">
                    Expires {formatRateLimitResetTime(credits.nextExpiresAt)}
                  </div>
                ) : (
                  <div className="text-[11px] text-muted-foreground">No expiry available</div>
                )}
              </div>
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
