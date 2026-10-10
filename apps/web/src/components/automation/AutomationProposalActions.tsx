import { AutomationId, type AutomationProposalState } from "@synara/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { ensureNativeApi } from "~/nativeApi";

export const automationProposalListQueryKey = ["automation-proposals", "include-archived"] as const;

export function AutomationProposalActions({
  automationId,
  onResolved,
}: {
  readonly automationId: string;
  readonly onResolved?: (resolution: Exclude<AutomationProposalState, "pending">) => void;
}) {
  const queryClient = useQueryClient();
  const resolutionMutation = useMutation({
    mutationFn: (resolution: Exclude<AutomationProposalState, "pending">) =>
      ensureNativeApi().automation.resolveProposal({
        automationId: AutomationId.makeUnsafe(automationId),
        resolution,
      }),
    onSuccess: (result, resolution) => {
      onResolved?.(result.definition.proposalState === "dismissed" ? "dismissed" : resolution);
      void queryClient.invalidateQueries({ queryKey: ["automations"] });
      void queryClient.invalidateQueries({ queryKey: automationProposalListQueryKey });
    },
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Could not update automation proposal",
        description: error instanceof Error ? error.message : String(error),
      }),
  });

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={resolutionMutation.isPending}
        onClick={() => resolutionMutation.mutate("dismissed")}
      >
        Dismiss
      </Button>
      <Button
        type="button"
        size="sm"
        disabled={resolutionMutation.isPending}
        onClick={() => resolutionMutation.mutate("accepted")}
      >
        Accept
      </Button>
    </div>
  );
}
