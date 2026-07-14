import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stdio from "effect/Stdio";

import * as AcpError from "../../src/errors.ts";
import * as AcpProtocol from "../../src/protocol.ts";

const program = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const terminated = yield* Deferred.make<AcpError.AcpError>();
  const protocol = yield* AcpProtocol.makeAcpPatchedProtocol({
    stdio,
    serverRequestMethods: new Set(),
    onTermination: (error) => Deferred.succeed(terminated, error).pipe(Effect.asVoid),
  });

  yield* protocol.notify("conformance/ready", { ready: true });
  yield* Deferred.await(terminated);
});

program.pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
