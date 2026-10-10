import * as Net from "node:net";

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { NetError, NetService, resolveAvailablePort } from "./Net";

const closeServer = (server: Net.Server) =>
  Effect.sync(() => {
    try {
      server.close();
    } catch {
      // Ignore cleanup failures in tests.
    }
  });

const getPort = (server: Net.Server): number => {
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
};

const openServer = (host?: string): Effect.Effect<Net.Server, NetError> =>
  Effect.callback<Net.Server, NetError>((resume) => {
    const server = Net.createServer();
    let settled = false;

    const settle = (effect: Effect.Effect<Net.Server, NetError>) => {
      if (settled) return;
      settled = true;
      resume(effect);
    };

    server.once("error", (cause) => {
      settle(Effect.fail(new NetError({ message: "Failed to open test server", cause })));
    });

    if (host) {
      server.listen(0, host, () => settle(Effect.succeed(server)));
    } else {
      server.listen(0, () => settle(Effect.succeed(server)));
    }

    return closeServer(server);
  });

it.layer(NetService.layer)("NetService", (it) => {
  describe("Net helpers", () => {
    it.effect("reserveLoopbackPort returns a positive loopback port", () =>
      Effect.gen(function* () {
        const net = yield* NetService;
        const port = yield* net.reserveLoopbackPort();

        assert.ok(port > 0);
      }),
    );

    it.effect("isPortAvailableOnLoopback reports false for an occupied port", () =>
      Effect.acquireUseRelease(
        openServer("127.0.0.1"),
        (server) =>
          Effect.gen(function* () {
            const net = yield* NetService;
            const port = getPort(server);

            const available = yield* net.isPortAvailableOnLoopback(port);
            assert.equal(available, false);
          }),
        closeServer,
      ),
    );

    it.effect("findAvailablePort returns preferred when its reservation succeeds", () =>
      Effect.gen(function* () {
        const attempts: number[] = [];
        const preferred = 41_234;

        const resolved = yield* resolveAvailablePort(preferred, (port) => {
          attempts.push(port);
          return Effect.succeed(port);
        });
        assert.equal(resolved, preferred);
        assert.deepEqual(attempts, [preferred]);
      }),
    );

    it.effect("findAvailablePort falls back when preferred is occupied", () =>
      Effect.acquireUseRelease(
        openServer(),
        (server) =>
          Effect.gen(function* () {
            const net = yield* NetService;
            const preferred = getPort(server);

            const resolved = yield* net.findAvailablePort(preferred);
            assert.ok(resolved > 0);
            assert.notEqual(resolved, preferred);
          }),
        closeServer,
      ),
    );
  });
});
