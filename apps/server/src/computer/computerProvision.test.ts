import { describe, expect, it } from "vitest";
import { COMPUTER_PROVISION_SUMMARY_MAX_LENGTH } from "@synara/contracts";

import { ComputerManager } from "./ComputerManager.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";

/** A fake that actually offers setup, returning the scripted provision transcript. */
class ProvisioningFakeBackend extends FakeComputerBackend {
  provisionCalls = 0;
  constructor(private readonly transcript: string) {
    super();
  }

  async provision(): Promise<string> {
    this.provisionCalls += 1;
    return this.transcript;
  }
}

describe("computer provision", () => {
  it("engages the backend first, so setup reads the live desktop", async () => {
    const backend = new ProvisioningFakeBackend("Computer permissions are ready.");
    const manager = new ComputerManager({ backend });
    try {
      await manager.provision();
      // Engaged means the establishing read, never the passive probe.
      expect(backend.callsFor("availability").length).toBeGreaterThan(0);
      expect(backend.callsFor("probeAvailability")).toHaveLength(0);
      expect(backend.provisionCalls).toBe(1);
    } finally {
      await manager.dispose();
    }
  });

  it("throws without provisioning when the backend has nothing to install", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    try {
      await expect(manager.provision()).rejects.toThrow("nothing to install");
      expect((await manager.getStatus()).provisionable).toBe(false);
    } finally {
      await manager.dispose();
    }
  });

  it("clamps the transcript and answers with the post-setup status", async () => {
    const backend = new ProvisioningFakeBackend("L".repeat(100_000));
    const manager = new ComputerManager({ backend });
    try {
      const result = await manager.provision();
      expect(result.summary).toHaveLength(COMPUTER_PROVISION_SUMMARY_MAX_LENGTH);
      expect(result.status.computerId).toBe("desktop");
      expect(result.status.availability).toEqual({ kind: "available", backend: "fake" });
      expect(result.status.health.status).toBe("connected");
      expect(result.status.capabilities.input).toBe(true);
      expect(result.status.provisionable).toBe(true);
    } finally {
      await manager.dispose();
    }
  });
});
