// FILE: CodexResetCreditCard.tsx
// Purpose: Displays Codex rate-limit reset credits in Settings → Usage, with a
// "Reset now" button that consumes one credit via the server RPC.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import type { ServerProviderUsageSnapshot } from "@synara/contracts";

import { useAppSettings } from "~/appSettings";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { formatRateLimitResetTime } from "~/lib/rateLimits";
import { consumeCodexResetCreditMutationOptions } from "~/lib/serverReactQuery";

export function CodexResetCreditCard({
  snapshot,
}: {
  snapshot: ServerProviderUsageSnapshot;
}) {
  const credits = snapshot.rateLimitResetCredits;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const queryClient = useQueryClient();
  const mutation = useMutation(consumeCodexResetCreditMutationOptions({ queryClient }));
  const { settings, updateSettings } = useAppSettings();
  const skipConfirm = settings.skipCodexRateLimitResetConfirm === true;

  const doConsume = useCallback(() => {
    mutation.mutate({ idempotencyKey: crypto.randomUUID() });
    setConfirmOpen(false);
  }, [mutation]);

  if (!credits || credits.availableCount <= 0) return null;

  return (
    <div className="border-t border-[color:var(--color-border)] pt-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-xs font-medium text-foreground">
            {credits.availableCount === 1
              ? "1 reset credit available"
              : `${credits.availableCount} reset credits available`}
          </div>
          {credits.nextExpiresAt && (
            <div className="text-[11px] text-muted-foreground">
              Expires {formatRateLimitResetTime(credits.nextExpiresAt)}
            </div>
          )}
        </div>
        <Button
          size="xs"
          variant="outline"
          disabled={mutation.isPending}
          onClick={() => (skipConfirm ? doConsume() : setConfirmOpen(true))}
        >
          {mutation.isPending ? "Using reset…" : "Reset now"}
        </Button>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Reset Codex limits?</DialogTitle>
            <DialogDescription>
              This uses one Codex reset credit and resets any eligible usage
              windows immediately.
            </DialogDescription>
          </DialogHeader>
          <label className="flex cursor-pointer items-center gap-2 px-1 py-1 text-xs">
            <Checkbox
              checked={skipConfirm}
              onCheckedChange={() =>
                updateSettings({ skipCodexRateLimitResetConfirm: !skipConfirm })
              }
            />
            <span>Don't ask again</span>
          </label>
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
