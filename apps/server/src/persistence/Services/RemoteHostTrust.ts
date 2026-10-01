import type { RemotePairingBundle } from "@synara/contracts";
import { ServiceMap, type Effect } from "effect";
import type { PersistenceSqlError } from "../Errors";

export interface RemoteAccountBinding {
  readonly controllerEnvironmentId: string;
  readonly accountAuthority: string;
  readonly userId: string;
  readonly organizationId: string;
}
export interface RemoteHostTrustRecord {
  readonly environmentId: string;
  readonly rootCertificate: string;
  readonly rootFingerprint: string;
  readonly channel: RemotePairingBundle["channel"];
  readonly hostId: string;
  readonly label: string;
  readonly pairedAt: string | null;
}
export interface RemoteHostTrustRepositoryShape {
  readonly setDesired: (
    binding: RemoteAccountBinding,
    hostId: string,
    desired: boolean,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly listDesired: (
    binding: RemoteAccountBinding,
  ) => Effect.Effect<readonly RemoteHostTrustRecord[], PersistenceSqlError>;
  readonly get: (
    binding: RemoteAccountBinding,
    environmentId: string,
  ) => Effect.Effect<RemoteHostTrustRecord | undefined, PersistenceSqlError>;
  readonly importInvitation: (
    binding: RemoteAccountBinding,
    bundle: RemotePairingBundle,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly confirm: (
    binding: RemoteAccountBinding,
    environmentId: string,
    rootFingerprint: string,
    now: string,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly forget: (
    binding: RemoteAccountBinding,
    environmentId: string,
  ) => Effect.Effect<void, PersistenceSqlError>;
}
export class RemoteHostTrustRepository extends ServiceMap.Service<
  RemoteHostTrustRepository,
  RemoteHostTrustRepositoryShape
>()("synara/persistence/RemoteHostTrust") {}
