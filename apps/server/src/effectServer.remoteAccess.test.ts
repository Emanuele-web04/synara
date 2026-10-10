import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig, type ServerConfigShape } from "./config";
import { createEffectServer, ServerLifecycleError } from "./effectServer";
import { makeServerShutdownController } from "./serverShutdown";

function failFastConfig(
  overrides: Partial<
    Pick<ServerConfigShape, "host" | "authToken" | "devUrl" | "publicUrl" | "allowInsecureRemote">
  >,
): ServerConfigShape {
  return {
    host: "127.0.0.1",
    authToken: "proxy-secret",
    devUrl: undefined,
    publicUrl: undefined,
    allowInsecureRemote: false,
    ...overrides,
  } as ServerConfigShape;
}

async function runInvalidConfig(config: ServerConfigShape): Promise<ServerLifecycleError> {
  const program = makeServerShutdownController().pipe(
    Effect.flatMap((shutdownController) => createEffectServer(shutdownController)),
    Effect.provideService(ServerConfig, config),
  );
  return Effect.runPromise(
    Effect.flip(program) as Effect.Effect<ServerLifecycleError, never, never>,
  );
}

describe("createEffectServer remote policy guard", () => {
  it("rejects an invalid public URL before constructing runtime services", async () => {
    const error = await runInvalidConfig(
      failFastConfig({ publicUrl: new URL("http://synara.example.test/") }),
    );

    expect(error.operation).toBe("validateRemoteAccessPolicy");
    expect(String(error.cause)).toContain("must be an HTTPS root origin");
  });

  it("rejects a proxied dev URL before constructing runtime services", async () => {
    const error = await runInvalidConfig(
      failFastConfig({
        publicUrl: new URL("https://synara.example.test/"),
        devUrl: new URL("http://localhost:5173/"),
      }),
    );

    expect(error.operation).toBe("validateRemoteAccessPolicy");
    expect(String(error.cause)).toContain("cannot be combined with VITE_DEV_SERVER_URL");
  });
});
