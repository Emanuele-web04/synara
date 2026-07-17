import { describe, expect, it } from "vitest";

import type { CompanionFetch, CompanionFetchInit } from "./auth";
import { CompanionHttpError, createCompanionAuthClient } from "./auth";

const response = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe("Companion auth client", () => {
  it("uses cookie credentials and decodes legacy access profiles", async () => {
    const calls: Array<{ url: string; init: CompanionFetchInit | undefined }> = [];
    const fetch: CompanionFetch = async (url, init) => {
      calls.push({ url, init });
      return response(200, {
        authenticated: true,
        role: "client",
        sessionMethod: "browser-session-cookie",
        expiresAt: "2026-08-17T00:00:00.000Z",
      });
    };
    const auth = createCompanionAuthClient({ baseUrl: "https://synara.example/mobile/", fetch });

    const result = await auth.bootstrap("pairing-secret");

    expect(result.accessProfile).toBe("full");
    expect(calls[0]?.url).toBe("https://synara.example/api/auth/bootstrap");
    expect(calls[0]?.init?.credentials).toBe("include");
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ credential: "pairing-secret" }));
  });

  it("sends native bearer authorization without putting it in the URL", async () => {
    const calls: Array<{ url: string; init: CompanionFetchInit | undefined }> = [];
    const fetch: CompanionFetch = async (url, init) => {
      calls.push({ url, init });
      return response(200, {
        token: "short-lived-token",
        expiresAt: "2026-07-18T00:05:00.000Z",
      });
    };
    const auth = createCompanionAuthClient({ baseUrl: "https://synara.example", fetch });

    const result = await auth.issueWebSocketToken({ bearerToken: "native-session-secret" });

    expect(result.token).toBe("short-lived-token");
    expect(calls[0]?.url).not.toContain("native-session-secret");
    expect(calls[0]?.init?.headers?.Authorization).toBe("Bearer native-session-secret");
  });

  it("sends the user-selected device label only in the pairing request body", async () => {
    const calls: Array<{ url: string; init: CompanionFetchInit | undefined }> = [];
    const fetch: CompanionFetch = async (url, init) => {
      calls.push({ url, init });
      return response(200, {
        authenticated: true,
        role: "client",
        accessProfile: "companion",
        sessionMethod: "bearer-session-token",
        expiresAt: "2026-08-17T00:00:00.000Z",
        sessionToken: "native-session-secret",
      });
    };
    const auth = createCompanionAuthClient({ baseUrl: "https://synara.example", fetch });

    await auth.bootstrapBearer("pairing-secret", { deviceLabel: "Khush's iPhone" });

    expect(calls[0]?.url).not.toContain("pairing-secret");
    expect(calls[0]?.url).not.toContain("Khush");
    expect(calls[0]?.init?.body).toBe(
      JSON.stringify({ credential: "pairing-secret", deviceLabel: "Khush's iPhone" }),
    );
  });

  it("updates only the current device label through the dedicated Companion route", async () => {
    const calls: Array<{ url: string; init: CompanionFetchInit | undefined }> = [];
    const fetch: CompanionFetch = async (url, init) => {
      calls.push({ url, init });
      return response(200, { deviceLabel: "Khush's iPhone" });
    };
    const auth = createCompanionAuthClient({ baseUrl: "https://synara.example", fetch });

    const result = await auth.updateDeviceLabel("Khush's iPhone", {
      bearerToken: "native-session-secret",
    });

    expect(result.deviceLabel).toBe("Khush's iPhone");
    expect(calls[0]?.url).toBe(
      "https://synara.example/api/companion/v1/session/device-label",
    );
    expect(calls[0]?.init?.method).toBe("PATCH");
    expect(calls[0]?.init?.headers?.Authorization).toBe("Bearer native-session-secret");
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ deviceLabel: "Khush's iPhone" }));
  });

  it("returns typed errors without reflecting malformed response bodies", async () => {
    const fetch: CompanionFetch = async () => response(502, { stack: "secret stack" });
    const auth = createCompanionAuthClient({ baseUrl: "https://synara.example", fetch });

    const error = await auth.getSession().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(CompanionHttpError);
    expect((error as CompanionHttpError).code).toBe("HostUnavailable");
    expect((error as Error).message).not.toContain("secret stack");
  });
});
