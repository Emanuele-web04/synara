import { AutomationId, type AutomationProposalState } from "@synara/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ProposalActions } from "~/components/ui/proposal-actions";
import { toastManager } from "~/components/ui/toast";
import { ensureNativeApi } from "~/nativeApi";
import { useTranslation } from "~/i18n";

export const automationProposalListQueryKey = ["automation-proposals", "include-archived"] as const;

export function AutomationProposalActions({
  automationId,
  onResolved,
}: {
  readonly automationId: string;
  readonly onResolved?: (resolution: Exclude<AutomationProposalState, "pending">) => void;
}) {
  const { t } = useTranslation();

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
        title: t("automation:couldNotUpdateAutomationProposal"),
        description: error instanceof Error ? error.message : String(error),
      }),
  });

  return (
    <ProposalActions
      pending={resolutionMutation.isPending}
      onResolve={(resolution) => resolutionMutation.mutate(resolution)}
    />
  );
}
