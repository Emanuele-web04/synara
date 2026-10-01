import {
  GRANT_JWT_TYP,
  GRANT_MAX_AGE_SECONDS,
  HOST_CONNECT_SCOPE,
  SYNARA_RELAY_AUDIENCE,
} from "@synara/contracts";
import type { HostGrantIssuer } from "./interfaces";
import type { ApiSigningService } from "./signing";

export function createHostGrantIssuer(signing: ApiSigningService): HostGrantIssuer {
  return {
    issueGrant({ userId, host, deviceJkt }) {
      return signing.sign({
        typ: GRANT_JWT_TYP,
        audience: SYNARA_RELAY_AUDIENCE,
        subject: userId,
        expiresInSeconds: GRANT_MAX_AGE_SECONDS,
        claims: {
          hostId: host.id,
          environmentId: host.environmentId,
          cnf: { jkt: deviceJkt },
          scope: [HOST_CONNECT_SCOPE],
        },
      });
    },
  };
}
