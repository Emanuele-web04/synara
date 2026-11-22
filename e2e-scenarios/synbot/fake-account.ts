// A local stand-in for the Synara Account API, for the Stable gate scenarios only.
//
// It answers the calls a signed-in Stable host makes (instance, OTP sign-in, refresh, me, billing
// status) and nothing else. Billing is "free" until a scenario switches it with
// `POST /__scenario/billing {"mode":"alto"|"free"|"error"}`; every billing read is counted at
// `GET /__scenario/state`. Tokens are fixed fake strings; no real account is involved.
import * as nodeHttp from "node:http";

export type BillingMode = "free" | "alto" | "error";

const USER = { id: "user_scenario", email: "scenario@example.invalid", name: "Scenario" };

export function startFakeAccount(host: string, port: number) {
  let billing: BillingMode = "free";
  let billingReads = 0;
  const server = nodeHttp.createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      const json = (status: number, data: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(data));
      };
      const parsed = (() => {
        try {
          return body ? (JSON.parse(body) as Record<string, unknown>) : {};
        } catch {
          return {};
        }
      })();
      const route = `${request.method} ${url.pathname}`;
      switch (route) {
        case "POST /__scenario/billing": {
          const mode = parsed.mode;
          if (mode !== "free" && mode !== "alto" && mode !== "error") return json(400, {});
          billing = mode;
          return json(200, { billing });
        }
        case "GET /__scenario/state":
          return json(200, { billing, billingReads });
        case "GET /api/v1/instance":
          return json(200, {
            version: "0.0.0-scenario",
            remoteBillingEnforced: false,
            authMode: "workos",
            clientId: "client_scenario",
            workosApiUrl: `http://${host}:${port}`,
          });
        case "POST /api/v1/auth/otp/send":
          return json(202, {
            email: typeof parsed.email === "string" ? parsed.email : USER.email,
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
          });
        case "POST /api/v1/auth/otp/authenticate":
          if (parsed.code !== "123456") {
            return json(401, { code: "invalid_verification_code", message: "Invalid code" });
          }
          return json(200, {
            accessToken: "scenario-access-1",
            refreshToken: "scenario-refresh-1",
            user: USER,
          });
        case "POST /api/v1/auth/refresh":
          return json(200, {
            accessToken: "scenario-access-2",
            refreshToken: "scenario-refresh-2",
            organizationId: "org_scenario",
            user: USER,
          });
        case "GET /api/v1/me":
          return json(200, {
            ...USER,
            organization: { id: "org_scenario", name: "Scenario" },
            profile: {
              handle: "scenario",
              displayName: USER.name,
              avatarColor: "#1a80fa",
              public: false,
              avatarSource: "placeholder",
            },
            publicProfileAvailable: false,
          });
        case "GET /api/v1/billing/status": {
          billingReads += 1;
          if (billing === "error") return json(500, { code: "unavailable", message: "Outage" });
          const alto = billing === "alto";
          return json(200, {
            provider: "polar",
            environment: "sandbox",
            available: true,
            access: alto ? "granted" : "none",
            subscriptionStatus: alto ? "active" : null,
            validUntil: alto ? "2099-01-01T00:00:00.000Z" : null,
            cancelAtPeriodEnd: false,
            checkedAt: new Date().toISOString(),
            canCheckout: !alto,
            canManage: alto,
            plans: [{ interval: "month", amountMinor: 1900, currency: "USD" }],
          });
        }
        case "GET /api/v1/hosts":
          return json(200, { hosts: [] });
        case "GET /api/v1/devices":
          return json(200, { devices: [] });
        case "GET /api/v1/organization/member-count":
          return json(200, { organizationMemberCount: 1 });
        case "POST /api/v1/auth/logout":
          response.writeHead(204);
          response.end();
          return;
        default:
          return json(404, { code: "not_found", message: route });
      }
    });
  });
  return new Promise<{ readonly url: string; close(): void }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () =>
      resolve({ url: `http://${host}:${port}`, close: () => server.close() }),
    );
  });
}
