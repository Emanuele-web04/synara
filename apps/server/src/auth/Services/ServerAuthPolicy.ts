import type { ServerAuthDescriptor } from "@t3tools/contracts";
import { Effect, ServiceMap } from "effect";

export interface ServerAuthPolicyShape {
  readonly getDescriptor: () => Effect.Effect<ServerAuthDescriptor>;
}

export class ServerAuthPolicy extends ServiceMap.Service<ServerAuthPolicy, ServerAuthPolicyShape>()(
  "t3/auth/Services/ServerAuthPolicy",
) {}
