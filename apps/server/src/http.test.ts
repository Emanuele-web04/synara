import http from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Exit, Layer, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vitest";

import { ServerAuth, type ServerAuthShape } from "./auth/Services/ServerAuth";
import {
  resolveDefaultChatWorkspaceRoot,
  resolveDefaultStudioWorkspaceRoot,
  ServerConfig,
  type ServerConfigShape,
} from "./config";
import {
  editorIconEffectRouteLayer,
  isLegacyTokenAuthorized,
  makeDesktopShutdownEffectRouteLayer,
  makeHealthEffectRouteLayer,
  projectFaviconEffectRouteLayer,
  staticAndDevEffectRouteLayer,
} from "./http";
import {
  ProjectFaviconResolver,
  type ProjectFaviconResolverShape,
} from "./project/Services/ProjectFaviconResolver";
import type { ServerReadiness } from "./server/readiness";
import {
  DESKTOP_SHUTDOWN_ROUTE_PATH,
  makeServerShutdownController,
  type ServerShutdownController,
} from "./serverShutdown";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeConfig(overrides: Partial<ServerConfigShape> = {}): ServerConfigShape {
  const baseDir = makeTempDir("synara-effect-http-");
  return {
    mode: "web",
    port: 0,
    host: "127.0.0.1",
    cwd: baseDir,
    homeDir: os.homedir(),
    chatWorkspaceRoot: resolveDefaultChatWorkspaceRoot({ homeDir: os.homedir() }),
    studioWorkspaceRoot: resolveDefaultStudioWorkspaceRoot({ homeDir: os.homedir() }),
    baseDir,
    keybindingsConfigPath: path.join(baseDir, "keybindings.json"),
    serverRuntimeStatePath: path.join(baseDir, "runtime.json"),
    serverSettingsPath: path.join(baseDir, "settings.json"),
    attachmentsDir: path.join(baseDir, "attachments"),
    sqlitePath: path.join(baseDir, "state.sqlite"),
    staticDir: undefined,
    devUrl: undefined,
    publicUrl: undefined,
    allowInsecureRemote: false,
    noBrowser: true,
    authToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logProviderEvents: false,
    logWebSocketEvents: false,
    ...overrides,
  } as ServerConfigShape;
}

const readiness: ServerReadiness = {
  awaitServerReady: Effect.void,
  markHttpListening: Effect.void,
  markPushBusReady: Effect.void,
  markKeybindingsReady: Effect.void,
  markTerminalSubscriptionsReady: Effect.void,
  markOrchestrationSubscriptionsReady: Effect.void,
  getSnapshot: Effect.succeed({
    httpListening: true,
    pushBusReady: true,
    keybindingsReady: true,
    terminalSubscriptionsReady: false,
    orchestrationSubscriptionsReady: false,
    startupReady: false,
  }),
};

const serverAuth = {
  authenticateHttpRequest: () =>
    Effect.succeed({
      sessionId: "11111111-1111-4111-8111-111111111111" as never,
      subject: "test-owner",
      method: "browser-session-cookie" as const,
      role: "owner" as const,
      credentialSource: "cookie" as const,
    }),
} as unknown as ServerAuthShape;

const projectFaviconResolver: ProjectFaviconResolverShape = {
  resolvePath: () => Effect.succeed(null),
};

type TestedRoute =
  | { readonly kind: "health"; readonly readiness: typeof readiness }
  | { readonly kind: "shutdown"; readonly controller: ServerShutdownController }
  | { readonly kind: "static" }
  | { readonly kind: "favicon" }
  | { readonly kind: "editor-icon" };

async function withEffectServer(
  config: ServerConfigShape,
  route: TestedRoute,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const scope = await Effect.runPromise(Scope.make("sequential"));
  let nodeServer: http.Server | null = null;
  try {
    await Effect.runPromise(
      Scope.provide(
        Effect.gen(function* () {
          const httpServer = yield* NodeHttpServer.make(
            () => {
              nodeServer = http.createServer();
              return nodeServer;
            },
            { port: 0, host: "127.0.0.1" },
          );
          if (route.kind === "static") {
            yield* httpServer.serve(yield* HttpRouter.toHttpEffect(staticAndDevEffectRouteLayer));
          } else if (route.kind === "shutdown") {
            yield* httpServer.serve(
              yield* HttpRouter.toHttpEffect(makeDesktopShutdownEffectRouteLayer(route.controller)),
            );
          } else if (route.kind === "favicon") {
            yield* httpServer.serve(yield* HttpRouter.toHttpEffect(projectFaviconEffectRouteLayer));
          } else if (route.kind === "editor-icon") {
            yield* httpServer.serve(yield* HttpRouter.toHttpEffect(editorIconEffectRouteLayer));
          } else {
            yield* httpServer.serve(
              yield* HttpRouter.toHttpEffect(makeHealthEffectRouteLayer(route.readiness)),
            );
          }
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(ServerConfig, config),
              Layer.succeed(ServerAuth, serverAuth),
              Layer.succeed(ProjectFaviconResolver, projectFaviconResolver),
              NodeHttpServer.layerHttpServices,
            ),
          ),
        ),
        scope,
      ),
    );
    const address = (nodeServer as http.Server | null)?.address();
    if (!address || typeof address !== "object") throw new Error("Expected server address");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

describe("production Effect HTTP routes", () => {
  it("preserves the loopback-only startup-token policy", () => {
    const loopback = makeConfig({ authToken: "desktop-secret" });
    expect(
      isLegacyTokenAuthorized({
        config: loopback,
        url: new URL("http://127.0.0.1/attachments/id?token=desktop-secret"),
      }),
    ).toBe(true);
    expect(
      isLegacyTokenAuthorized({
        config: { ...loopback, host: "0.0.0.0", allowInsecureRemote: true },
        url: new URL("http://192.168.1.50/attachments/id?token=desktop-secret"),
      }),
    ).toBe(false);
    expect(
      isLegacyTokenAuthorized({
        config: { ...loopback, publicUrl: new URL("https://synara.example.test/") },
        url: new URL("http://127.0.0.1/attachments/id?token=desktop-secret"),
      }),
    ).toBe(false);
  });

  it("serves readiness through the deployed health route", async () => {
    await withEffectServer(makeConfig(), { kind: "health", readiness }, async (origin) => {
      const response = await fetch(`${origin}/health`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        status: "ok",
        startupReady: false,
        pushBusReady: true,
      });
    });
  });

  it("accepts and idempotently replays the dedicated desktop shutdown request", async () => {
    const shutdownToken = "a".repeat(64);
    const controller = await Effect.runPromise(makeServerShutdownController());
    await withEffectServer(
      makeConfig({
        mode: "desktop",
        desktopShutdownToken: shutdownToken,
        authToken: "browser-token",
      }),
      { kind: "shutdown", controller },
      async (origin) => {
        for (let requestIndex = 0; requestIndex < 2; requestIndex += 1) {
          const response = await fetch(`${origin}${DESKTOP_SHUTDOWN_ROUTE_PATH}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${shutdownToken}` },
          });
          expect(response.status).toBe(202);
          await expect(response.json()).resolves.toEqual({ accepted: true });
        }
      },
    );

    await Effect.runPromise(controller.stopSignal);
    await expect(Effect.runPromise(controller.requestStop)).resolves.toBe(false);
  });

  it("rejects browser authority, query, cookie, missing, malformed, and wrong tokens", async () => {
    const shutdownToken = "a".repeat(64);
    const controller = await Effect.runPromise(makeServerShutdownController());
    await withEffectServer(
      makeConfig({
        mode: "desktop",
        desktopShutdownToken: shutdownToken,
        authToken: "browser-token",
      }),
      { kind: "shutdown", controller },
      async (origin) => {
        const requests: ReadonlyArray<RequestInit | undefined> = [
          undefined,
          { method: "POST", headers: { Authorization: `Bearer ${"b".repeat(64)}` } },
          { method: "POST", headers: { Authorization: "Basic browser-token" } },
          { method: "POST", headers: { Authorization: "Bearer browser-token" } },
          { method: "POST", headers: { Cookie: "synara_session=browser-session" } },
        ];

        for (const request of requests) {
          const requestOptions = request ? { method: "POST", ...request } : { method: "POST" };
          const response = await fetch(
            `${origin}${DESKTOP_SHUTDOWN_ROUTE_PATH}?token=${shutdownToken}`,
            requestOptions,
          );
          expect(response.status).toBe(401);
          expect(response.headers.get("www-authenticate")).toContain("Bearer");
        }
      },
    );

    await expect(Effect.runPromise(controller.requestStop)).resolves.toBe(true);
  });

  it("keeps the route unavailable outside a private desktop loopback deployment", async () => {
    const shutdownToken = "a".repeat(64);
    const unsafeConfigs: ReadonlyArray<Partial<ServerConfigShape>> = [
      { mode: "web" },
      { mode: "desktop", host: "0.0.0.0", allowInsecureRemote: true },
      { mode: "desktop", host: "192.168.1.50", allowInsecureRemote: true },
      { mode: "desktop", publicUrl: new URL("https://synara.example.test/") },
      { mode: "desktop", desktopShutdownToken: undefined },
    ];

    for (const overrides of unsafeConfigs) {
      const controller = await Effect.runPromise(makeServerShutdownController());
      await withEffectServer(
        makeConfig({ desktopShutdownToken: shutdownToken, ...overrides }),
        { kind: "shutdown", controller },
        async (origin) => {
          const response = await fetch(`${origin}${DESKTOP_SHUTDOWN_ROUTE_PATH}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${shutdownToken}` },
          });
          expect(response.status).toBe(404);
        },
      );
      await expect(Effect.runPromise(controller.requestStop)).resolves.toBe(true);
    }
  });

  it("does not register GET or OPTIONS shutdown handlers", async () => {
    const shutdownToken = "a".repeat(64);
    const controller = await Effect.runPromise(makeServerShutdownController());
    await withEffectServer(
      makeConfig({ mode: "desktop", desktopShutdownToken: shutdownToken }),
      { kind: "shutdown", controller },
      async (origin) => {
        for (const method of ["GET", "OPTIONS"]) {
          const response = await fetch(`${origin}${DESKTOP_SHUTDOWN_ROUTE_PATH}`, { method });
          expect(response.status).toBe(404);
        }
      },
    );
  });

  it("preserves dev redirect, static file, and SPA fallback behavior", async () => {
    await withEffectServer(
      makeConfig({ devUrl: new URL("http://localhost:5173/") }),
      { kind: "static" },
      async (origin) => {
        const response = await fetch(`${origin}/chat`, { redirect: "manual" });
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe("http://localhost:5173/");
      },
    );

    const staticDir = makeTempDir("synara-effect-static-");
    mkdirSync(path.join(staticDir, "assets"), { recursive: true });
    writeFileSync(path.join(staticDir, "index.html"), "<main>Synara shell</main>");
    writeFileSync(path.join(staticDir, "assets", "app.js"), "globalThis.synara = true;");
    await withEffectServer(makeConfig({ staticDir }), { kind: "static" }, async (origin) => {
      const asset = await fetch(`${origin}/assets/app.js`);
      expect(asset.status).toBe(200);
      await expect(asset.text()).resolves.toContain("globalThis.synara");

      const fallback = await fetch(`${origin}/chat/thread-id`);
      expect(fallback.status).toBe(200);
      expect(fallback.headers.get("content-type")).toContain("text/html");
      await expect(fallback.text()).resolves.toContain("Synara shell");
    });
  });

  it("uses the deployed favicon and editor-icon routes before static fallback", async () => {
    await withEffectServer(makeConfig(), { kind: "favicon" }, async (origin) => {
      const fallback = await fetch(`${origin}/api/project-favicon?cwd=/missing`);
      expect(fallback.status).toBe(200);
      expect(fallback.headers.get("content-type")).toContain("image/svg+xml");

      const noFallback = await fetch(`${origin}/api/project-favicon?cwd=/missing&fallback=none`);
      expect(noFallback.status).toBe(204);
    });

    await withEffectServer(makeConfig(), { kind: "editor-icon" }, async (origin) => {
      const response = await fetch(`${origin}/api/editor-icon`);
      expect(response.status).toBe(400);
      await expect(response.text()).resolves.toBe("Missing id parameter");
    });
  });
});
