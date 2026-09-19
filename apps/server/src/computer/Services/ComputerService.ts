import { ServiceMap } from "effect";

import type { ComputerAvailability } from "@synara/contracts";
import type { ComputerApprovalGate } from "../ComputerApprovalGate.ts";
import type { ComputerManager } from "../ComputerManager.ts";

export interface ComputerServiceShape {
  readonly supported: boolean;
  readonly availability: ComputerAvailability;
  readonly manager: ComputerManager;
  /**
   * The Synara-owned approval gate for providers without a native permission
   * callback. Owned here so the agent gateway (which asks) and the provider
   * service (which relays the user's answer) reach the same instance through
   * the layer graph rather than a module singleton.
   */
  readonly approvalGate: ComputerApprovalGate;
}

export class ComputerService extends ServiceMap.Service<ComputerService, ComputerServiceShape>()(
  "synara/computer/Services/ComputerService",
) {}
