// FILE: synbotGate.ts
// Purpose: The server's authoritative SynBot (Beta-only) gate. Stable refuses every `bots.*`
//          RPC and bot gateway tool, and runs no SynBot background work.
// Layer: Runtime gate
// Exports: SYNBOT_UNAVAILABLE_MESSAGE, isServerSynbotEnabled

import { SYNBOT_BETA_FEATURE } from "@synara/shared/betaFeatures";

import { isServerBetaFeatureEnabled } from "../betaFeatureGate";
import { isServerGroupsEnabled } from "../projectAgent/groupsBetaGate";

export const SYNBOT_UNAVAILABLE_MESSAGE = "SynBot is available in Synara Beta.";

/** SynBot runs on Hubs, so it needs both its own Beta gate and the Hubs gate. */
export const isServerSynbotEnabled = (): boolean =>
  isServerBetaFeatureEnabled(SYNBOT_BETA_FEATURE) && isServerGroupsEnabled();
