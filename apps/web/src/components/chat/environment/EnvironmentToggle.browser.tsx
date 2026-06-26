import "../../../index.css";

import { ExecutionInstanceId, ThreadId, type OrchestrationThreadRuntime } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { EnvironmentToggle } from "./EnvironmentToggle";

function makeRemoteRuntime(
  overrides: Partial<OrchestrationThreadRuntime> = {},
): OrchestrationThreadRuntime {
  const provider = overrides.provider ?? "daytona";
  const status = overrides.status ?? "running";
  return {
    threadId: ThreadId.makeUnsafe("thread-environment-toggle-runtime"),
    targetKind: "remote-runtime",
    provider,
    role: "agent",
    status,
    instance: {
      id: ExecutionInstanceId.makeUnsafe("runtime-instance-environment-toggle"),
      provider,
      status,
      rootPath: "/workspace/project",
      failureReason: null,
      createdAt: "2026-03-04T12:00:00.000Z" as never,
      updatedAt: "2026-03-04T12:00:01.000Z" as never,
    },
    processes: [],
    routes: [],
    snapshots: [],
    leases: [],
    lastActivityAt: null,
    updatedAt: "2026-03-04T12:00:01.000Z" as never,
    ...overrides,
  };
}

describe("EnvironmentToggle", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("surfaces remote sandbox state in the environment control", async () => {
    await render(
      <EnvironmentToggle
        environment={{ open: false, onOpenChange: vi.fn() }}
        runtime={makeRemoteRuntime({ provider: "daytona", status: "running" })}
      />,
    );

    const toggle = page.getByRole("button", {
      name: "Toggle environment panel, Remote sandbox: Running on Daytona",
    });
    await expect.element(toggle).toBeVisible();
    expect(toggle.element()).toHaveAttribute("title", "Remote sandbox: Running on Daytona");
  });

  it("keeps the generic environment label for local threads", async () => {
    await render(<EnvironmentToggle environment={{ open: false, onOpenChange: vi.fn() }} />);

    const toggle = page.getByRole("button", { name: "Toggle environment panel" });
    await expect.element(toggle).toBeVisible();
    expect(toggle.element()).toHaveAttribute("title", "Environment");
  });
});
