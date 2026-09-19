import type { RuntimeMode } from "@synara/contracts";

/**
 * Second-app consent for Computer calls, below the tool approval.
 *
 * A thread drives its first app free — task consent covers it — and asks once
 * for each further app. That prompt must stay before the serialized desktop
 * queue and must never fire for a thread that already consented at a broader
 * boundary.
 *
 * Full access is that broader boundary: the tool-level approval already
 * admitted every computer action in the turn, so a second card asks the same
 * user the same question twice. The packaged E2E showed the cost — a
 * full-access run stalled behind "Allow the agent to drive Google Chrome?"
 * raised for the driver-owned isolated Chromium the run itself had launched
 * (the card's app identity resolves to Chrome because the driver's isolated
 * build is a Chromium). Driver-owned browsers are processes this app spawned
 * and owns, and in full access they are covered. Attaching to a user profile
 * is a different boundary and still refuses honestly with
 * `browser_consent_required`, which comes from the driver, not this card.
 *
 * A runtime mode that cannot be read falls through to the card: failing
 * toward asking is honest, failing toward silent consent is not.
 */
export async function secondAppApprovalDecision(input: {
  readonly readRuntimeMode: () => Promise<RuntimeMode | null | undefined>;
  readonly requestApproval: () => Promise<boolean>;
}): Promise<boolean> {
  const runtimeMode = await input.readRuntimeMode().catch(() => null);
  if (runtimeMode === "full-access") return true;
  return input.requestApproval();
}
