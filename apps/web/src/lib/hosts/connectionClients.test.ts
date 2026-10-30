// FILE: connectionClients.test.ts
// Purpose: Keeps a remote frame recoverable before its execution transport exists.
// Layer: Controller/execution bootstrap tests

import { WS_METHODS } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceConnectionRecovery } from "./workspaceFrame";

const mocks = vi.hoisted(() => ({
  request: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  dispose: vi.fn(),
  resume: vi.fn(),
  instances: [] as Array<{ url: string | undefined }>,
}));
vi.mock("../../wsTransport", () => ({
  rawSocketUrl: () => "ws://127.0.0.1:58001/ws",
  WsTransport: class {
    constructor(readonly url?: string) {
      mocks.instances.push({ url: this.url });
    }
    request(...args: unknown[]) {
      return mocks.request(this.url, ...args);
    }
    async dispose() {
      mocks.dispose(this.url);
    }
    resumeRemoteConnection() {
      mocks.resume(this.url);
    }
    async waitForRemoteConnectionRecovery() {
      return false;
    }
  },
}));
vi.mock("./controllerRecovery", () => ({ rememberVerifiedController: vi.fn() }));

const scope = {
  environmentId: "mini",
  accountAuthority: "https://accounts.test",
  userId: "owner",
  organizationId: "personal",
  channel: "beta",
};
const selected = {
  hostId: "mini-host",
  hostName: "Mini",
  wsPath: "/ws/remote/mini-host",
  executionScope: scope,
};
const descriptor = (environmentId: string) => ({
  environmentId,
  label: "Computer",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "fixture",
  capabilities: { repositoryIdentity: true },
});
let recovery: WorkspaceConnectionRecovery | undefined;
let cleanup: (() => Promise<void>) | undefined;
const unregister = vi.fn();

beforeEach(() => {
  vi.resetModules();
  mocks.request.mockReset();
  mocks.dispose.mockReset();
  mocks.resume.mockReset();
  mocks.instances.length = 0;
  unregister.mockReset();
  recovery = undefined;
  cleanup = undefined;
  vi.stubGlobal("window", {
    frameElement: {
      synaraWorkspace: {
        host: selected,
        registerConnectionRecovery: (value: WorkspaceConnectionRecovery) => {
          recovery = value;
          return unregister;
        },
      },
    },
  });
});
afterEach(async () => {
  await cleanup?.();
  vi.unstubAllGlobals();
});

async function bootstrap() {
  const api = await import("./connectionClients");
  cleanup = api.disposeConnectionClients;
  return api;
}

function terminalResponse(state = "revoked") {
  return {
    connections: [],
    desiredHosts: [{ hostId: selected.hostId, environmentId: scope.environmentId, state }],
  };
}

function signedIn() {
  return {
    state: "signed-in",
    accountAuthority: scope.accountAuthority,
    me: { id: scope.userId, organization: { id: scope.organizationId } },
  };
}

function respondToBootstrapRead(url: unknown, method: unknown) {
  if (method === WS_METHODS.accountStatus) return signedIn();
  if (method === WS_METHODS.serverGetEnvironment) {
    return descriptor(url ? "mini" : "controller");
  }
  throw new Error(`Unexpected fixture request: ${String(method)}`);
}

describe("initial remote relationship recovery", () => {
  it.each(["revoked", "needs-sign-in", "incompatible"])(
    "waits for verified retry after an initial %s refusal and retains the same frame",
    async (state) => {
      let attempts = 0;
      mocks.request.mockImplementation(async (url, method) => {
        if (method === WS_METHODS.hostsConnect) {
          expect(recovery).toBeDefined();
          if (++attempts === 1) throw new Error("private controller failure");
          return selected;
        }
        if (method === WS_METHODS.hostsListConnections) return terminalResponse(state);
        return respondToBootstrapRead(url, method);
      });
      const api = await bootstrap();
      let settled = false;
      const started = api.bootstrapExecutionContext().then(() => {
        settled = true;
      });
      await vi.waitFor(() =>
        expect(mocks.request).toHaveBeenCalledWith(
          undefined,
          WS_METHODS.hostsListConnections,
          undefined,
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        ),
      );
      expect(settled).toBe(false);
      expect(attempts).toBe(1);
      expect(mocks.instances).toHaveLength(1);
      recovery!.resume();
      await started;
      expect(attempts).toBe(2);
      expect(mocks.instances).toHaveLength(2);
      expect(
        (await import("./executionContext")).readExecutionContext()?.execution.environmentId,
      ).toBe("mini");
      recovery!.resume();
      expect(mocks.resume).toHaveBeenCalledWith("ws://127.0.0.1:58001/ws/remote/mini-host/ws");
    },
  );

  it.each(["different host", "different environment", "transient", "query failure"])(
    "keeps the original connection failure when controller state is %s",
    async (kind) => {
      const original = new Error("original connection failure");
      const response = terminalResponse();
      if (kind === "different host") response.desiredHosts[0]!.hostId = "another-host";
      if (kind === "different environment")
        response.desiredHosts[0]!.environmentId = "another-mini";
      if (kind === "transient") response.desiredHosts[0]!.state = "reconnecting";
      mocks.request.mockImplementation(async (url, method) => {
        if (method === WS_METHODS.hostsConnect) throw original;
        if (method === WS_METHODS.hostsListConnections) {
          if (kind === "query failure") throw new Error("state query failed");
          return response;
        }
        return respondToBootstrapRead(url, method);
      });
      const api = await bootstrap();
      await expect(api.bootstrapExecutionContext()).rejects.toBe(original);
      expect(mocks.instances).toHaveLength(1);
      expect((await import("./executionContext")).readExecutionContext()).toBeUndefined();
    },
  );

  it.each(["signed out", "different user", "different organization", "different authority"])(
    "does not park or revive the old account when the controller is %s",
    async (kind) => {
      const original = new Error("initial connection failure");
      const account = signedIn();
      if (kind === "different user") account.me.id = "another-user";
      if (kind === "different organization") account.me.organization.id = "another-org";
      if (kind === "different authority") account.accountAuthority = "https://another-account.test";
      mocks.request.mockImplementation(async (url, method) => {
        if (method === WS_METHODS.hostsConnect) throw original;
        if (method === WS_METHODS.hostsListConnections) return terminalResponse();
        if (method === WS_METHODS.accountStatus)
          return kind === "signed out" ? { state: "signed-out" } : account;
        return respondToBootstrapRead(url, method);
      });
      const api = await bootstrap();
      await expect(api.bootstrapExecutionContext()).rejects.toBe(original);
      recovery!.resume();
      expect(mocks.instances).toHaveLength(1);
      expect((await import("./executionContext")).readExecutionContext()).toBeUndefined();
    },
  );

  it("aborts a waiting bootstrap when its frame is removed and ignores stale resume callbacks", async () => {
    mocks.request.mockImplementation(async (url, method) => {
      if (method === WS_METHODS.hostsConnect) throw new Error("connection refused");
      if (method === WS_METHODS.hostsListConnections) return terminalResponse();
      return respondToBootstrapRead(url, method);
    });
    const api = await bootstrap();
    const started = api.bootstrapExecutionContext();
    const rejected = expect(started).rejects.toThrow("Transport disposed");
    await vi.waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith(
        undefined,
        WS_METHODS.hostsListConnections,
        undefined,
        expect.any(Object),
      ),
    );
    const captured = recovery!;
    await api.disposeConnectionClients();
    await rejected;
    captured.resume();
    expect(mocks.instances).toHaveLength(1);
    expect(unregister).toHaveBeenCalledOnce();
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect((await import("./executionContext")).readExecutionContext()).toBeUndefined();
  });

  it("honors a verified retry that finishes before an older connect refusal settles", async () => {
    let rejectFirst!: (error: Error) => void;
    let attempts = 0;
    mocks.request.mockImplementation(async (url, method) => {
      if (method === WS_METHODS.hostsConnect) {
        if (++attempts === 1) {
          return new Promise((_, reject) => {
            rejectFirst = reject;
          });
        }
        return selected;
      }
      return respondToBootstrapRead(url, method);
    });
    const api = await bootstrap();
    const started = api.bootstrapExecutionContext();
    await vi.waitFor(() => expect(attempts).toBe(1));
    recovery!.resume();
    rejectFirst(new Error("stale refusal"));
    await started;
    expect(attempts).toBe(2);
    expect(mocks.instances).toHaveLength(2);
  });

  it("rejects a recovered connection with a different account before creating an execution transport", async () => {
    let attempts = 0;
    mocks.request.mockImplementation(async (url, method) => {
      if (method === WS_METHODS.hostsConnect) {
        if (++attempts === 1) throw new Error("initial refusal");
        return { ...selected, executionScope: { ...scope, userId: "another-owner" } };
      }
      if (method === WS_METHODS.hostsListConnections) return terminalResponse();
      return respondToBootstrapRead(url, method);
    });
    const api = await bootstrap();
    const started = api.bootstrapExecutionContext();
    const rejected = expect(started).rejects.toThrow("The selected host or account changed");
    await vi.waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith(
        undefined,
        WS_METHODS.hostsListConnections,
        undefined,
        expect.any(Object),
      ),
    );
    recovery!.resume();
    await rejected;
    expect(mocks.instances).toHaveLength(1);
    expect((await import("./executionContext")).readExecutionContext()).toBeUndefined();
  });
});
