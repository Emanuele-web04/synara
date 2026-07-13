import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { DateTime, Effect, FileSystem, Path } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { EDITOR_ICON_ROUTE_PATH } from "@synara/shared/editorIcons";

import { clearEditorIconInFlightCache } from "./editorAppIcons";
import { createHttpRequestHandler, isLegacyTokenAuthorized } from "./http";
import type { ServerAuthShape } from "./auth/Services/ServerAuth";
import {
  deriveServerPaths,
  resolveDefaultChatWorkspaceRoot,
  resolveDefaultStudioWorkspaceRoot,
  type ServerConfigShape,
} from "./config";
import type { ProjectFaviconResolverShape } from "./project/Services/ProjectFaviconResolver";
import type { ServerReadiness } from "./server/readiness";

const tempDirs: string[] = [];

afterEach(() => {
  clearEditorIconInFlightCache();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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

const projectFaviconResolver: ProjectFaviconResolverShape = {
  resolvePath: () => Effect.succeed(null),
};

async function makeConfig(overrides: Partial<ServerConfigShape> = {}): Promise<ServerConfigShape> {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-http-test-"));
  tempDirs.push(baseDir);
  const derivedPaths = await Effect.runPromise(
    deriveServerPaths(baseDir, undefined).pipe(Effect.provide(NodeServices.layer)),
  );
  return {
    mode: "web",
    port: 0,
    host: undefined,
    cwd: baseDir,
    homeDir: os.homedir(),
    chatWorkspaceRoot: resolveDefaultChatWorkspaceRoot({ homeDir: os.homedir() }),
    studioWorkspaceRoot: resolveDefaultStudioWorkspaceRoot({ homeDir: os.homedir() }),
    baseDir,
    ...derivedPaths,
    staticDir: undefined,
    devUrl: undefined,
    noBrowser: true,
    authToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logProviderEvents: false,
    logWebSocketEvents: false,
    ...overrides,
  };
}

async function makeHandler(
  config: ServerConfigShape,
  auth?: {
    readonly serverAuth: ServerAuthShape;
    readonly cookieName: string;
  },
): Promise<http.RequestListener> {
  const services = await Effect.runPromise(
    Effect.gen(function* () {
      return {
        fileSystem: yield* FileSystem.FileSystem,
        path: yield* Path.Path,
      };
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  return createHttpRequestHandler({
    serverConfig: config,
    readiness,
    fileSystem: services.fileSystem,
    projectFaviconResolver,
    path: services.path,
    ...(auth
      ? {
          serverAuth: auth.serverAuth,
          sessionCredentials: { cookieName: auth.cookieName },
        }
      : {}),
  });
}

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFakeMacAppIcon(input: {
  readonly homeDir: string;
  readonly appName: string;
  readonly iconName: string;
  readonly bytes: Uint8Array;
}): void {
  const appContentsDir = path.join(
    input.homeDir,
    "Applications",
    `${input.appName}.app`,
    "Contents",
  );
  const resourcesDir = path.join(appContentsDir, "Resources");
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.writeFileSync(
    path.join(appContentsDir, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleIconFile</key>
  <string>${input.iconName}</string>
</dict>
</plist>`,
  );
  fs.writeFileSync(path.join(resourcesDir, `${input.iconName}.png`), input.bytes);
}

function writeFakeLinuxDesktopIcon(input: {
  readonly homeDir: string;
  readonly bytes: Uint8Array;
}): void {
  const applicationsDir = path.join(input.homeDir, ".local", "share", "applications");
  const iconsDir = path.join(
    input.homeDir,
    ".local",
    "share",
    "icons",
    "hicolor",
    "256x256",
    "apps",
  );
  fs.mkdirSync(applicationsDir, { recursive: true });
  fs.mkdirSync(iconsDir, { recursive: true });
  fs.writeFileSync(
    path.join(applicationsDir, "com.cursor.Cursor.desktop"),
    ["[Desktop Entry]", "Name=Cursor", "Exec=cursor %F", "Icon=cursor-http-test"].join("\n"),
  );
  fs.writeFileSync(path.join(iconsDir, "cursor-http-test.png"), input.bytes);
}

function writeNativeEditorIconFixture(homeDir: string): {
  readonly editorId: string;
  readonly bytes: Uint8Array;
} | null {
  const bytes = new Uint8Array([137, 80, 78, 71, 9, 8, 7]);
  if (process.platform === "darwin") {
    writeFakeMacAppIcon({
      homeDir,
      appName: "Ghostty",
      iconName: "Ghostty",
      bytes,
    });
    return { editorId: "ghostty", bytes };
  }
  if (process.platform === "linux") {
    writeFakeLinuxDesktopIcon({ homeDir, bytes });
    return { editorId: "cursor", bytes };
  }
  return null;
}

function makeAuthDescriptor() {
  return {
    policy: "loopback-browser" as const,
    bootstrapMethods: ["one-time-token" as const],
    sessionMethods: ["browser-session-cookie" as const, "bearer-session-token" as const],
    sessionCookieName: "synara_session",
  };
}

function makeFakeServerAuth(overrides: Partial<ServerAuthShape> = {}): ServerAuthShape {
  const expiresAt = Effect.runSync(DateTime.now);
  const descriptor = makeAuthDescriptor();
  return {
    getDescriptor: () => Effect.succeed(descriptor),
    getSessionState: () =>
      Effect.succeed({
        authenticated: false,
        auth: descriptor,
      }),
    exchangeBootstrapCredential: () =>
      Effect.succeed({
        response: {
          authenticated: true,
          role: "client",
          sessionMethod: "browser-session-cookie",
          expiresAt,
        },
        sessionToken: "session-token",
      }),
    exchangeBootstrapCredentialForBearerSession: () =>
      Effect.succeed({
        authenticated: true,
        role: "client",
        sessionMethod: "bearer-session-token",
        expiresAt,
        sessionToken: "bearer-session-token",
      }),
    issuePairingCredential: () =>
      Effect.succeed({ id: "pairing-id", credential: "PAIRINGTOKEN", expiresAt }),
    listPairingLinks: () => Effect.succeed([]),
    revokePairingLink: () => Effect.succeed(true),
    listClientSessions: () => Effect.succeed([]),
    revokeClientSession: () => Effect.succeed(true),
    revokeOtherClientSessions: () => Effect.succeed(1),
    authenticateHttpRequest: () =>
      Effect.succeed({
        sessionId: "session-id" as never,
        subject: "owner",
        method: "browser-session-cookie",
        role: "owner",
        expiresAt,
      }),
    authenticateWebSocketUpgrade: () =>
      Effect.succeed({
        sessionId: "session-id" as never,
        subject: "owner",
        method: "browser-session-cookie",
        role: "owner",
        expiresAt,
      }),
    issueWebSocketToken: () => Effect.succeed({ token: "ws-token", expiresAt }),
    issueStartupPairingUrl: () => Effect.succeed("http://127.0.0.1:3773/pair#token=PAIRINGTOKEN"),
    ...overrides,
  } satisfies ServerAuthShape;
}

async function withServer<T>(
  handler: http.RequestListener,
  run: (origin: string) => Promise<T>,
): Promise<T> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || !address) {
    throw new Error("Expected TCP server address");
  }
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("createHttpRequestHandler", () => {
  it("recognizes the desktop startup token for legacy attachment requests", async () => {
    const config = await makeConfig({ authToken: "desktop-secret" });

    expect(
      isLegacyTokenAuthorized({
        config,
        url: new URL("http://127.0.0.1:3773/attachments/attachment-id?token=desktop-secret"),
      }),
    ).toBe(true);
    expect(
      isLegacyTokenAuthorized({
        config,
        url: new URL("http://127.0.0.1:3773/attachments/attachment-id?token=wrong"),
      }),
    ).toBe(false);
  });

  it("serves health readiness JSON", async () => {
    const config = await makeConfig();
    const handler = await makeHandler(config);

    await withServer(handler, async (origin) => {
      const response = await fetch(`${origin}/health`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      await expect(response.json()).resolves.toMatchObject({
        status: "ok",
        startupReady: false,
        pushBusReady: true,
      });
    });
  });

  it("preserves dev URL redirect behavior", async () => {
    const config = await makeConfig({ devUrl: new URL("http://localhost:5173/") });
    const handler = await makeHandler(config);

    await withServer(handler, async (origin) => {
      const response = await fetch(`${origin}/anything`, { redirect: "manual" });

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("http://localhost:5173/");
    });
  });

  it("serves static files and SPA fallback", async () => {
    const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-static-test-"));
    tempDirs.push(staticDir);
    fs.writeFileSync(path.join(staticDir, "index.html"), "<main>app</main>");
    fs.writeFileSync(path.join(staticDir, "asset.txt"), "asset");
    const config = await makeConfig({ staticDir });
    const handler = await makeHandler(config);

    await withServer(handler, async (origin) => {
      const indexResponse = await fetch(`${origin}/missing-route`);
      expect(indexResponse.status).toBe(200);
      await expect(indexResponse.text()).resolves.toBe("<main>app</main>");

      const assetResponse = await fetch(`${origin}/asset.txt`);
      expect(assetResponse.status).toBe(200);
      await expect(assetResponse.text()).resolves.toBe("asset");
    });
  });

  it("serves attachments by id with immutable cache headers", async () => {
    const config = await makeConfig();
    fs.mkdirSync(config.attachmentsDir, { recursive: true });
    fs.writeFileSync(path.join(config.attachmentsDir, "attachment-id.bin"), "payload");
    const handler = await makeHandler(config);

    await withServer(handler, async (origin) => {
      const response = await fetch(`${origin}/attachments/attachment-id`);

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      await expect(response.text()).resolves.toBe("payload");
    });
  });

  it("serves cached native editor icons before dev/static fallback", async () => {
    const homeDir = makeTempDir("synara-http-editor-icon-home-");
    const fixture = writeNativeEditorIconFixture(homeDir);
    if (!fixture) return;

    const config = await makeConfig({ devUrl: new URL("http://localhost:5173/"), homeDir });
    const handler = await makeHandler(config);

    await withServer(handler, async (origin) => {
      const response = await fetch(`${origin}${EDITOR_ICON_ROUTE_PATH}?id=${fixture.editorId}`, {
        redirect: "manual",
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
      expect(response.headers.get("content-type")).toContain("image/png");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(fixture.bytes);
    });
  });

  it("serves auth session state before dev/static fallback", async () => {
    const config = await makeConfig({ devUrl: new URL("http://localhost:5173/") });
    const handler = await makeHandler(config, {
      serverAuth: makeFakeServerAuth(),
      cookieName: "synara_session",
    });

    await withServer(handler, async (origin) => {
      const response = await fetch(`${origin}/api/auth/session`, { redirect: "manual" });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      await expect(response.json()).resolves.toMatchObject({
        authenticated: false,
        auth: {
          policy: "loopback-browser",
        },
      });
    });
  });

  it("sets a session cookie on auth bootstrap", async () => {
    const config = await makeConfig();
    const handler = await makeHandler(config, {
      serverAuth: makeFakeServerAuth(),
      cookieName: "synara_session",
    });

    await withServer(handler, async (origin) => {
      const response = await fetch(`${origin}/api/auth/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: "PAIRINGTOKEN" }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toContain("synara_session=session-token");
      await expect(response.json()).resolves.toMatchObject({
        authenticated: true,
        sessionMethod: "browser-session-cookie",
      });
    });
  });
});
