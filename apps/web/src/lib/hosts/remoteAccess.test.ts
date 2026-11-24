import { describe, expect, it, vi } from "vitest";
import { readHostsApi } from "./api";
import { trackProductAnalytics } from "~/lib/productAnalytics";

vi.mock("./api", () => ({ readHostsApi: vi.fn() }));
vi.mock("~/lib/productAnalytics", () => ({ trackProductAnalytics: vi.fn() }));

import {
  countdownLabel,
  callRemoteAccess,
  fingerprintGroups,
  pendingApprovals,
  remoteDeviceKind,
  type RemoteHostState,
} from "./remoteAccess";

it("counts an approval only after the owner RPC succeeds and emits no request fields", async () => {
  const access = vi
    .fn()
    .mockRejectedValueOnce(new Error("rejected"))
    .mockResolvedValue({ kind: "done" });
  vi.mocked(readHostsApi).mockReturnValue({ remoteAccess: access } as unknown as ReturnType<
    typeof readHostsApi
  >);
  vi.mocked(trackProductAnalytics).mockClear();
  const request = {
    operation: "approve",
    inviteId: "private-invite",
    deviceJkt: "private-key",
  } as const;
  await expect(callRemoteAccess(request)).rejects.toThrow("rejected");
  expect(trackProductAnalytics).not.toHaveBeenCalled();
  await callRemoteAccess(request);
  expect(trackProductAnalytics).toHaveBeenCalledExactlyOnceWith({
    event: "remote.pairing-approved",
    outcome: "succeeded",
  });
});

describe("remoteDeviceKind", () => {
  it("picks a glyph from the label the device reported", () => {
    expect(remoteDeviceKind("iOS 27.0.1 iPhone")).toBe("phone");
    expect(remoteDeviceKind("Ada's iPad")).toBe("tablet");
    expect(remoteDeviceKind("ios Ada's iPad")).toBe("tablet");
    expect(remoteDeviceKind("Emanuele's MacBook")).toBe("computer");
  });
});

describe("pendingApprovals", () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  const pendingDevice = { deviceJkt: "jkt", label: "MacBook", publicKey: {} };
  const state = {
    kind: "host-state",
    devices: [],
    rootExpiresAt: null,
    rootNeedsRepair: false,
    invitations: [
      {
        inviteId: "a",
        expiresAt: "2026-10-06T12:05:00Z",
        approved: false,
        revoked: false,
        pendingDevice,
      },
      {
        inviteId: "b",
        expiresAt: "2026-10-06T11:59:00Z",
        approved: false,
        revoked: false,
        pendingDevice,
      },
      {
        inviteId: "c",
        expiresAt: "2026-10-06T12:05:00Z",
        approved: true,
        revoked: false,
        pendingDevice,
      },
      {
        inviteId: "d",
        expiresAt: "2026-10-06T12:05:00Z",
        approved: false,
        revoked: false,
        pendingDevice: null,
      },
    ],
  } as unknown as RemoteHostState;

  it("keeps only live requests that still need the owner", () => {
    expect(pendingApprovals(state, now).map((entry) => entry.inviteId)).toEqual(["a"]);
    expect(pendingApprovals(null, now)).toEqual([]);
  });
});

describe("pairing code helpers", () => {
  it("formats the countdown and expires to null", () => {
    const now = Date.parse("2026-10-06T12:00:00Z");
    expect(countdownLabel("2026-10-06T12:09:05Z", now)).toBe("9:05");
    expect(countdownLabel("2026-10-06T11:00:00Z", now)).toBeNull();
  });

  it("splits a root fingerprint into comparable groups", () => {
    const groups = fingerprintGroups(`${"a".repeat(60)}bcde`);
    expect(groups).toHaveLength(8);
    expect(groups.at(-1)).toEqual({ offset: 56, text: "aaaabcde" });
  });
});
