// FILE: computerProvisioning.test.ts
// Purpose: Pin the one "set up computer control" vocabulary the chat card and the
//          settings panel now share.
// Layer: Web UI logic tests

import type {
  ComputerProvisionResult,
  ComputerStatusResult,
  DesktopAppSnapState,
} from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPUTER_PERMISSION_KINDS } from "@synara/shared/computerGrants";

import {
  computerProvisionErrorToast,
  computerProvisionNote,
  computerProvisionOutcome,
  computerProvisionResultToast,
  computerProvisionStartToast,
  prepareComputerPermissionGuide,
  readLocalComputerPermissionBridge,
  computerPermissionSetupSupported,
} from "./computerProvisioning";

function grantState(overrides: Partial<DesktopAppSnapState> = {}): DesktopAppSnapState {
  return {
    platform: "macos",
    supported: true,
    enabled: false,
    status: "disabled",
    shortcut: null,
    accessibilityPermission: "granted",
    inputMonitoringPermission: "granted",
    screenRecordingPermission: "granted",
    message: null,
    appDisplayName: "Synara",
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("prepareComputerPermissionGuide", () => {
  it("does not probe without a native setup bridge", async () => {
    const getPermissionState = vi.fn();
    await expect(
      prepareComputerPermissionGuide({ getPermissionState, isCurrent: () => true }),
    ).resolves.toBe(true);
    expect(getPermissionState).not.toHaveBeenCalled();
  });
  it("checks real grants before the first task instead of trusting idle server availability", async () => {
    const getStatus = vi.fn(async () => ({ availability: { kind: "available", backend: "cua" } }));
    const getPermissionState = vi.fn(async () =>
      grantState({ inputMonitoringPermission: "denied" }),
    );
    const startPermissionSetup = vi.fn().mockResolvedValue(undefined);
    await expect(
      prepareComputerPermissionGuide({
        getPermissionState,
        startPermissionSetup,
        isCurrent: () => true,
      }),
    ).resolves.toBe(false);
    expect(getPermissionState).toHaveBeenCalledExactlyOnceWith(COMPUTER_PERMISSION_KINDS);
    expect(startPermissionSetup).toHaveBeenCalledExactlyOnceWith(COMPUTER_PERMISSION_KINDS);
    expect(getStatus).not.toHaveBeenCalled();
  });
  it("does not open setup after cancellation overtakes the grant check", async () => {
    let current = true;
    const startPermissionSetup = vi.fn();
    const getPermissionState = vi.fn(async () => {
      current = false;
      return grantState({ screenRecordingPermission: "denied" });
    });
    await expect(
      prepareComputerPermissionGuide({
        getPermissionState,
        startPermissionSetup,
        isCurrent: () => current,
      }),
    ).resolves.toBe(false);
    expect(getPermissionState).toHaveBeenCalledOnce();
    expect(startPermissionSetup).not.toHaveBeenCalled();
  });
  it("continues without setup when all requested grants exist", async () => {
    const startPermissionSetup = vi.fn();
    await expect(
      prepareComputerPermissionGuide({
        getPermissionState: async () => grantState(),
        startPermissionSetup,
        isCurrent: () => true,
      }),
    ).resolves.toBe(true);
    expect(startPermissionSetup).not.toHaveBeenCalled();
  });
  it.each([
    { platform: "linux" as const, supported: false },
    { platform: "linux" as const, supported: true },
    { platform: "macos" as const, supported: false },
  ])("never offers Mac grants for unsupported state %j", async (overrides) => {
    const state = grantState({
      ...overrides,
      accessibilityPermission: "unknown",
      inputMonitoringPermission: "unknown",
      screenRecordingPermission: "unknown",
    });
    const startPermissionSetup = vi.fn();
    expect(computerPermissionSetupSupported(state)).toBe(false);
    await expect(
      prepareComputerPermissionGuide({
        getPermissionState: async () => state,
        startPermissionSetup,
        isCurrent: () => true,
      }),
    ).resolves.toBe(true);
    expect(startPermissionSetup).not.toHaveBeenCalled();
  });
  it("keeps the draft unsent when the native check fails", async () => {
    const startPermissionSetup = vi.fn();
    await expect(
      prepareComputerPermissionGuide({
        getPermissionState: async () => {
          throw new Error("helper unavailable");
        },
        startPermissionSetup,
        isCurrent: () => true,
      }),
    ).rejects.toThrow("helper unavailable");
    expect(startPermissionSetup).not.toHaveBeenCalled();
  });
});

describe("local Computer permission ownership", () => {
  it("does not infer locality for an injected API from an unrelated desktop endpoint", () => {
    vi.stubGlobal("window", {
      nativeApi: {},
      desktopBridge: { getWsUrl: () => "ws://127.0.0.1:4111", appSnap: {} },
    });
    expect(readLocalComputerPermissionBridge()).toBeNull();
  });
  it.each(["ws://127.0.0.1:4312", "ws://[::1]:4312", "wss://localhost:4312"])(
    "uses the desktop-owned loopback endpoint %s",
    (endpoint) => {
      const appSnap = {};
      vi.stubGlobal("window", { desktopBridge: { getWsUrl: () => endpoint, appSnap } });
      expect(readLocalComputerPermissionBridge()).toBe(appSnap);
    },
  );
  it.each([
    "wss://remote.synara.test",
    "ws://192.168.1.42:4312",
    "http://localhost:4312",
    "invalid",
    null,
  ])("does not require local client grants for remote or unknown endpoint %s", (endpoint) => {
    vi.stubGlobal("window", { desktopBridge: { getWsUrl: () => endpoint, appSnap: {} } });
    expect(readLocalComputerPermissionBridge()).toBeNull();
  });
});

const READY_STATUS: ComputerStatusResult = {
  computerId: "computer-1",
  availability: { kind: "available", backend: "mac" },
  health: {
    status: "connected",
    captureAvailable: true,
    consecutiveFailures: 0,
    reconnects: 0,
  },
  capabilities: {
    windows: true,
    windowBounds: true,
    stacking: true,
    capture: true,
    input: true,
    clipboard: true,
    focus: true,
    raise: true,
    ghostCursor: true,
    visibleDesktop: true,
  },
} as unknown as ComputerStatusResult;

function result(
  overrides: Partial<ComputerStatusResult>,
  summary: string,
): ComputerProvisionResult {
  return { summary, status: { ...READY_STATUS, ...overrides } };
}

describe("computerProvisionOutcome", () => {
  it("never reports unsupported or disconnected desktops as ready", () => {
    expect(
      computerProvisionOutcome(
        result(
          { availability: { kind: "unsupported-platform", platform: "win32" } },
          "Unavailable.",
        ),
      ),
    ).toBe("incomplete");
    expect(
      computerProvisionOutcome(
        result(
          { provisionable: false, health: { ...READY_STATUS.health, status: "unavailable" } },
          "Unavailable.",
        ),
      ),
    ).toBe("incomplete");
  });
  it("keeps setup incomplete while a provisionable desktop is disconnected", () => {
    expect(
      computerProvisionOutcome(
        result(
          {
            availability: { kind: "available", backend: "kwin" },
            provisionable: true,
            health: { ...READY_STATUS.health, status: "unavailable" },
          },
          "Still starting.",
        ),
      ),
    ).toBe("incomplete");
  });
  it("is ready only when the refreshed status leaves nothing to set up", () => {
    expect(computerProvisionOutcome(result({}, "Started the helper."))).toBe("ready");
    expect(
      computerProvisionOutcome(
        result(
          {
            availability: {
              kind: "permission-required",
              missing: ["accessibility"],
              message: "needs Accessibility",
              buildSignature: "adhoc",
            },
          },
          "Asked macOS.",
        ),
      ),
    ).toBe("incomplete");
  });
});

describe("computer provision toasts", () => {
  it("names the outstanding grants through the shared ordering", () => {
    // Not hand-written: a second spelling of "Screen Recording and
    // Accessibility" here against the card's ordering is exactly the drift
    // `listComputerPermissions` exists to prevent.
    const toast = computerProvisionStartToast(["screenRecording", "accessibility"]);
    expect(toast.description).toContain("Accessibility and Screen Recording");
    expect(toast.type).toBe("info");
  });

  it("falls back to general wording when no grant has been named", () => {
    expect(computerProvisionStartToast().description).not.toContain("macOS");
    expect(computerProvisionStartToast().description).not.toContain("Accessibility");
    expect(computerProvisionStartToast([]).description).toContain("permissions Synara needs");
  });

  it("distinguishes a finished setup from one still missing a grant", () => {
    expect(computerProvisionResultToast(result({}, "All set.")).type).toBe("success");
    const incomplete = computerProvisionResultToast(
      result(
        {
          availability: {
            kind: "permission-required",
            missing: ["accessibility"],
            message: "needs Accessibility",
            buildSignature: "adhoc",
          },
        },
        "Asked macOS.",
      ),
    );
    expect(incomplete.type).toBe("warning");
    // The server's own sentence, not a second account of it.
    expect(incomplete.description).toBe("Asked macOS.");
  });

  it("reports a failure without inventing a reason", () => {
    expect(computerProvisionErrorToast(new Error("build failed")).description).toBe("build failed");
    expect(computerProvisionErrorToast(undefined).description).toBe("The server gave no reason.");
  });
});

describe("computerProvisionNote", () => {
  it("uses brief macOS permission guidance when a grant is missing", () => {
    const note = computerProvisionNote({ isPending: true, missing: ["screenRecording"] });
    expect(note).toContain("Checking Screen Recording");
    expect(note).not.toContain("installs or builds");
    expect(note).not.toContain("password");
  });
  it("says the same three things the toasts do, for a surface with room", () => {
    expect(computerProvisionNote({ isPending: true })).toContain("Setting up");
    expect(computerProvisionNote({ isPending: false, error: new Error("nope") })).toBe(
      "Setting up failed. nope",
    );
    expect(
      computerProvisionNote({ isPending: false, result: result({}, "Started the helper.") }),
    ).toBe("Started the helper.");
    expect(computerProvisionNote({ isPending: false })).toBeUndefined();
  });

  it("lets the in-flight message outrank a previous attempt's outcome", () => {
    expect(computerProvisionNote({ isPending: true, error: new Error("nope") })).toContain(
      "Setting up the agent's desktop",
    );
  });
});
