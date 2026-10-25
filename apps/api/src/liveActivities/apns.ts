import { connect } from "node:http2";
import { importPKCS8, SignJWT } from "jose";
import type { ApnsConfig } from "../config";

export type ActivityDelivery = {
  environment: "sandbox" | "production";
  token: string;
  activityId: string;
  timestamp: number;
  event: "update" | "end";
  contentState: unknown;
};
export type NotificationDelivery = {
  environment: "sandbox" | "production";
  token: string;
  notificationId: string;
  threadId: string;
  turnId: string;
  result: "completed" | "failed";
};
export type ApnsResult = "delivered" | "invalid-token" | "retry" | "rejected";

/** One bounded HTTP/2 request. No credentials or Apple response bodies escape this boundary. */
export function createApnsSender(config: ApnsConfig) {
  const key = importPKCS8(config.privateKey, "ES256");
  const productionKey = config.productionCredentials
    ? importPKCS8(config.productionCredentials.privateKey, "ES256")
    : key;
  const cached: Partial<Record<ActivityDelivery["environment"], { jwt: string; created: number }>> =
    {};
  return async (delivery: ActivityDelivery | NotificationDelivery): Promise<ApnsResult> => {
    const notification = "notificationId" in delivery;
    if (config.environment !== "both" && delivery.environment !== config.environment)
      return "rejected";
    const now = Math.floor(Date.now() / 1000);
    // A cached Sandbox JWT cannot authenticate a Production-only Apple key.
    let credential = cached[delivery.environment];
    if (!credential || now - credential.created >= 3000) {
      credential = {
        jwt: await new SignJWT({})
          .setProtectedHeader({
            alg: "ES256",
            kid:
              delivery.environment === "production"
                ? (config.productionCredentials?.keyId ?? config.keyId)
                : config.keyId,
          })
          .setIssuer(config.teamId)
          .setIssuedAt(now)
          .sign(await (delivery.environment === "production" ? productionKey : key)),
        created: now,
      };
      cached[delivery.environment] = credential;
    }
    const authorization = credential.jwt;
    // Each persisted subscription retains its signing environment; TestFlight
    // must not redirect existing development tokens to the production gateway.
    const origin =
      delivery.environment === "sandbox"
        ? "https://api.sandbox.push.apple.com"
        : "https://api.push.apple.com";
    return new Promise<ApnsResult>((resolve) => {
      const session = connect(origin);
      const timer = setTimeout(() => finish("retry"), 8000);
      let settled = false;
      function finish(result: ApnsResult) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        session.destroy();
        resolve(result);
      }
      session.on("error", () => finish("retry"));
      session.on("connect", () => {
        if (settled) return;
        const stream = session.request({
          ":method": "POST",
          ":path": `/3/device/${delivery.token}`,
          authorization: `bearer ${authorization}`,
          "apns-topic": notification
            ? config.bundleId
            : `${config.bundleId}.push-type.liveactivity`,
          "apns-push-type": notification ? "alert" : "liveactivity",
          "apns-priority": notification || delivery.event === "end" ? "10" : "5",
          "apns-expiration": String(now + (notification ? 3600 : 60)),
          "apns-collapse-id": notification ? delivery.notificationId : delivery.activityId,
        });
        let status = 0;
        let body = "";
        stream.on("response", (headers) => {
          status = Number(headers[":status"]);
        });
        stream.on("data", (chunk: Buffer) => {
          if (body.length < 1024) body += chunk.toString();
        });
        stream.on("error", () => finish("retry"));
        stream.on("end", () => {
          let reason: unknown;
          try {
            reason = (JSON.parse(body) as { reason?: string }).reason;
          } catch {
            /* No raw response logging. */
          }
          finish(
            status === 200
              ? "delivered"
              : status === 410 || reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic"
                ? "invalid-token"
                : status === 429 || status >= 500
                  ? "retry"
                  : "rejected",
          );
        });
        stream.end(
          JSON.stringify(
            notification
              ? {
                  aps: {
                    alert: {
                      title: "Synara",
                      body: delivery.result === "completed" ? "Response ready" : "Run failed",
                    },
                    sound: "default",
                  },
                  source: "codex.runCompletion",
                  threadId: delivery.threadId,
                  turnId: delivery.turnId,
                  result: delivery.result,
                }
              : {
                  aps: {
                    timestamp: delivery.timestamp,
                    event: delivery.event,
                    "content-state": delivery.contentState,
                    ...(delivery.event === "end"
                      ? { "dismissal-date": now + 60 }
                      : { "stale-date": now + 90 }),
                  },
                },
          ),
        );
      });
    });
  };
}
