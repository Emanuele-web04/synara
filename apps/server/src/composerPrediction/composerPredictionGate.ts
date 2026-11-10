// FILE: composerPredictionGate.ts
// Purpose: The one condition under which this host serves composer predictions. The
//          `server.generateComposerPrediction` RPC and the environment descriptor's
//          `composerPredictions` capability both read it, so they cannot disagree.
// Layer: Server runtime gate (read by ComposerPredictionService and ServerEnvironment)
// Exports: isServerComposerPredictionsEnabled

import { COMPOSER_PREDICTIONS_BETA_FEATURE } from "@synara/shared/betaFeatures";

import { isServerBetaFeatureEnabled } from "../betaFeatureGate.ts";

/** Whether this host's Beta gate lets composer predictions run (off on the Stable desktop build). */
export const isServerComposerPredictionsEnabled = (): boolean =>
  isServerBetaFeatureEnabled(COMPOSER_PREDICTIONS_BETA_FEATURE);
