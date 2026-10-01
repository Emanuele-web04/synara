import type { RemoteTrustedDevice, RemoteTrustScope } from "@synara/contracts";
import { ServiceMap, type Effect } from "effect";
import type { PersistenceSqlError } from "../Errors";

export interface RemoteDeviceTrustRepositoryShape {
  readonly resetEnvironment: (
    environmentId: string,
    now: string,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly hasIdentity: (environmentId: string) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly authorize: (
    scope: RemoteTrustScope,
    deviceJkt: string,
    generation?: number,
  ) => Effect.Effect<RemoteTrustedDevice | undefined, PersistenceSqlError>;
  readonly list: (
    scope: RemoteTrustScope,
  ) => Effect.Effect<readonly RemoteTrustedDevice[], PersistenceSqlError>;
  readonly revoke: (
    scope: RemoteTrustScope,
    deviceJkt: string,
    now: string,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly disable: (
    scope: RemoteTrustScope,
    now: string,
  ) => Effect.Effect<void, PersistenceSqlError>;
  /** Fires after the durable transaction, never before it. */
  readonly onRevoked: (
    listener: (scope: RemoteTrustScope, deviceJkt?: string) => void,
  ) => () => void;
}

export class RemoteDeviceTrustRepository extends ServiceMap.Service<
  RemoteDeviceTrustRepository,
  RemoteDeviceTrustRepositoryShape
>()("synara/persistence/RemoteDeviceTrust") {}
