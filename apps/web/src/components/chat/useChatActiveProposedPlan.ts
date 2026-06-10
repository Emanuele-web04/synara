import { useMemo } from "react";
import { type TurnId } from "@t3tools/contracts";
import { findLatestProposedPlan } from "../../session-logic.plan";
import { type ProposedPlan } from "../../types";

interface UseChatActiveProposedPlanParams {
  latestTurnSettled: boolean;
  proposedPlans: ReadonlyArray<ProposedPlan> | undefined;
  latestTurnId: TurnId | null | undefined;
}

export function useChatActiveProposedPlan({
  latestTurnSettled,
  proposedPlans,
  latestTurnId,
}: UseChatActiveProposedPlanParams) {
  return useMemo(() => {
    if (!latestTurnSettled) {
      return null;
    }
    return findLatestProposedPlan(proposedPlans ?? [], latestTurnId ?? null);
  }, [latestTurnId, proposedPlans, latestTurnSettled]);
}
