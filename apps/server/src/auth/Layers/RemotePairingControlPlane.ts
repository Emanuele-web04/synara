import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { RemotePairingStatus } from "@synara/contracts";
import { DateTime, Effect } from "effect";
import type {
  RemotePairingRecord,
  RemotePairingRepositoryShape,
} from "../../persistence/Services/AuthPairingLinks";
import { AuthControlPlaneError, type AuthControlPlaneShape } from "../Services/AuthControlPlane";

function status(record: RemotePairingRecord): RemotePairingStatus {
  return {
    inviteId: record.id,
    expiresAt: record.expiresAt,
    pendingDevice: record.pendingDevice,
    approved: record.consumedAt !== null,
    revoked: record.revokedAt !== null,
  };
}

const failed = (cause: unknown) =>
  new AuthControlPlaneError({ message: "Remote pairing operation failed.", cause });
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

/** The remote purpose shares the existing control plane, with a separate secret policy. */
export function makeRemotePairingControlPlane(
  repository: RemotePairingRepositoryShape,
): AuthControlPlaneShape["remotePairing"] {
  return {
    create: (scope) =>
      Effect.gen(function* () {
        const createdAt = yield* now;
        const secret = randomBytes(32).toString("base64url");
        const inviteId = randomUUID();
        const expiresAt = new Date(Date.parse(createdAt) + 10 * 60_000).toISOString();
        yield* repository.create({
          id: inviteId,
          credentialHash: createHash("sha256").update(secret).digest("hex"),
          scope,
          createdAt,
          expiresAt,
        });
        return { inviteId, secret, expiresAt };
      }).pipe(Effect.mapError(failed)),
    verifyInvitation: (scope, id, secret) =>
      Effect.gen(function* () {
        const record = yield* repository.get(scope, id);
        const currentTime = yield* now;
        const expected =
          record?.credentialHash && /^[a-f0-9]{64}$/.test(record.credentialHash)
            ? Buffer.from(record.credentialHash, "hex")
            : Buffer.alloc(32);
        const actual = createHash("sha256").update(secret).digest();
        const matches = timingSafeEqual(expected, actual);
        if (
          !record ||
          !matches ||
          !/^[A-Za-z0-9_-]{43}$/.test(secret) ||
          record.revokedAt !== null ||
          (record.consumedAt === null && record.expiresAt <= currentTime)
        ) {
          return yield* Effect.fail(
            new AuthControlPlaneError({
              message: "Remote invitation is invalid, expired, or revoked.",
            }),
          );
        }
        return status(record);
      }).pipe(Effect.mapError(failed)),
    requestApproval: (scope, id, device) =>
      now.pipe(
        Effect.flatMap((currentTime) => repository.requestApproval(scope, id, device, currentTime)),
        Effect.mapError(failed),
      ),
    approve: (scope, id, jkt) =>
      now.pipe(
        Effect.flatMap((currentTime) => repository.approve(scope, id, jkt, currentTime)),
        Effect.mapError(failed),
      ),
    list: (scope) =>
      repository.list(scope).pipe(
        Effect.map((records) => records.map(status)),
        Effect.mapError(failed),
      ),
    revoke: (scope, id) =>
      now.pipe(
        Effect.flatMap((currentTime) => repository.revoke(scope, id, currentTime)),
        Effect.mapError(failed),
      ),
  };
}
