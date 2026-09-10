import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DesktopPermissionSetupState } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { DesktopPermissionSetup } from "./DesktopPermissionSetup";

async function fixture(feature: "computer" | "appsnap" = "computer", delayedInitial = false) {
  const initial: DesktopPermissionSetupState = {
    feature: null,
    phase: "idle",
    required: [],
    grants: {},
    current: null,
    appName: "Synara Cua",
    appPath: "/Applications/Synara Cua.app",
    message: null,
  };
  let receive!: (state: DesktopPermissionSetupState) => void;
  let resolveInitial!: (state: DesktopPermissionSetupState) => void;
  const bridge = {
    getState: vi.fn(() =>
      delayedInitial
        ? new Promise<DesktopPermissionSetupState>((resolve) => {
            resolveInitial = resolve;
          })
        : Promise.resolve(initial),
    ),
    start: vi.fn(async () => initial),
    stop: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
    revealApp: vi.fn(async () => {}),
    startDrag: vi.fn(),
    onState: vi.fn((listener) => {
      receive = listener;
      return vi.fn();
    }),
  };
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { permissions: bridge },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await render(
    <QueryClientProvider client={client}>
      <DesktopPermissionSetup feature={feature} />
    </QueryClientProvider>,
  );
  const push = (state: Partial<DesktopPermissionSetupState>) =>
    receive({
      ...initial,
      feature,
      required:
        feature === "computer"
          ? ["accessibility", "screenRecording"]
          : ["inputMonitoring", "screenRecording"],
      ...state,
    });
  return { view, bridge, push, resolveInitial: () => resolveInitial(initial) };
}
afterEach(() => {
  Object.defineProperty(window, "desktopBridge", { configurable: true, value: undefined });
});

describe("shared native permission setup UI", () => {
  it("starts explicitly and receives Accessibility then Screen Recording grants without a focus event", async () => {
    const f = await fixture();
    await expect.element(f.view.getByRole("button", { name: "Set up permissions" })).toBeVisible();
    expect(f.bridge.start).not.toHaveBeenCalled();
    await f.view.getByRole("button", { name: "Set up permissions" }).click();
    expect(f.bridge.start).toHaveBeenCalledExactlyOnceWith("computer");
    window.dispatchEvent(new Event("blur"));
    f.push({
      phase: "waiting",
      current: "accessibility",
      grants: { accessibility: "denied", screenRecording: "denied" },
    });
    await expect.element(f.view.getByText("Waiting for access…")).toBeVisible();
    f.push({
      phase: "waiting",
      current: "screenRecording",
      grants: { accessibility: "granted", screenRecording: "denied" },
    });
    await expect.element(f.view.getByText("Granted", { exact: true })).toBeVisible();
    await expect.element(f.view.getByRole("status")).toHaveTextContent("No refresh needed");
    f.push({ phase: "complete", grants: { accessibility: "granted", screenRecording: "granted" } });
    await expect.element(f.view.getByText("Permissions granted", { exact: true })).toBeVisible();
    expect(f.bridge.start).toHaveBeenCalledTimes(1);
    expect(f.bridge.retry).not.toHaveBeenCalled();
  });

  it("drags the running app through the dedicated native operation without sending a renderer path", async () => {
    const f = await fixture();
    const chip = f.view.getByRole("button", { name: "Synara Cua Drag into Settings" });
    await expect.element(chip).toBeVisible();
    chip.element().dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true }));
    expect(f.bridge.startDrag).toHaveBeenCalledExactlyOnceWith();
    await f.view.getByRole("button", { name: "Show in Finder" }).click();
    expect(f.bridge.revealApp).toHaveBeenCalledExactlyOnceWith();
    await expect
      .element(f.view.getByText("Permissions granted", { exact: true }))
      .not.toBeInTheDocument();
  });

  it("shows AppSnap's own scopes and dismisses without enabling Computer", async () => {
    const f = await fixture("appsnap");
    await expect.element(f.view.getByText("1. Input Monitoring")).toBeVisible();
    f.push({
      phase: "waiting",
      current: "inputMonitoring",
      grants: { inputMonitoring: "denied", screenRecording: "denied" },
    });
    await f.view.getByRole("button", { name: "Dismiss" }).click();
    expect(f.bridge.stop).toHaveBeenCalledExactlyOnceWith();
    expect(f.bridge.start).not.toHaveBeenCalled();
    await expect.element(f.view.getByText("1. Accessibility")).not.toBeInTheDocument();
  });

  it("does not let a delayed initial response overwrite a newer grant event", async () => {
    const f = await fixture("computer", true);
    await vi.waitFor(() => expect(f.bridge.onState).toHaveBeenCalled());
    f.push({ phase: "complete", grants: { accessibility: "granted", screenRecording: "granted" } });
    f.resolveInitial();
    await expect.element(f.view.getByText("Permissions granted", { exact: true })).toBeVisible();
  });
});
