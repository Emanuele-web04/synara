import { EventEmitter } from "node:events";
import { generateKeyPairSync } from "node:crypto";
import { importSPKI, jwtVerify } from "jose";
import { describe, expect, it, vi } from "vitest";
import { createApnsSender } from "./apns";

const wire = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("node:http2", () => ({ connect: wire.connect }));

// Capture the actual signed HTTP/2 request; Apple status alone is the fixture.
function captureAppleRequests(status: number, reason: string) {
  const requests: { origin: string; headers: Record<string, string>; payload: string }[] = [];
  wire.connect.mockImplementation((origin: string) => {
    const session = new EventEmitter() as EventEmitter & {
      request: (headers: Record<string, string>) => unknown;
      destroy: () => void;
    };
    session.destroy = vi.fn();
    session.request = (headers) => {
      const stream = new EventEmitter() as EventEmitter & { end: (payload: string) => void };
      stream.end = (payload) => {
        requests.push({ origin, headers, payload });
        queueMicrotask(() => {
          stream.emit("response", { ":status": status });
          stream.emit("data", Buffer.from(JSON.stringify({ reason })));
          stream.emit("end");
        });
      };
      return stream;
    };
    queueMicrotask(() => session.emit("connect"));
    return session;
  });
  return requests;
}

describe("APNs HTTP/2 boundary", () => {
  it.each([
    [200, "", "delivered", "sandbox"],
    [200, "", "delivered", "production"],
    [410, "Unregistered", "invalid-token", "sandbox"],
    [400, "BadDeviceToken", "invalid-token", "production"],
    [429, "TooManyRequests", "retry", "sandbox"],
    [403, "InvalidProviderToken", "rejected", "production"],
  ] as const)(
    "classifies %s without exposing tokens or response data",
    async (status, reason, expected, environment) => {
      const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const requests = captureAppleRequests(status, reason);
      const send = createApnsSender({
        privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        keyId: "ABCD123456",
        teamId: "TEAM123456",
        bundleId: "com.example.synara",
        environment: "both",
      });
      expect(
        await send({
          environment,
          token: "a".repeat(64),
          activityId: "example-activity",
          timestamp: 1790000000,
          event: "end",
          contentState: { updatedAt: 811692800 },
        }),
      ).toBe(expected);
      const { origin, headers, payload } = requests[0]!;
      expect(origin).toBe(
        environment === "sandbox"
          ? "https://api.sandbox.push.apple.com"
          : "https://api.push.apple.com",
      );
      expect(headers["apns-topic"]).toBe("com.example.synara.push-type.liveactivity");
      expect(headers["apns-push-type"]).toBe("liveactivity");
      const verified = await jwtVerify(
        headers.authorization!.slice(7),
        await importSPKI(publicKey.export({ type: "spki", format: "pem" }).toString(), "ES256"),
        { issuer: "TEAM123456", algorithms: ["ES256"] },
      );
      expect(verified.protectedHeader.kid).toBe("ABCD123456");
      expect(JSON.parse(payload)).toMatchObject({
        aps: {
          event: "end",
          timestamp: 1790000000,
          "content-state": { updatedAt: 811692800 },
          "dismissal-date": expect.any(Number),
        },
      });
    },
  );

  it.each(["sandbox", "production"] as const)(
    "sends ordinary %s completion alerts using the app topic and private routing only",
    async (environment) => {
      const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const requests = captureAppleRequests(200, "");
      const send = createApnsSender({
        privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        keyId: "ABCD123456",
        teamId: "TEAM123456",
        bundleId: "com.example.synara",
        environment: "both",
      });
      expect(
        await send({
          environment,
          token: "a".repeat(64),
          notificationId: "one-exact-turn",
          threadId: "phone-namespaced-thread",
          turnId: "raw-turn",
          result: "completed",
        }),
      ).toBe("delivered");
      const { headers, payload } = requests[0]!;
      expect(headers).toMatchObject({
        "apns-topic": "com.example.synara",
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-collapse-id": "one-exact-turn",
      });
      expect(JSON.parse(payload)).toEqual({
        aps: { alert: { title: "Synara", body: "Response ready" }, sound: "default" },
        source: "codex.runCompletion",
        threadId: "phone-namespaced-thread",
        turnId: "raw-turn",
        result: "completed",
      });
    },
  );

  it("signs and caches each environment with its own Apple credential", async () => {
    const sandbox = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const production = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const requests = captureAppleRequests(200, "");
    const send = createApnsSender({
      privateKey: sandbox.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      keyId: "SANDBOX123",
      productionCredentials: {
        privateKey: production.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        keyId: "PROD123456",
      },
      teamId: "TEAM123456",
      bundleId: "com.example.synara",
      environment: "both",
    });
    for (const environment of ["sandbox", "production", "sandbox", "production"] as const) {
      expect(
        await send({
          environment,
          token: "a".repeat(64),
          activityId: "activity",
          timestamp: 1790000000,
          event: "update",
          contentState: {},
        }),
      ).toBe("delivered");
      const { origin, headers } = requests.at(-1)!;
      expect(origin).toBe(
        environment === "sandbox"
          ? "https://api.sandbox.push.apple.com"
          : "https://api.push.apple.com",
      );
      const publicKey = environment === "sandbox" ? sandbox.publicKey : production.publicKey;
      const verified = await jwtVerify(
        headers.authorization!.slice(7),
        await importSPKI(publicKey.export({ type: "spki", format: "pem" }).toString(), "ES256"),
        { issuer: "TEAM123456", algorithms: ["ES256"] },
      );
      expect(verified.protectedHeader.kid).toBe(
        environment === "sandbox" ? "SANDBOX123" : "PROD123456",
      );
    }
    expect(requests[0]!.headers.authorization).toBe(requests[2]!.headers.authorization);
    expect(requests[1]!.headers.authorization).toBe(requests[3]!.headers.authorization);
  });
});
