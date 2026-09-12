import { ThreadId, type ComputerStatusResult } from "@synara/contracts";
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

function fixture() {
  const permissions = { start: vi.fn(async () => {}) };
  vi.stubGlobal("window", { desktopBridge: { permissions } });
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
  it.each(["request", "chat"] as const)(
    "opens AppSnap's shared guide when %s access needs permissions",
    async (mode) => {
      const f = fixture();
      f.change(mode);
      await vi.waitFor(() =>
        expect(f.permissions.start).toHaveBeenCalledExactlyOnceWith("computer"),
      );
      expect(f.setMode).toHaveBeenCalledWith("test", mode, { revokeQueued: false, generation: 4 });
      expect(f.focusComposer).not.toHaveBeenCalled();
    },
  );

  it("skips the guide and prompts when grants already exist", async () => {
    const f = fixture();
    api.computer.getStatus.mockResolvedValue({ availability: { kind: "available" } });
    f.change("request");
    await vi.waitFor(() => expect(f.focusComposer).toHaveBeenCalledOnce());
    expect(f.permissions.start).not.toHaveBeenCalled();
  });

  it("does not reopen setup after Off overtakes a permission check", async () => {
    const f = fixture();
    let resolve!: (status: Partial<ComputerStatusResult>) => void;
    api.computer.getStatus.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    f.change("request");
    await vi.waitFor(() => expect(api.computer.getStatus).toHaveBeenCalledOnce());
    f.change("off");
    await vi.waitFor(() =>
      expect(f.setMode).toHaveBeenLastCalledWith("test", "off", {
        revokeQueued: true,
        generation: 4,
      }),
    );
    resolve({
      availability: {
        kind: "permission-required",
        missing: ["accessibility"],
        message: "Needs access",
        buildSignature: "adhoc",
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(f.permissions.start).not.toHaveBeenCalled();
  });

  it("leaves non-macOS activation alone without adding a status probe", async () => {
    const f = fixture();
    vi.stubGlobal("window", {});
    f.change("chat");
    await vi.waitFor(() => expect(f.focusComposer).toHaveBeenCalledOnce());
    expect(api.computer.getStatus).not.toHaveBeenCalled();
  });
});
