import { DEFAULT_BOT_SETTINGS, type BotsSnapshot } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  bots: {
    list: vi.fn<() => Promise<BotsSnapshot>>(),
    onEvent: vi.fn(() => () => undefined),
  },
}));

vi.mock("../betaFeatures", () => ({ SYNBOT_ON: true }));
vi.mock("../nativeApi", () => ({ readNativeApi: () => api }));

import { restartSynbotLiveSync, startSynbotLiveSync, useSynbotStore } from "./synbotStore";

const SNAPSHOT: BotsSnapshot = {
  bots: [],
  settings: DEFAULT_BOT_SETTINGS,
  delegations: [],
  tasks: [],
};

let stop: (() => void) | null = null;

beforeEach(() => {
  useSynbotStore.setState(useSynbotStore.getInitialState(), true);
  api.bots.list.mockReset();
  api.bots.onEvent.mockReset();
  api.bots.onEvent.mockImplementation(() => () => undefined);
});

afterEach(() => {
  stop?.();
  stop = null;
  useSynbotStore.setState(useSynbotStore.getInitialState(), true);
});

describe("SynBot live sync", () => {
  it("loads the first snapshot", async () => {
    api.bots.list.mockResolvedValue(SNAPSHOT);
    stop = startSynbotLiveSync();
    expect(useSynbotStore.getState().status).toBe("loading");
    await vi.waitFor(() => expect(useSynbotStore.getState().status).toBe("ready"));
  });

  it("leaves a failed load for Retry, which loads again", async () => {
    api.bots.list.mockRejectedValueOnce(new Error("socket closed"));
    stop = startSynbotLiveSync();
    await vi.waitFor(() => expect(useSynbotStore.getState().status).toBe("error"));
    expect(useSynbotStore.getState().error).toBe("socket closed");

    api.bots.list.mockResolvedValue(SNAPSHOT);
    stop = restartSynbotLiveSync();
    expect(useSynbotStore.getState().status).toBe("loading");
    await vi.waitFor(() => expect(useSynbotStore.getState().status).toBe("ready"));
    expect(useSynbotStore.getState().error).toBeNull();
    expect(api.bots.list).toHaveBeenCalledTimes(2);
  });

  it("says SynBot needs Alto when the server asks for a subscription", async () => {
    api.bots.list.mockRejectedValue(
      Object.assign(new Error("SynBot requires Synara Alto"), { code: "SUBSCRIPTION_REQUIRED" }),
    );
    stop = startSynbotLiveSync();
    await vi.waitFor(() => expect(useSynbotStore.getState().status).toBe("subscription_required"));
  });
});
