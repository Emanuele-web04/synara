import { beforeEach, expect, it, vi } from "vitest";
import type { ExecutionEnvironmentDescriptor } from "@synara/contracts";

const descriptor = { environmentId: "local" } as ExecutionEnvironmentDescriptor;

beforeEach(() => vi.resetModules());

it("applies the machine-wide computer control default only on this computer", async () => {
  const { initializeExecutionContext } = await import("./lib/hosts/executionContext");
  const { resolveComputerControlDefault } = await import("./computerControlMode");
  initializeExecutionContext({ controller: descriptor, execution: descriptor, remote: null });
  expect(resolveComputerControlDefault(true)).toBe(true);
  expect(resolveComputerControlDefault(false)).toBe(false);
});

it("never sends the default to a remote computer, which refuses computer control", async () => {
  const { initializeExecutionContext } = await import("./lib/hosts/executionContext");
  const { resolveComputerControlDefault } = await import("./computerControlMode");
  initializeExecutionContext({
    controller: descriptor,
    execution: { environmentId: "mini" } as ExecutionEnvironmentDescriptor,
    remote: {
      environmentId: "mini",
      accountAuthority: "https://account.example",
      userId: "alice",
      organizationId: "org",
      channel: "dev",
    },
  });
  expect(resolveComputerControlDefault(true)).toBe(false);
});
