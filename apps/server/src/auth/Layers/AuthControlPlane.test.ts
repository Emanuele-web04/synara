import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite";
import { AuthControlPlane, type AuthControlPlaneError } from "../Services/AuthControlPlane";
import {
  SessionCredentialService,
  type SessionCredentialError,
} from "../Services/SessionCredentialService";
import { AuthControlPlaneLive, AuthCoreLive } from "./AuthControlPlane";
import { ServerSecretStoreLive } from "./ServerSecretStore";

const testLayer = AuthControlPlaneLive.pipe(
  Layer.provideMerge(AuthCoreLive),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStoreLive),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "dpcode-auth-control-plane-test-",
    }),
  ),
  Layer.provide(NodeServices.layer),
);

const runControlPlaneTest = (
  effect: Effect.Effect<
    void,
    AuthControlPlaneError | SessionCredentialError,
    AuthControlPlane | SessionCredentialService
  >,
) => effect.pipe(Effect.provide(testLayer), Effect.scoped, Effect.runPromise);

describe("AuthControlPlaneLive", () => {
  it("creates, lists, and revokes client pairing links", async () => {
    await runControlPlaneTest(
      Effect.gen(function* () {
        const authControlPlane = yield* AuthControlPlane;

        const created = yield* authControlPlane.createPairingLink({
          role: "client",
          subject: "one-time-token",
          label: "CI phone",
        });
        const listedBeforeRevoke = yield* authControlPlane.listPairingLinks({ role: "client" });
        const revoked = yield* authControlPlane.revokePairingLink(created.id);
        const listedAfterRevoke = yield* authControlPlane.listPairingLinks({ role: "client" });

        expect(created.role).toBe("client");
        expect(created.credential.length).toBeGreaterThan(0);
        expect(listedBeforeRevoke).toHaveLength(1);
        expect(listedBeforeRevoke[0]?.id).toBe(created.id);
        expect(listedBeforeRevoke[0]?.label).toBe("CI phone");
        expect(revoked).toBe(true);
        expect(listedAfterRevoke).toHaveLength(0);
      }),
    );
  });

  it("issues bearer sessions and lists them without raw tokens", async () => {
    await runControlPlaneTest(
      Effect.gen(function* () {
        const authControlPlane = yield* AuthControlPlane;
        const sessionCredentials = yield* SessionCredentialService;

        const issued = yield* authControlPlane.issueSession({ label: "deploy-bot" });
        const verified = yield* sessionCredentials.verify(issued.token);
        const listedBeforeRevoke = yield* authControlPlane.listSessions();
        const revoked = yield* authControlPlane.revokeSession(issued.sessionId);
        const listedAfterRevoke = yield* authControlPlane.listSessions();

        expect(issued.method).toBe("bearer-session-token");
        expect(issued.role).toBe("owner");
        expect(issued.client.deviceType).toBe("bot");
        expect(issued.client.label).toBe("deploy-bot");
        expect(verified.sessionId).toBe(issued.sessionId);
        expect(listedBeforeRevoke).toHaveLength(1);
        expect("token" in (listedBeforeRevoke[0] ?? {})).toBe(false);
        expect(revoked).toBe(true);
        expect(listedAfterRevoke).toHaveLength(0);
      }),
    );
  });

  it("revokes other sessions while keeping the selected one", async () => {
    await runControlPlaneTest(
      Effect.gen(function* () {
        const authControlPlane = yield* AuthControlPlane;

        const owner = yield* authControlPlane.issueSession({ label: "owner" });
        const client = yield* authControlPlane.issueSession({ role: "client", label: "client" });
        const beforeRevoke = yield* authControlPlane.listSessions();
        const revokedCount = yield* authControlPlane.revokeOtherSessionsExcept(owner.sessionId);
        const afterRevoke = yield* authControlPlane.listSessions();

        expect(beforeRevoke.map((entry) => entry.sessionId)).toContain(client.sessionId);
        expect(revokedCount).toBe(1);
        expect(afterRevoke).toHaveLength(1);
        expect(afterRevoke[0]?.sessionId).toBe(owner.sessionId);
      }),
    );
  });
});
