import type http from "node:http";
import nodePath from "node:path";

import Mime from "@effect/platform-node/Mime";
import {
  AuthBootstrapInput,
  AuthCreatePairingCredentialInput,
  AuthRevokeClientSessionInput,
  AuthRevokePairingLinkInput,
  ThreadId,
} from "@t3tools/contracts";
import { EDITOR_ICON_ROUTE_PATH } from "@t3tools/shared/editorIcons";
import { threadExportBlockedReason } from "@t3tools/shared/threadExport";
import { DateTime, Effect, Exit, FileSystem, Layer, Option, Path, Schema, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import {
  ATTACHMENTS_ROUTE_PREFIX,
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths";
import { resolveAttachmentPathById } from "./attachmentStore.ts";
import { authErrorResponse, makeEffectAuthRequest, serveAuthHttpRoute } from "./auth/http";
import { ServerAuth } from "./auth/Services/ServerAuth";
import type { ServerAuthShape } from "./auth/Services/ServerAuth";
import type { SessionCredentialServiceShape } from "./auth/Services/SessionCredentialService";
import { SessionCredentialService } from "./auth/Services/SessionCredentialService";
import { deriveAuthClientMetadata } from "./auth/utils";
import { ServerConfig, type ServerConfigShape } from "./config";
import { resolveCachedEditorIcon } from "./editorAppIcons";
import { LOCAL_IMAGE_ROUTE_PATH, resolveAllowedLocalPreviewFile } from "./localImageFiles.ts";
import type { ProjectFaviconResolverShape } from "./project/Services/ProjectFaviconResolver";
import { ProjectFaviconResolver } from "./project/Services/ProjectFaviconResolver";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { threadArchiveChunks, threadArchiveFileName } from "./orchestration/exportThreadArchive";
import type { ServerReadiness } from "./server/readiness";
import { resolveFavicon, tryParseHost } from "./siteFaviconCache";
import { isTrustedAppOrigin, normalizeCorsOrigin } from "./trustedOrigins";

const PROJECT_FAVICON_CACHE_CONTROL = "public, max-age=3600";
const SITE_FAVICON_CACHE_CONTROL_SUCCESS = "public, max-age=86400"; // 24 h
const SITE_FAVICON_CACHE_CONTROL_FALLBACK = "public, max-age=3600"; // 1 h (negative result)
const EDITOR_ICON_CACHE_CONTROL_SUCCESS = "public, max-age=86400"; // 24 h
const decodeBootstrapInput = Schema.decodeUnknownEffect(AuthBootstrapInput);
const decodeCreatePairingCredentialInput = Schema.decodeUnknownEffect(
  AuthCreatePairingCredentialInput,
);
const decodeRevokePairingLinkInput = Schema.decodeUnknownEffect(AuthRevokePairingLinkInput);
const decodeRevokeClientSessionInput = Schema.decodeUnknownEffect(AuthRevokeClientSessionInput);

function resolveEditorIconCacheDir(config: ServerConfigShape): string {
  return nodePath.join(config.stateDir, "app-icons");
}

function resolveEditorIconEnv(config: ServerConfigShape): NodeJS.ProcessEnv {
  return { ...process.env, HOME: config.homeDir };
}

interface HttpPayload {
  readonly statusCode: number;
  readonly contentType: string;
  readonly headers?: Record<string, string>;
  readonly body: string | Uint8Array;
}

// Shared by the Effect route and the legacy request listener so editor-icon
// behavior cannot drift between the two HTTP stacks.
const resolveEditorIconHttpPayload = Effect.fn(function* (input: {
  readonly url: URL;
  readonly serverConfig: ServerConfigShape;
  readonly fileSystem: FileSystem.FileSystem;
}) {
  const editorId = input.url.searchParams.get("id");
  if (!editorId) {
    return {
      statusCode: 400,
      contentType: "text/plain",
      body: "Missing id parameter",
    } satisfies HttpPayload;
  }

  const icon = yield* Effect.promise(() =>
    resolveCachedEditorIcon({
      editorId,
      cacheDir: resolveEditorIconCacheDir(input.serverConfig),
      env: resolveEditorIconEnv(input.serverConfig),
    }),
  );
  if (!icon) {
    return {
      statusCode: 404,
      contentType: "text/plain",
      body: "Not Found",
    } satisfies HttpPayload;
  }

  const data = yield* input.fileSystem
    .readFile(icon.path)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (!data) {
    return {
      statusCode: 404,
      contentType: "text/plain",
      body: "Not Found",
    } satisfies HttpPayload;
  }

  return {
    statusCode: 200,
    contentType: icon.contentType,
    headers: { "Cache-Control": EDITOR_ICON_CACHE_CONTROL_SUCCESS },
    body: data,
  } satisfies HttpPayload;
});

function toEffectHttpResponse(payload: HttpPayload) {
  if (typeof payload.body === "string") {
    return HttpServerResponse.text(payload.body, {
      status: payload.statusCode,
      contentType: payload.contentType,
      ...(payload.headers ? { headers: payload.headers } : {}),
    });
  }

  return HttpServerResponse.uint8Array(payload.body, {
    status: payload.statusCode,
    contentType: payload.contentType,
    ...(payload.headers ? { headers: payload.headers } : {}),
  });
}

function localPreviewCorsHeaders(input: {
  readonly config: ServerConfigShape;
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly url: URL;
}): Record<string, string> {
  const origin = normalizeCorsOrigin(input.request.headers.origin);
  if (
    !origin ||
    !isTrustedAppOrigin({ origin, requestOrigin: input.url.origin, config: input.config })
  ) {
    return {};
  }
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
  };
}

export function makeEffectHttpRouteLayer(readiness: ServerReadiness) {
  return Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/health",
      readiness.getSnapshot.pipe(
        Effect.map((snapshot) =>
          HttpServerResponse.jsonUnsafe(
            {
              status: "ok",
              startupReady: snapshot.startupReady,
              pushBusReady: snapshot.pushBusReady,
              keybindingsReady: snapshot.keybindingsReady,
              terminalSubscriptionsReady: snapshot.terminalSubscriptionsReady,
              orchestrationSubscriptionsReady: snapshot.orchestrationSubscriptionsReady,
            },
            { status: 200 },
          ),
        ),
      ),
    ),
    authEffectRouteLayer,
    projectFaviconEffectRouteLayer,
    threadExportEffectRouteLayer,
    siteFaviconEffectRouteLayer,
    editorIconEffectRouteLayer,
    localImageEffectRouteLayer,
    attachmentsEffectRouteLayer,
    staticAndDevEffectRouteLayer,
  );
}

const requireAuthenticatedRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  yield* serverAuth.authenticateHttpRequest(makeEffectAuthRequest(request));
});

export function isLegacyTokenAuthorized(input: {
  readonly config: ServerConfigShape;
  readonly url: URL;
}): boolean {
  const legacyToken = input.url.searchParams.get("token");
  return !input.config.authToken || legacyToken === input.config.authToken;
}

function encodeCookie(input: {
  readonly name: string;
  readonly value: string;
  readonly expiresAt: DateTime.DateTime;
}) {
  return `${encodeURIComponent(input.name)}=${encodeURIComponent(input.value)}; Expires=${DateTime.toDate(input.expiresAt).toUTCString()}; HttpOnly; Path=/; SameSite=Lax`;
}

const readEffectJson = (request: HttpServerRequest.HttpServerRequest, message: string) =>
  request.json.pipe(
    Effect.mapError(
      (cause) =>
        new (class extends Error {
          override readonly cause = cause;
        })(message),
    ),
  );

const authEffectRouteLayer = HttpRouter.add(
  "*",
  "/api/auth/*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const sessions = yield* SessionCredentialService;
    const url = HttpServerRequest.toURL(request);
    if (!url) return HttpServerResponse.text("Bad Request", { status: 400 });
    const authRequest = makeEffectAuthRequest(request);

    if (request.method === "GET" && url.pathname === "/api/auth/session") {
      return HttpServerResponse.jsonUnsafe(yield* serverAuth.getSessionState(authRequest));
    }

    if (request.method === "POST" && url.pathname === "/api/auth/bootstrap") {
      const payload = yield* readEffectJson(request, "Invalid bootstrap payload.").pipe(
        Effect.flatMap(decodeBootstrapInput),
        Effect.mapError((cause) => ({
          message: "Invalid bootstrap payload.",
          status: 400 as const,
          cause,
        })),
      );
      const result = yield* serverAuth.exchangeBootstrapCredential(payload.credential, {
        ...deriveAuthClientMetadata({
          headers: request.headers,
          remoteAddress: request.remoteAddress ?? null,
        }),
      });
      return HttpServerResponse.jsonUnsafe(result.response, {
        headers: {
          "Set-Cookie": encodeCookie({
            name: sessions.cookieName,
            value: result.sessionToken,
            expiresAt: result.response.expiresAt,
          }),
        },
      });
    }

    if (request.method === "POST" && url.pathname === "/api/auth/bootstrap/bearer") {
      const payload = yield* readEffectJson(request, "Invalid bootstrap payload.").pipe(
        Effect.flatMap(decodeBootstrapInput),
        Effect.mapError((cause) => ({
          message: "Invalid bootstrap payload.",
          status: 400 as const,
          cause,
        })),
      );
      return HttpServerResponse.jsonUnsafe(
        yield* serverAuth.exchangeBootstrapCredentialForBearerSession(payload.credential, {
          ...deriveAuthClientMetadata({
            headers: request.headers,
            remoteAddress: request.remoteAddress ?? null,
          }),
        }),
      );
    }

    if (request.method === "POST" && url.pathname === "/api/auth/ws-token") {
      const session = yield* serverAuth.authenticateHttpRequest(authRequest);
      return HttpServerResponse.jsonUnsafe(yield* serverAuth.issueWebSocketToken(session));
    }

    if (request.method === "POST" && url.pathname === "/api/auth/pairing-token") {
      const session = yield* serverAuth.authenticateHttpRequest(authRequest);
      if (session.role !== "owner")
        return HttpServerResponse.jsonUnsafe(
          { error: "Only owner sessions can create pairing credentials." },
          { status: 403 },
        );
      const payload =
        Number(request.headers["content-length"] ?? "0") > 0
          ? yield* readEffectJson(request, "Invalid pairing credential payload.").pipe(
              Effect.flatMap(decodeCreatePairingCredentialInput),
              Effect.mapError((cause) => ({
                message: "Invalid pairing credential payload.",
                status: 400 as const,
                cause,
              })),
            )
          : {};
      return HttpServerResponse.jsonUnsafe(yield* serverAuth.issuePairingCredential(payload));
    }

    const ownerSession = Effect.gen(function* () {
      const session = yield* serverAuth.authenticateHttpRequest(authRequest);
      if (session.role !== "owner") {
        return yield* Effect.fail({
          message: "Only owner sessions can manage network access.",
          status: 403 as const,
        });
      }
      return session;
    });

    if (request.method === "GET" && url.pathname === "/api/auth/pairing-links") {
      yield* ownerSession;
      return HttpServerResponse.jsonUnsafe(yield* serverAuth.listPairingLinks());
    }

    if (request.method === "POST" && url.pathname === "/api/auth/pairing-links/revoke") {
      yield* ownerSession;
      const payload = yield* readEffectJson(request, "Invalid revoke pairing link payload.").pipe(
        Effect.flatMap(decodeRevokePairingLinkInput),
        Effect.mapError((cause) => ({
          message: "Invalid revoke pairing link payload.",
          status: 400 as const,
          cause,
        })),
      );
      return HttpServerResponse.jsonUnsafe({
        revoked: yield* serverAuth.revokePairingLink(payload.id),
      });
    }

    if (request.method === "GET" && url.pathname === "/api/auth/clients") {
      const session = yield* ownerSession;
      return HttpServerResponse.jsonUnsafe(yield* serverAuth.listClientSessions(session.sessionId));
    }

    if (request.method === "POST" && url.pathname === "/api/auth/clients/revoke") {
      const session = yield* ownerSession;
      const payload = yield* readEffectJson(request, "Invalid revoke client payload.").pipe(
        Effect.flatMap(decodeRevokeClientSessionInput),
        Effect.mapError((cause) => ({
          message: "Invalid revoke client payload.",
          status: 400 as const,
          cause,
        })),
      );
      return HttpServerResponse.jsonUnsafe({
        revoked: yield* serverAuth.revokeClientSession(session.sessionId, payload.sessionId),
      });
    }

    if (request.method === "POST" && url.pathname === "/api/auth/clients/revoke-others") {
      const session = yield* ownerSession;
      return HttpServerResponse.jsonUnsafe({
        revokedCount: yield* serverAuth.revokeOtherClientSessions(session.sessionId),
      });
    }

    return HttpServerResponse.text("Not Found", { status: 404 });
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          {
            error:
              error instanceof Error
                ? error.message
                : String((error as { message?: unknown }).message ?? error),
          },
          {
            status:
              typeof (error as { status?: unknown }).status === "number"
                ? (error as { status: number }).status
                : 500,
          },
        ),
      ),
    ),
  ),
);

const projectFaviconEffectRouteLayer = HttpRouter.add(
  "GET",
  "/api/project-favicon",
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest.pipe(
      Effect.catchTag("AuthError", (error) => Effect.fail(error)),
    );
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (!url) return HttpServerResponse.text("Bad Request", { status: 400 });
    const projectCwd = url.searchParams.get("cwd");
    if (!projectCwd) return HttpServerResponse.text("Missing cwd parameter", { status: 400 });
    const resolver = yield* ProjectFaviconResolver;
    const faviconPath = yield* resolver.resolvePath(projectCwd);
    if (!faviconPath) {
      if (url.searchParams.get("fallback") === "none")
        return HttpServerResponse.empty({ status: 204 });
      return HttpServerResponse.text(FALLBACK_FAVICON_SVG, {
        status: 200,
        contentType: "image/svg+xml",
        headers: { "Cache-Control": PROJECT_FAVICON_CACHE_CONTROL },
      });
    }
    return yield* HttpServerResponse.file(faviconPath, {
      status: 200,
      headers: { "Cache-Control": PROJECT_FAVICON_CACHE_CONTROL },
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
      ),
    );
  }).pipe(Effect.catchTag("AuthError", (error) => Effect.succeed(authErrorResponse(error)))),
);

// Resolves a real website favicon by domain (cached server-side, deduped by host)
// so the UI can replace generic globe icons. Mirrors project-favicon's auth +
// SVG-fallback shape; the actual fetch/cache logic lives in siteFaviconCache.ts.
const siteFaviconEffectRouteLayer = HttpRouter.add(
  "GET",
  "/api/site-favicon",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (!url) return HttpServerResponse.text("Bad Request", { status: 400 });

    // Loaded via <img> tags, which cannot attach Authorization headers — accept the
    // same startup-token rule the local-image/attachments routes use so favicons
    // load in local dev without a session cookie.
    const config = yield* ServerConfig;
    if (!isLegacyTokenAuthorized({ config, url })) {
      yield* requireAuthenticatedRequest;
    }

    const domainParam = url.searchParams.get("domain") ?? url.searchParams.get("url");
    if (!domainParam) return HttpServerResponse.text("Missing domain parameter", { status: 400 });
    const host = tryParseHost(domainParam);
    if (!host) return HttpServerResponse.text("Invalid domain", { status: 400 });

    const favicon = yield* Effect.promise(() => resolveFavicon(host));
    if (!favicon.bytes) {
      return HttpServerResponse.text(FALLBACK_SITE_FAVICON_SVG, {
        status: 200,
        contentType: "image/svg+xml",
        headers: { "Cache-Control": SITE_FAVICON_CACHE_CONTROL_FALLBACK },
      });
    }
    return HttpServerResponse.uint8Array(favicon.bytes, {
      status: 200,
      contentType: favicon.contentType ?? "image/x-icon",
      headers: { "Cache-Control": SITE_FAVICON_CACHE_CONTROL_SUCCESS },
    });
  }).pipe(Effect.catchTag("AuthError", (error) => Effect.succeed(authErrorResponse(error)))),
);

// Builds a ZIP export of a single thread (thread.json + transcript.md) and streams
// it back as a download. Loads only the requested thread detail so the export cost
// scales with that thread rather than the whole projection; mirrors the auth shape
// of the other binary GET routes (favicon/attachments).
const threadExportEffectRouteLayer = HttpRouter.add(
  "GET",
  "/api/thread-export",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (!url) return HttpServerResponse.text("Bad Request", { status: 400 });

    const config = yield* ServerConfig;
    if (!isLegacyTokenAuthorized({ config, url })) {
      yield* requireAuthenticatedRequest;
    }

    // Error responses need the trusted-origin CORS headers too: the desktop
    // app fetches cross-origin (t3://app), and without them the browser masks
    // a 400/404/409 body as an opaque network failure.
    const corsHeaders = localPreviewCorsHeaders({ config, request, url });

    const threadIdParam = url.searchParams.get("threadId")?.trim();
    if (!threadIdParam)
      return HttpServerResponse.text("Missing threadId parameter", {
        status: 400,
        headers: corsHeaders,
      });

    const snapshotQuery = yield* ProjectionSnapshotQuery;
    const threadOption = yield* snapshotQuery.getThreadDetailForExportById(
      ThreadId.makeUnsafe(threadIdParam),
    );
    if (Option.isNone(threadOption))
      return HttpServerResponse.text("Not Found", { status: 404, headers: corsHeaders });
    const thread = threadOption.value;

    const blockedReason = threadExportBlockedReason(thread);
    if (blockedReason !== null) {
      return HttpServerResponse.text(blockedReason, { status: 409, headers: corsHeaders });
    }

    const fileName = threadArchiveFileName({ title: thread.title, isoTimestamp: thread.updatedAt });
    return HttpServerResponse.stream(
      Stream.fromAsyncIterable(threadArchiveChunks(thread), (cause) => cause),
      {
        status: 200,
        contentType: "application/zip",
        headers: {
          "Content-Disposition": `attachment; filename="${fileName.replaceAll('"', "")}"`,
          "Cache-Control": "no-store",
          ...corsHeaders,
          "Access-Control-Expose-Headers": "Content-Disposition",
        },
      },
    );
  }).pipe(Effect.catchTag("AuthError", (error) => Effect.succeed(authErrorResponse(error)))),
);

const editorIconEffectRouteLayer = HttpRouter.add(
  "GET",
  EDITOR_ICON_ROUTE_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (!url) return HttpServerResponse.text("Bad Request", { status: 400 });

    const config = yield* ServerConfig;
    if (!isLegacyTokenAuthorized({ config, url })) {
      yield* requireAuthenticatedRequest;
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const payload = yield* resolveEditorIconHttpPayload({
      url,
      serverConfig: config,
      fileSystem,
    });
    return toEffectHttpResponse(payload);
  }).pipe(Effect.catchTag("AuthError", (error) => Effect.succeed(authErrorResponse(error)))),
);

// Streams a disk file as the response body instead of buffering it in memory:
// preview files can be large (PDFs especially), and a full-file buffer per
// request is an easy way to balloon server memory under concurrent loads.
// Callers must have stat'ed the file already — an unreadable file after that
// point aborts the connection mid-stream, which clients surface as a failed
// load (the same outcome the buffered 404 produced, minus the status code).
function streamedFileResponse(input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: string;
  readonly sizeBytes: number;
  readonly headers: Record<string, string>;
}): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.stream(input.fileSystem.stream(input.path), {
    status: 200,
    contentType: Mime.getType(input.path) ?? "application/octet-stream",
    contentLength: input.sizeBytes,
    headers: input.headers,
  });
}

export const localImageEffectRouteLayer = HttpRouter.add(
  "GET",
  LOCAL_IMAGE_ROUTE_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (!url) return HttpServerResponse.text("Bad Request", { status: 400 });

    const config = yield* ServerConfig;
    if (!isLegacyTokenAuthorized({ config, url })) {
      yield* requireAuthenticatedRequest;
    }

    const previewFile = yield* Effect.promise(() =>
      resolveAllowedLocalPreviewFile({
        requestedPath: url.searchParams.get("path"),
        cwd: url.searchParams.get("cwd"),
        allowAbsoluteLocalPreviewFile: true,
        previewGrant: url.searchParams.get("grant"),
      }).catch(() => null),
    );
    if (!previewFile) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    // Stream (don't use HttpServerResponse.file, which depends on
    // Etag.Generator/Path services and was failing with a 500 here).
    const fileSystem = yield* FileSystem.FileSystem;
    const isDownload = url.searchParams.get("download") === "1";
    const safeFileName = previewFile.fileName.replaceAll('"', "");
    return streamedFileResponse({
      fileSystem,
      path: previewFile.path,
      sizeBytes: previewFile.sizeBytes,
      headers: {
        "Cache-Control": "private, max-age=60",
        // The PDF viewer fetches bytes from either the desktop app origin or
        // the configured Vite dev origin. Reflect only those trusted origins:
        // auth-token-less local servers must not expose workspace files to any
        // random web page that can guess path/cwd query params.
        ...localPreviewCorsHeaders({ config, request, url }),
        // PDFs render in an unsandboxed same-origin iframe; never let the
        // browser second-guess the declared content type.
        "X-Content-Type-Options": "nosniff",
        ...(isDownload ? { "Content-Disposition": `attachment; filename="${safeFileName}"` } : {}),
      },
    });
  }).pipe(Effect.catchTag("AuthError", (error) => Effect.succeed(authErrorResponse(error)))),
);

export const attachmentsEffectRouteLayer = HttpRouter.add(
  "GET",
  `${ATTACHMENTS_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (!url) return HttpServerResponse.text("Bad Request", { status: 400 });

    const config = yield* ServerConfig;
    // Desktop image tags cannot attach Authorization headers; preserve the same
    // startup token rule that the WebSocket route already accepts.
    if (!isLegacyTokenAuthorized({ config, url })) {
      yield* requireAuthenticatedRequest;
    }

    const rawRelativePath = url.pathname.slice(ATTACHMENTS_ROUTE_PREFIX.length);
    const normalizedRelativePath = normalizeAttachmentRelativePath(rawRelativePath);
    if (!normalizedRelativePath) {
      return HttpServerResponse.text("Invalid attachment path", { status: 400 });
    }

    const isIdLookup =
      !normalizedRelativePath.includes("/") && !normalizedRelativePath.includes(".");
    const filePath = isIdLookup
      ? resolveAttachmentPathById({
          attachmentsDir: config.attachmentsDir,
          attachmentId: normalizedRelativePath,
        })
      : resolveAttachmentRelativePath({
          attachmentsDir: config.attachmentsDir,
          relativePath: normalizedRelativePath,
        });
    if (!filePath) {
      return HttpServerResponse.text(isIdLookup ? "Not Found" : "Invalid attachment path", {
        status: isIdLookup ? 404 : 400,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const fileInfo = yield* fileSystem
      .stat(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    // Mirror local-image serving instead of using HttpServerResponse.file; the Effect
    // route stack used by the desktop server can miss that helper's file services.
    return streamedFileResponse({
      fileSystem,
      path: filePath,
      sizeBytes: Number(fileInfo.size),
      headers: { "Cache-Control": "public, max-age=31536000, immutable" },
    });
  }).pipe(Effect.catchTag("AuthError", (error) => Effect.succeed(authErrorResponse(error)))),
);

const staticAndDevEffectRouteLayer = HttpRouter.add(
  "GET",
  "*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (!url) return HttpServerResponse.text("Bad Request", { status: 400 });

    const config = yield* ServerConfig;
    if (config.devUrl) {
      return HttpServerResponse.redirect(config.devUrl.toString(), { status: 302 });
    }

    if (!config.staticDir) {
      return HttpServerResponse.text("No static directory configured and no dev URL set.", {
        status: 503,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staticRoot = path.resolve(config.staticDir);
    const requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
    const rawRelativePath = requestPath.replace(/^[/\\]+/, "");
    const relativePath = path.normalize(rawRelativePath).replace(/^[/\\]+/, "");
    if (
      relativePath.length === 0 ||
      rawRelativePath.startsWith("..") ||
      relativePath.startsWith("..") ||
      relativePath.includes("\0")
    ) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const isWithinStaticRoot = (candidate: string) =>
      candidate === staticRoot ||
      candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);

    let filePath = path.resolve(staticRoot, relativePath);
    if (!isWithinStaticRoot(filePath)) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }
    if (!path.extname(filePath)) {
      filePath = path.resolve(filePath, "index.html");
      if (!isWithinStaticRoot(filePath)) {
        return HttpServerResponse.text("Invalid static file path", { status: 400 });
      }
    }

    const fileInfo = yield* fileSystem
      .stat(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      const indexPath = path.resolve(staticRoot, "index.html");
      const indexData = yield* fileSystem
        .readFile(indexPath)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!indexData) return HttpServerResponse.text("Not Found", { status: 404 });
      return HttpServerResponse.uint8Array(indexData, {
        status: 200,
        contentType: "text/html; charset=utf-8",
      });
    }

    const data = yield* fileSystem
      .readFile(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!data) return HttpServerResponse.text("Internal Server Error", { status: 500 });
    return HttpServerResponse.uint8Array(data, {
      status: 200,
      contentType: Mime.getType(filePath) ?? "application/octet-stream",
    });
  }),
);

const FALLBACK_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#6b728080" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-fallback="project-favicon"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z"/></svg>`;

const FALLBACK_SITE_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#6b728080" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-fallback="site-favicon"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20M12 2a14.5 14.5 0 0 1 0 20M2 12h20"/></svg>`;

type Respond = (
  statusCode: number,
  headers: Record<string, string | Array<string>>,
  body?: string | Uint8Array,
) => void;

export interface HttpRequestHandlerOptions {
  readonly serverConfig: ServerConfigShape;
  readonly readiness: ServerReadiness;
  readonly fileSystem: FileSystem.FileSystem;
  readonly projectFaviconResolver: ProjectFaviconResolverShape;
  readonly path: Path.Path;
  readonly serverAuth?: ServerAuthShape;
  readonly sessionCredentials?: Pick<SessionCredentialServiceShape, "cookieName">;
}

function makeResponder(res: http.ServerResponse): Respond {
  return (statusCode, headers, body) => {
    res.writeHead(statusCode, headers);
    res.end(body);
  };
}

export function createHttpRequestHandler({
  serverConfig,
  readiness,
  fileSystem,
  projectFaviconResolver,
  path,
  serverAuth,
  sessionCredentials,
}: HttpRequestHandlerOptions): http.RequestListener {
  const { port, staticDir, devUrl } = serverConfig;

  return (req, res) => {
    const respond = makeResponder(res);

    void Effect.runPromise(
      Effect.gen(function* () {
        const url = new URL(req.url ?? "/", `http://localhost:${port}`);

        if (url.pathname === "/health") {
          const readinessSnapshot = yield* readiness.getSnapshot;
          respond(
            200,
            { "Content-Type": "application/json; charset=utf-8" },
            JSON.stringify({
              status: "ok",
              startupReady: readinessSnapshot.startupReady,
              pushBusReady: readinessSnapshot.pushBusReady,
              keybindingsReady: readinessSnapshot.keybindingsReady,
              terminalSubscriptionsReady: readinessSnapshot.terminalSubscriptionsReady,
              orchestrationSubscriptionsReady: readinessSnapshot.orchestrationSubscriptionsReady,
            }),
          );
          return;
        }

        if (url.pathname === "/api/project-favicon") {
          yield* serveProjectFavicon({
            url,
            res,
            respond,
            fileSystem,
            projectFaviconResolver,
          });
          return;
        }

        if (url.pathname === EDITOR_ICON_ROUTE_PATH) {
          yield* serveEditorIcon({
            url,
            respond,
            serverConfig,
            fileSystem,
          });
          return;
        }

        if (url.pathname.startsWith("/api/auth/")) {
          if (!serverAuth || !sessionCredentials) {
            respond(503, { "Content-Type": "text/plain" }, "Auth service unavailable");
            return;
          }
          const handled = yield* serveAuthHttpRoute({
            url,
            req,
            respond,
            serverAuth,
            sessionCredentials,
          });
          if (handled) return;
        }

        if (url.pathname.startsWith(ATTACHMENTS_ROUTE_PREFIX)) {
          yield* serveAttachment({
            url,
            res,
            respond,
            serverConfig,
            fileSystem,
          });
          return;
        }

        if (devUrl) {
          respond(302, { Location: devUrl.href });
          return;
        }

        if (!staticDir) {
          respond(
            503,
            { "Content-Type": "text/plain" },
            "No static directory configured and no dev URL set.",
          );
          return;
        }

        yield* serveStaticAsset({
          url,
          respond,
          staticDir,
          fileSystem,
          path,
        });
      }),
    ).catch(() => {
      if (!res.headersSent) {
        respond(500, { "Content-Type": "text/plain" }, "Internal Server Error");
      }
    });
  };
}

const serveProjectFavicon = Effect.fn(function* (input: {
  readonly url: URL;
  readonly res: http.ServerResponse;
  readonly respond: Respond;
  readonly fileSystem: FileSystem.FileSystem;
  readonly projectFaviconResolver: ProjectFaviconResolverShape;
}) {
  const projectCwd = input.url.searchParams.get("cwd");
  if (!projectCwd) {
    input.respond(400, { "Content-Type": "text/plain" }, "Missing cwd parameter");
    return;
  }

  const faviconPath = yield* input.projectFaviconResolver.resolvePath(projectCwd);
  if (!faviconPath) {
    if (input.url.searchParams.get("fallback") === "none") {
      input.respond(204, { "Cache-Control": "public, max-age=3600" });
      return;
    }
    input.respond(
      200,
      {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=3600",
      },
      FALLBACK_FAVICON_SVG,
    );
    return;
  }

  const data = yield* input.fileSystem
    .readFile(faviconPath)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (!data) {
    input.respond(500, { "Content-Type": "text/plain" }, "Read error");
    return;
  }

  input.respond(
    200,
    {
      "Content-Type": Mime.getType(faviconPath) ?? "application/octet-stream",
      "Cache-Control": "public, max-age=3600",
    },
    data,
  );
});

const serveEditorIcon = Effect.fn(function* (input: {
  readonly url: URL;
  readonly respond: Respond;
  readonly serverConfig: ServerConfigShape;
  readonly fileSystem: FileSystem.FileSystem;
}) {
  if (!isLegacyTokenAuthorized({ config: input.serverConfig, url: input.url })) {
    input.respond(401, { "Content-Type": "text/plain" }, "Unauthorized");
    return;
  }

  const payload = yield* resolveEditorIconHttpPayload(input);
  input.respond(
    payload.statusCode,
    { "Content-Type": payload.contentType, ...(payload.headers ?? {}) },
    payload.body,
  );
});

const serveAttachment = Effect.fn(function* (input: {
  readonly url: URL;
  readonly res: http.ServerResponse;
  readonly respond: Respond;
  readonly serverConfig: ServerConfigShape;
  readonly fileSystem: FileSystem.FileSystem;
}) {
  const rawRelativePath = input.url.pathname.slice(ATTACHMENTS_ROUTE_PREFIX.length);
  const normalizedRelativePath = normalizeAttachmentRelativePath(rawRelativePath);
  if (!normalizedRelativePath) {
    input.respond(400, { "Content-Type": "text/plain" }, "Invalid attachment path");
    return;
  }

  const isIdLookup = !normalizedRelativePath.includes("/") && !normalizedRelativePath.includes(".");
  const filePath = isIdLookup
    ? resolveAttachmentPathById({
        attachmentsDir: input.serverConfig.attachmentsDir,
        attachmentId: normalizedRelativePath,
      })
    : resolveAttachmentRelativePath({
        attachmentsDir: input.serverConfig.attachmentsDir,
        relativePath: normalizedRelativePath,
      });
  if (!filePath) {
    input.respond(
      isIdLookup ? 404 : 400,
      { "Content-Type": "text/plain" },
      isIdLookup ? "Not Found" : "Invalid attachment path",
    );
    return;
  }

  const fileInfo = yield* input.fileSystem
    .stat(filePath)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (!fileInfo || fileInfo.type !== "File") {
    input.respond(404, { "Content-Type": "text/plain" }, "Not Found");
    return;
  }

  const contentType = Mime.getType(filePath) ?? "application/octet-stream";
  input.res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=31536000, immutable",
  });
  const streamExit = yield* Stream.runForEach(input.fileSystem.stream(filePath), (chunk) =>
    Effect.sync(() => {
      if (!input.res.destroyed) {
        input.res.write(chunk);
      }
    }),
  ).pipe(Effect.exit);
  if (Exit.isFailure(streamExit)) {
    if (!input.res.destroyed) {
      input.res.destroy();
    }
    return;
  }
  if (!input.res.writableEnded) {
    input.res.end();
  }
});

const serveStaticAsset = Effect.fn(function* (input: {
  readonly url: URL;
  readonly respond: Respond;
  readonly staticDir: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}) {
  const staticRoot = input.path.resolve(input.staticDir);
  const staticRequestPath = input.url.pathname === "/" ? "/index.html" : input.url.pathname;
  const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
  const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
  const staticRelativePath = input.path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
  const hasPathTraversalSegment = staticRelativePath.startsWith("..");
  if (
    staticRelativePath.length === 0 ||
    hasRawLeadingParentSegment ||
    hasPathTraversalSegment ||
    staticRelativePath.includes("\0")
  ) {
    input.respond(400, { "Content-Type": "text/plain" }, "Invalid static file path");
    return;
  }

  const isWithinStaticRoot = (candidate: string) =>
    candidate === staticRoot ||
    candidate.startsWith(
      staticRoot.endsWith(input.path.sep) ? staticRoot : `${staticRoot}${input.path.sep}`,
    );

  let filePath = input.path.resolve(staticRoot, staticRelativePath);
  if (!isWithinStaticRoot(filePath)) {
    input.respond(400, { "Content-Type": "text/plain" }, "Invalid static file path");
    return;
  }

  const ext = input.path.extname(filePath);
  if (!ext) {
    filePath = input.path.resolve(filePath, "index.html");
    if (!isWithinStaticRoot(filePath)) {
      input.respond(400, { "Content-Type": "text/plain" }, "Invalid static file path");
      return;
    }
  }

  const fileInfo = yield* input.fileSystem
    .stat(filePath)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (!fileInfo || fileInfo.type !== "File") {
    const indexPath = input.path.resolve(staticRoot, "index.html");
    const indexData = yield* input.fileSystem
      .readFile(indexPath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!indexData) {
      input.respond(404, { "Content-Type": "text/plain" }, "Not Found");
      return;
    }
    input.respond(200, { "Content-Type": "text/html; charset=utf-8" }, indexData);
    return;
  }

  const contentType = Mime.getType(filePath) ?? "application/octet-stream";
  const data = yield* input.fileSystem
    .readFile(filePath)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (!data) {
    input.respond(500, { "Content-Type": "text/plain" }, "Internal Server Error");
    return;
  }
  input.respond(200, { "Content-Type": contentType }, data);
});
