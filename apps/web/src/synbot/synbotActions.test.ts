import { ProjectId, type Bot } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface StopResult {
  readonly interruptedThreadIds: string[];
  readonly cancelledTaskIds: string[];
  readonly cancelledDelegationIds: string[];
}

const api = vi.hoisted(() => ({
  bots: {
    remove: vi.fn<(input: { id: string }) => Promise<void>>(),
    stopAll: vi.fn<(input: { botId?: string }) => Promise<StopResult>>(),
  },
}));
const toast = vi.hoisted(() => ({ add: vi.fn() }));

vi.mock("~/nativeApi", () => ({ readNativeApi: () => api }));
vi.mock("~/components/ui/toast", () => ({ toastManager: toast }));

import {
  askToRemoveBot,
  askToStopAllBots,
  cancelSynbotConfirm,
  confirmSynbotAction,
  useSynbotConfirm,
} from "./synbotActions";
import { useSynbotStore } from "./synbotStore";

const doomed = { id: ProjectId.makeUnsafe("bot-doomed"), name: "Doomed" };

beforeEach(() => {
  useSynbotConfirm.setState(useSynbotConfirm.getInitialState(), true);
  useSynbotStore.setState(useSynbotStore.getInitialState(), true);
  api.bots.remove.mockReset();
  api.bots.stopAll.mockReset();
  toast.add.mockReset();
});

afterEach(() => {
  useSynbotConfirm.setState(useSynbotConfirm.getInitialState(), true);
  useSynbotStore.setState(useSynbotStore.getInitialState(), true);
});

describe("SynBot confirmation", () => {
  it("asks, and Cancel closes the question without acting", () => {
    askToStopAllBots();
    expect(useSynbotConfirm.getState().request).toEqual({ kind: "stop-all" });
    cancelSynbotConfirm();
    expect(useSynbotConfirm.getState().request).toBeNull();
    expect(api.bots.stopAll).not.toHaveBeenCalled();
  });

  it("removes the bot it asked about and reports its id", async () => {
    useSynbotStore.setState({
      data: { ...useSynbotStore.getState().data, bots: [{ ...doomed } as unknown as Bot] },
    });
    api.bots.remove.mockResolvedValue(undefined);
    askToRemoveBot(doomed);
    await expect(confirmSynbotAction()).resolves.toBe("bot-doomed");
    expect(api.bots.remove).toHaveBeenCalledWith({ id: "bot-doomed" });
    expect(useSynbotStore.getState().data.bots).toEqual([]);
    expect(useSynbotConfirm.getState()).toMatchObject({ request: null, busy: false });
  });

  it("closes after a failed removal and says so in a toast", async () => {
    api.bots.remove.mockRejectedValue(new Error("busy"));
    askToRemoveBot(doomed);
    await expect(confirmSynbotAction()).resolves.toBeNull();
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", description: "busy" }),
    );
    expect(useSynbotConfirm.getState().request).toBeNull();
  });

  it("keeps the question open and unchanged while its answer runs", async () => {
    const stopped: { resolve?: (result: StopResult) => void } = {};
    api.bots.stopAll.mockReturnValue(
      new Promise<StopResult>((resolve) => {
        stopped.resolve = resolve;
      }),
    );
    askToStopAllBots();
    const running = confirmSynbotAction();
    expect(useSynbotConfirm.getState().busy).toBe(true);
    cancelSynbotConfirm();
    askToRemoveBot(doomed);
    expect(useSynbotConfirm.getState().request).toEqual({ kind: "stop-all" });
    stopped.resolve?.({
      interruptedThreadIds: [],
      cancelledTaskIds: [],
      cancelledDelegationIds: [],
    });
    await running;
    expect(api.bots.stopAll).toHaveBeenCalledWith({});
    expect(useSynbotConfirm.getState()).toMatchObject({ request: null, busy: false });
    expect(toast.add).toHaveBeenCalledWith(expect.objectContaining({ type: "success" }));
  });
});
