import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EnvironmentId, type RemoteResource } from "@synara/contracts";

import { readExecutionContext, type WindowExecutionContext } from "./hosts/executionContext";
import { resolveExecutionResource, resolveWsHttpUrl, toAttachmentPreviewUrl } from "./wsHttpUrl";

vi.mock("./hosts/executionContext", () => ({ readExecutionContext: vi.fn() }));

beforeEach(() => vi.mocked(readExecutionContext).mockReset());

describe("resolveWsHttpUrl", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_WS_URL", "");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("forwards the websocket token to relative server routes", () => {
    vi.stubGlobal("window", {
      desktopBridge: {
        getWsUrl: () => "ws://127.0.0.1:4111/ws?token=legacy-secret",
      },
      location: { origin: "http://fallback.test" },
    });

    expect(resolveWsHttpUrl("/api/attachment", { requireBackend: true })).toBe(
      "http://127.0.0.1:4111/api/attachment?token=legacy-secret",
    );
  });

  it("does not forward the websocket token to an absolute external URL", () => {
    vi.stubGlobal("window", {
      desktopBridge: {
        getWsUrl: () => "wss://synara.test/ws?token=legacy-secret",
      },
      location: { origin: "https://fallback.test" },
    });

    expect(resolveWsHttpUrl("https://example.test/image.png")).toBe(
      "https://example.test/image.png",
    );
  });

  it.each([null, "not-a-url", "file:///tmp/backend", "synara-remote://app"])(
    "refuses mutations without a network desktop backend (%s), without breaking GET rendering",
    (backend) => {
      vi.stubGlobal("window", {
        desktopBridge: { getWsUrl: () => backend },
        location: { origin: "synara-remote://app" },
      });

      expect(() => resolveWsHttpUrl("/api/attachments/upload", { requireBackend: true })).toThrow(
        "The desktop connection is unavailable. Reconnect and try again.",
      );
      expect(resolveWsHttpUrl("/api/project-favicon")).toBe(
        "synara-remote://app/api/project-favicon",
      );
    },
  );

  it("keeps same-origin browser mutations working without a WebSocket override", () => {
    vi.stubGlobal("window", { location: { origin: "https://synara.test" } });

    expect(resolveWsHttpUrl("/api/attachments/upload", { requireBackend: true })).toBe(
      "https://synara.test/api/attachments/upload",
    );
  });

  it("keeps explicit external network URLs independent of a missing desktop backend", () => {
    vi.stubGlobal("window", {
      desktopBridge: { getWsUrl: () => null },
      location: { origin: "synara-remote://app" },
    });

    expect(resolveWsHttpUrl("https://example.test/image.png", { requireBackend: true })).toBe(
      "https://example.test/image.png",
    );
  });
});

describe("typed execution resource routing", () => {
  const controller = {
    environmentId: EnvironmentId.makeUnsafe("controller"),
    label: "Controller",
    platform: { os: "darwin" as const, arch: "arm64" as const },
    serverVersion: "fixture",
    capabilities: { repositoryIdentity: true },
  };
  const execution = { ...controller, environmentId: EnvironmentId.makeUnsafe("mini") };
  const remoteContext: WindowExecutionContext = {
    controller,
    execution,
    remoteHostId: "host-mini",
    remote: {
      environmentId: execution.environmentId,
      accountAuthority: "https://account.example",
      userId: "fixture-user",
      organizationId: "fixture-org",
      channel: "beta",
    },
  };
  const upload: RemoteResource = {
    kind: "attachment-upload",
    threadId: "ios:fixture:thread",
    type: "image",
    name: "screen.png",
    mimeType: "image/png",
  };

  beforeEach(() => vi.stubEnv("VITE_WS_URL", ""));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("refuses a typed local upload when the desktop backend is missing", () => {
    vi.mocked(readExecutionContext).mockReturnValue({
      controller,
      execution: controller,
      remote: null,
    });
    vi.stubGlobal("window", {
      desktopBridge: { getWsUrl: () => null },
      location: { origin: "synara-remote://app" },
    });

    expect(() => resolveExecutionResource(upload)).toThrow(
      "The desktop connection is unavailable. Reconnect and try again.",
    );
  });

  it("routes remote uploads and previews through their selected host, never the local backend", () => {
    vi.mocked(readExecutionContext).mockReturnValue(remoteContext);
    const getWsUrl = vi.fn(() => "ws://127.0.0.1:4111/ws?token=local-only");
    const remoteResourceUrl = vi.fn(() => "synara-resource://broker/fixture-handle");
    vi.stubGlobal("window", {
      desktopBridge: { getWsUrl, remoteResourceUrl },
      location: { origin: "synara-remote://app" },
    });

    expect(resolveExecutionResource(upload)).toBe("synara-resource://broker/fixture-handle");
    expect(remoteResourceUrl).toHaveBeenNthCalledWith(1, "host-mini", {
      environmentId: execution.environmentId,
      resource: upload,
    });
    const attachmentId = "att_v2_11111111111111111111111111111111";
    expect(toAttachmentPreviewUrl(`/attachments/${attachmentId}`)).toBe(
      "synara-resource://broker/fixture-handle",
    );
    expect(remoteResourceUrl).toHaveBeenNthCalledWith(2, "host-mini", {
      environmentId: execution.environmentId,
      resource: { kind: "attachment", attachmentId },
    });
    expect(getWsUrl).not.toHaveBeenCalled();
  });

  it("refuses a missing remote broker instead of falling back to a local upload", () => {
    vi.mocked(readExecutionContext).mockReturnValue(remoteContext);
    const getWsUrl = vi.fn(() => "ws://127.0.0.1:4111/ws?token=local-only");
    vi.stubGlobal("window", {
      desktopBridge: { getWsUrl },
      location: { origin: "synara-remote://app" },
    });

    expect(() => resolveExecutionResource(upload)).toThrow(
      "Remote resources require the updated desktop bridge",
    );
    expect(getWsUrl).not.toHaveBeenCalled();
  });

  it("keeps browser resources on the owner-session proxy without copying local tokens", () => {
    vi.mocked(readExecutionContext).mockReturnValue(remoteContext);
    vi.stubEnv("VITE_WS_URL", "ws://127.0.0.1:4111/ws?token=local-only");
    vi.stubGlobal("window", { location: { origin: "https://controller.example" } });

    const url = new URL(resolveExecutionResource(upload));
    expect(url.origin).toBe("https://controller.example");
    expect(url.pathname).toBe("/api/remote/resource/host-mini");
    expect([...url.searchParams.keys()]).toEqual(["reference"]);
    expect(JSON.parse(url.searchParams.get("reference")!)).toEqual({
      environmentId: execution.environmentId,
      resource: upload,
    });
  });
});
