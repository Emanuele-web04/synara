import { ExecutionInstanceId, type OrchestrationThreadRuntime } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { resolveDiffableRemoteInstance } from "./remoteDiffability.ts";

function makeRuntime(input: {
  readonly targetKind: string;
  readonly instance: { readonly status: string; readonly rootPath?: string | null } | null;
}): OrchestrationThreadRuntime {
  return {
    targetKind: input.targetKind,
    instance:
      input.instance === null
        ? null
        : {
            id: ExecutionInstanceId.makeUnsafe("inst-1"),
            provider: "daytona",
            status: input.instance.status,
            rootPath:
              input.instance.rootPath === undefined ? "/root/synara" : input.instance.rootPath,
          },
  } as unknown as OrchestrationThreadRuntime;
}

describe("resolveDiffableRemoteInstance", () => {
  it("returns the instance for a remote thread on a reachable status", () => {
    for (const status of ["starting", "running", "idle"]) {
      const result = resolveDiffableRemoteInstance(
        makeRuntime({ targetKind: "remote-runtime", instance: { status } }),
      );
      expect(result).not.toBeNull();
      expect(result?.provider).toBe("daytona");
      expect(result?.rootPath).toBe("/root/synara");
    }
  });

  it("returns null for a remote thread whose instance status is not reachable", () => {
    const unreachable = [
      "pending",
      "provisioning",
      "stopping",
      "stopped",
      "destroying",
      "destroyed",
      "failed",
      "lost",
      "unknown",
    ];
    for (const status of unreachable) {
      expect(
        resolveDiffableRemoteInstance(
          makeRuntime({ targetKind: "remote-runtime", instance: { status } }),
        ),
      ).toBeNull();
    }
  });

  it("returns null for a remote thread with no provisioned instance", () => {
    expect(
      resolveDiffableRemoteInstance(makeRuntime({ targetKind: "remote-runtime", instance: null })),
    ).toBeNull();
  });

  it("returns null for a local thread and for an absent runtime", () => {
    expect(
      resolveDiffableRemoteInstance(
        makeRuntime({ targetKind: "local", instance: { status: "running" } }),
      ),
    ).toBeNull();
    expect(resolveDiffableRemoteInstance(null)).toBeNull();
    expect(resolveDiffableRemoteInstance(undefined)).toBeNull();
  });

  it("normalizes a null rootPath to undefined", () => {
    const result = resolveDiffableRemoteInstance(
      makeRuntime({
        targetKind: "remote-runtime",
        instance: { status: "running", rootPath: null },
      }),
    );
    expect(result).not.toBeNull();
    expect(result?.rootPath).toBeUndefined();
  });
});
