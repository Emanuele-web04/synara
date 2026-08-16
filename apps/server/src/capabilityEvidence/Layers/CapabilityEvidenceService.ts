import { Layer } from "effect";

import { CapabilityEvidenceRepositoryLive } from "./CapabilityEvidenceRepository.ts";
import {
  CapabilityEvidenceService,
  makeCapabilityEvidenceService,
} from "../Services/CapabilityEvidenceService.ts";
import {
  CapabilityPolicyEngine,
  makeCapabilityPolicyEngine,
} from "../Services/CapabilityPolicyEngine.ts";

export const CapabilityPolicyEngineLive = Layer.effect(
  CapabilityPolicyEngine,
  makeCapabilityPolicyEngine,
);

export const CapabilityEvidenceServiceLayer = Layer.effect(
  CapabilityEvidenceService,
  makeCapabilityEvidenceService,
);

/**
 * The capability/evidence service graph: repository (append-only persistence),
 * policy engine (pure verdict derivation), and the service that glues them.
 * The service layer is `provideMerge`d over its two dependency layers so the
 * result has no service requirement beyond SQLite.
 */
export const capabilityEvidenceLayer = CapabilityEvidenceServiceLayer.pipe(
  Layer.provideMerge(CapabilityEvidenceRepositoryLive),
  Layer.provideMerge(CapabilityPolicyEngineLive),
);
