import { ThreadId, type DesktopAppSnapState } from "@synara/contracts";
import { COMPUTER_PERMISSION_KINDS } from "@synara/shared/computerGrants";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useComputerControlModeChange } from "./useComputerControlModeChange";

const api = vi.hoisted(() => ({ computer: { setControlEnabled: vi.fn(), getStatus: vi.fn() } }));
const toast = vi.hoisted(() => vi.fn());
vi.mock("~/nativeApi", () => ({ readNativeApi: () => api }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: toast } }));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

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

function fixture() {
  const permissions = {
    getState: vi.fn(async () => grantState({ accessibilityPermission: "denied" })),
    startPermissionSetup: vi.fn(async () => {}),
  };
  vi.stubGlobal("window", {
    desktopBridge: { getWsUrl: () => "ws://127.0.0.1:4111", appSnap: permissions },
  });
  const setMode = vi.fn();
  const focusComposer = vi.fn();
  let change!: ReturnType<typeof useComputerControlModeChange>["change"];
  function Probe() {
    change = useComputerControlModeChange({
      threadId: ThreadId.makeUnsafe("test"),
      setMode,
      focusComposer,
    }).change;
    return null;
  }
  renderToStaticMarkup(<Probe />);
  api.computer.setControlEnabled.mockImplementation(async ({ enabled }) => ({
    enabled,
    generation: 4,
  }));
  api.computer.getStatus.mockResolvedValue({
    availability: { kind: "permission-required", missing: ["accessibility"] },
  });
  return { change, permissions, setMode, focusComposer };
}

describe("Computer activation permission guide", () => {
  it.each(["request"] as const)(
    "opens AppSnap's shared guide when %s access needs permissions",
    async (mode) => {
      const f = fixture();
      f.change(mode);
      await vi.waitFor(() =>
        expect(f.permissions.startPermissionSetup).toHaveBeenCalledExactlyOnceWith(
          COMPUTER_PERMISSION_KINDS,
        ),
      );
      expect(f.setMode).toHaveBeenCalledWith("test", mode, { revokeQueued: false, generation: 4 });
      expect(f.focusComposer).not.toHaveBeenCalled();
      expect(api.computer.getStatus).not.toHaveBeenCalled();
    },
  );

  it("skips the guide and prompts when grants already exist", async () => {
    const f = fixture();
    f.permissions.getState.mockResolvedValue(grantState());
    f.change("request");
    await vi.waitFor(() => expect(f.focusComposer).toHaveBeenCalledOnce());
    expect(f.permissions.startPermissionSetup).not.toHaveBeenCalled();
  });

  it("does not reopen setup after Off overtakes a permission check", async () => {
    const f = fixture();
    let resolve!: (state: DesktopAppSnapState) => void;
    f.permissions.getState.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    f.change("request");
    await vi.waitFor(() => expect(f.permissions.getState).toHaveBeenCalledOnce());
    f.change("off");
    await vi.waitFor(() =>
      expect(f.setMode).toHaveBeenLastCalledWith("test", "off", {
        revokeQueued: true,
        generation: 4,
      }),
    );
    resolve(grantState({ accessibilityPermission: "denied" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(f.permissions.startPermissionSetup).not.toHaveBeenCalled();
  });

  it("leaves non-macOS activation alone without adding a status probe", async () => {
    const f = fixture();
    vi.stubGlobal("window", {});
    f.change("chat");
    await vi.waitFor(() => expect(f.focusComposer).toHaveBeenCalledOnce());
    expect(api.computer.getStatus).not.toHaveBeenCalled();
  });
});
