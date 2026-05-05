import * as NodeServices from "@effect/platform-node/NodeServices";
import { DateTime, Duration, Effect, Exit, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite";
import { AuthPairingLinkRepository } from "../../persistence/Services/AuthPairingLinks";
import { BootstrapCredentialService } from "../Services/BootstrapCredentialService";
import { BootstrapCredentialServiceLive } from "./BootstrapCredentialService";

const testLayer = BootstrapCredentialServiceLive.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(NodeServices.layer),
);

describe("BootstrapCredentialServiceLive", () => {
  it("issues, lists, and consumes one-time pairing credentials", async () => {
    await Effect.gen(function* () {
      const service = yield* BootstrapCredentialService;
      const issued = yield* service.issueOneTimeToken({ label: "Test device" });
      const active = yield* service.listActive();

      expect(active.map((link) => link.id)).toEqual([issued.id]);
      expect(active[0]?.label).toBe("Test device");

      const grant = yield* service.consume(issued.credential);
      expect(grant.method).toBe("one-time-token");
      expect(grant.role).toBe("client");

      const afterConsume = yield* service.listActive();
      expect(afterConsume).toEqual([]);
    }).pipe(Effect.provide(testLayer), Effect.runPromise);
  });

  it("rejects consumed credentials", async () => {
    await Effect.gen(function* () {
      const service = yield* BootstrapCredentialService;
      const issued = yield* service.issueOneTimeToken();
      yield* service.consume(issued.credential);

      const exit = yield* service.consume(issued.credential).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(testLayer), Effect.runPromise);
  });

  it("revokes active pairing links", async () => {
    await Effect.gen(function* () {
      const service = yield* BootstrapCredentialService;
      const issued = yield* service.issueOneTimeToken();

      expect(yield* service.revoke(issued.id)).toBe(true);
      expect(yield* service.revoke(issued.id)).toBe(false);
      expect(yield* service.listActive()).toEqual([]);
    }).pipe(Effect.provide(testLayer), Effect.runPromise);
  });

  it("does not list expired pairing links", async () => {
    await Effect.gen(function* () {
      const service = yield* BootstrapCredentialService;
      const repository = yield* AuthPairingLinkRepository;
      const now = yield* DateTime.now;
      const expiresAt = DateTime.subtractDuration(now, Duration.seconds(1));

      yield* repository.create({
        id: "expired-link",
        credential: "EXPIREDTOKEN",
        method: "one-time-token",
        role: "client",
        subject: "test",
        label: null,
        createdAt: now,
        expiresAt,
      });

      expect(yield* service.listActive()).toEqual([]);
      expect(yield* repository.getByCredential({ credential: "EXPIREDTOKEN" })).toSatisfy(
        Option.isSome,
      );
    }).pipe(Effect.provide(testLayer), Effect.runPromise);
  });
});
