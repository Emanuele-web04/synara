import * as Crypto from "node:crypto";

import {
  CompanionPushSubscriptionInput,
  CompanionUpdateDeviceLabelInput,
  CompanionUploadId,
  ThreadId,
} from "@synara/contracts";
import { Effect, FileSystem, Layer, Path, Schema, Stream } from "effect";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  Multipart,
} from "effect/unstable/http";

import { makeEffectAuthRequest } from "../auth/effectHttp";
import { ServerAuth, type AuthenticatedHttpSession } from "../auth/Services/ServerAuth";
import { SessionCredentialService } from "../auth/Services/SessionCredentialService";
import { ServerConfig, type ServerConfigShape } from "../config";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery";
import { shouldRejectAuthMutationOrigin } from "../trustedOrigins";
import {
  CompanionAttachmentStore,
  COMPANION_MAX_FILE_BYTES,
  COMPANION_MAX_IMAGE_BYTES,
} from "./AttachmentStore";
import { CompanionPushService } from "./PushService";
import { version as serverVersion } from "../../package.json" with { type: "json" };

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;
const decodeThreadId = Schema.decodeUnknownEffect(ThreadId);
const decodePushInput = Schema.decodeUnknownEffect(CompanionPushSubscriptionInput);
const decodeUpdateDeviceLabelInput = Schema.decodeUnknownEffect(
  CompanionUpdateDeviceLabelInput,
);

class CompanionHttpError extends Error {
  constructor(
    readonly code:
      | "Unauthenticated"
      | "SessionExpired"
      | "Forbidden"
      | "NotFound"
      | "ValidationFailed"
      | "PayloadTooLarge"
      | "RateLimited"
      | "InternalError",
    message: string,
    readonly status: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

interface UploadState {
  readonly fields: Readonly<Record<string, string>>;
  readonly file:
    | {
        readonly temporaryPath: string;
        readonly filename: string;
        readonly mediaType: string;
        readonly sizeBytes: number;
        readonly signature: Uint8Array;
        readonly sha256: string;
      }
    | undefined;
}

function errorResponse(error: CompanionHttpError) {
  return HttpServerResponse.jsonUnsafe(
    {
      _tag: error.code,
      message: error.message,
      retryable: error.status >= 500,
    },
    { status: error.status, headers: NO_STORE_HEADERS },
  );
}

function internalError(message: string, cause?: unknown) {
  return new CompanionHttpError("InternalError", message, 500, { cause });
}

/** Wrap route errors without leaking stack traces or internal paths to the device. */
export function companionHttpErrorBoundary<R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, unknown, R>,
) {
  return effect.pipe(
    Effect.catch((cause) =>
      Effect.succeed(
        errorResponse(
          cause instanceof CompanionHttpError
            ? cause
            : new CompanionHttpError("InternalError", "The Companion request failed.", 500),
        ),
      ),
    ),
  );
}

function isImageMediaType(mediaType: string): boolean {
  return mediaType.toLowerCase().startsWith("image/");
}

function isMultipartSizeError(value: unknown): boolean {
  return (
    value instanceof Multipart.MultipartError &&
    (value.reason._tag === "FileTooLarge" ||
      value.reason._tag === "FieldTooLarge" ||
      value.reason._tag === "BodyTooLarge")
  );
}

function startsWith(bytes: Uint8Array, expected: ReadonlyArray<number>): boolean {
  return expected.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return Buffer.from(bytes.subarray(start, start + length)).toString("ascii");
}

/** Images are never trusted based on the multipart media type alone. */
export function matchesImageSignature(mediaType: string, bytes: Uint8Array): boolean {
  switch (mediaType.toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/gif":
      return ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a";
    case "image/webp":
      return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP";
    case "image/bmp":
      return ascii(bytes, 0, 2) === "BM";
    case "image/tiff":
      return (
        startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) ||
        startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])
      );
    case "image/x-icon":
    case "image/vnd.microsoft.icon":
      return startsWith(bytes, [0x00, 0x00, 0x01, 0x00]);
    case "image/avif":
    case "image/heic":
    case "image/heif": {
      if (ascii(bytes, 4, 4) !== "ftyp") return false;
      return /^(?:avif|avis|heic|heix|hevc|hevx|mif1|msf1)$/.test(ascii(bytes, 8, 4));
    }
    default:
      // SVG and unknown image formats are intentionally rejected: their active content and
      // ambiguous decoders make a claimed image/* type insufficient validation.
      return false;
  }
}

function validateBrowserOrigin(input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly session: AuthenticatedHttpSession;
  readonly config: ServerConfigShape;
  readonly requestUrl: URL;
}) {
  if (input.request.method === "GET" || input.request.method === "HEAD") return;
  if (
    shouldRejectAuthMutationOrigin({
      rawOrigin: input.request.headers.origin,
      requestOrigin: input.requestUrl.origin,
      config: input.config,
      credentialSource: input.session.credentialSource,
    })
  ) {
    throw new CompanionHttpError("Forbidden", "Untrusted request origin.", 403);
  }
}

const requireCompanionRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const config = yield* ServerConfig;
  if (!config.companionEnabled) {
    return yield* Effect.fail(
      new CompanionHttpError("NotFound", "Companion access is disabled.", 404),
    );
  }
  const requestUrl = HttpServerRequest.toURL(request);
  if (!requestUrl) {
    return yield* Effect.fail(
      new CompanionHttpError("ValidationFailed", "Invalid request URL.", 400),
    );
  }
  const serverAuth = yield* ServerAuth;
  const session = yield* serverAuth
    .authenticateHttpRequest(makeEffectAuthRequest(request))
    .pipe(
      Effect.mapError(
        () => new CompanionHttpError("Unauthenticated", "Authentication required.", 401),
      ),
    );
  if (session.accessProfile !== "companion" && session.role !== "owner") {
    return yield* Effect.fail(
      new CompanionHttpError("Forbidden", "Companion access is not enabled for this session.", 403),
    );
  }
  yield* Effect.try({
    try: () =>
      validateBrowserOrigin({ request, session, config, requestUrl }),
    catch: (cause) =>
      cause instanceof CompanionHttpError
        ? cause
        : new CompanionHttpError("Forbidden", "Untrusted request origin.", 403),
  });
  return { request, config, requestUrl, session };
});

function readUpload(
  request: HttpServerRequest.HttpServerRequest,
  temporaryDirectory: string,
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
) {
  const temporaryPaths: Array<string> = [];
  const stream = request.multipartStream.pipe(
    Stream.provideServices(
      Multipart.limitsServices({
        maxParts: 8,
        maxFieldSize: 8 * 1024,
        maxFileSize: COMPANION_MAX_FILE_BYTES,
        maxTotalSize: COMPANION_MAX_FILE_BYTES + 64 * 1024,
      }),
    ),
  );
  return Effect.gen(function* () {
    yield* fileSystem.makeDirectory(temporaryDirectory, { recursive: true });
    return yield* Stream.runFoldEffect(
      stream,
      (): UploadState => ({ fields: {}, file: undefined }),
      (state, part) => {
        if (Multipart.isField(part)) {
          if (!(part.key === "threadId" || part.key === "filename" || part.key === "mediaType")) {
            return Effect.fail(
              new CompanionHttpError("ValidationFailed", "Unsupported upload field.", 400),
            );
          }
          if (part.value.length > 1_024) {
            return Effect.fail(
              new CompanionHttpError("ValidationFailed", "Upload field is too long.", 400),
            );
          }
          if (state.file) {
            return Effect.fail(
              new CompanionHttpError(
                "ValidationFailed",
                "Upload metadata must precede the attachment body.",
                400,
              ),
            );
          }
          return Effect.succeed({
            ...state,
            fields: { ...state.fields, [part.key]: part.value },
          });
        }
        if (state.file) {
          return Effect.fail(
            new CompanionHttpError("ValidationFailed", "Only one attachment is allowed.", 400),
          );
        }
        const temporaryPath = path.join(temporaryDirectory, `${Crypto.randomUUID()}.part`);
        temporaryPaths.push(temporaryPath);
        const multipartMediaType = part.contentType.trim().toLowerCase();
        const declaredMediaType = (state.fields.mediaType || multipartMediaType)
          .trim()
          .toLowerCase();
        if (state.fields.mediaType && declaredMediaType !== multipartMediaType) {
          return Effect.fail(
            new CompanionHttpError(
              "ValidationFailed",
              "The declared media type must match the multipart content type.",
              400,
            ),
          );
        }
        let sizeBytes = 0;
        let signature = new Uint8Array();
        const sha256 = Crypto.createHash("sha256");
        const content = part.content.pipe(
          Stream.tap((chunk) => {
            sizeBytes += chunk.byteLength;
            sha256.update(chunk);
            if (signature.byteLength < 16) {
              const remaining = 16 - signature.byteLength;
              signature = Uint8Array.from([
                ...signature,
                ...chunk.subarray(0, Math.min(remaining, chunk.byteLength)),
              ]);
            }
            const maxBytes = isImageMediaType(declaredMediaType)
              ? COMPANION_MAX_IMAGE_BYTES
              : COMPANION_MAX_FILE_BYTES;
            return sizeBytes > maxBytes
              ? Effect.fail(
                  new CompanionHttpError("PayloadTooLarge", "Attachment is too large.", 413),
                )
              : Effect.void;
          }),
        );
        return Stream.run(content, fileSystem.sink(temporaryPath)).pipe(
          Effect.flatMap(() =>
            sizeBytes > 0
              ? Effect.succeed({
                  ...state,
                  file: {
                    temporaryPath,
                    filename: part.name,
                    mediaType: declaredMediaType,
                    sizeBytes,
                    signature,
                    sha256: sha256.digest("hex"),
                  },
                })
              : Effect.fail(
                  new CompanionHttpError("ValidationFailed", "Attachment is empty.", 400),
                ),
          ),
        );
      },
    );
  }).pipe(
    Effect.tapError(() =>
      Effect.forEach(
        temporaryPaths,
        (temporaryPath) => fileSystem.remove(temporaryPath, { force: true }).pipe(Effect.ignore),
        { discard: true },
      ),
    ),
  );
}

const uploadRoute = HttpRouter.add(
  "POST",
  "/api/companion/v1/attachments",
  companionHttpErrorBoundary(Effect.gen(function* () {
    const { request, config, session } = yield* requireCompanionRequest;
    const projections = yield* ProjectionSnapshotQuery;
    const attachments = yield* CompanionAttachmentStore;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const contentLength = Number.parseInt(request.headers["content-length"] ?? "0", 10);
    if (Number.isFinite(contentLength) && contentLength > COMPANION_MAX_FILE_BYTES + 64 * 1024) {
      return yield* Effect.fail(
        new CompanionHttpError("PayloadTooLarge", "Attachment is too large.", 413),
      );
    }
    return yield* Effect.acquireUseRelease(
      attachments.acquireUploadReservation(session.sessionId).pipe(
        Effect.mapError((cause) =>
          cause.reason === "quota"
            ? new CompanionHttpError(
                "RateLimited",
                "Outstanding attachment quota exceeded.",
                429,
              )
            : cause.reason === "inactive-session"
              ? new CompanionHttpError("SessionExpired", "The session has expired.", 401)
              : internalError("Failed to reserve attachment capacity.", cause),
        ),
      ),
      () =>
        Effect.gen(function* () {
          const state = yield* readUpload(
            request,
            path.join(config.attachmentsDir, ".companion-uploads"),
            fileSystem,
            path,
          ).pipe(
            Effect.mapError((cause) =>
              cause instanceof CompanionHttpError
                ? cause
                : isMultipartSizeError(cause)
                  ? new CompanionHttpError("PayloadTooLarge", "Attachment is too large.", 413)
                  : new CompanionHttpError("ValidationFailed", "Invalid multipart upload.", 400, {
                      cause,
                    }),
            ),
          );
          const cleanupTemporaryFile = state.file
            ? fileSystem.remove(state.file.temporaryPath, { force: true }).pipe(Effect.ignore)
            : Effect.void;
          return yield* Effect.gen(function* () {
            const threadId = yield* decodeThreadId(state.fields.threadId).pipe(
              Effect.mapError(
                () =>
                  new CompanionHttpError(
                    "ValidationFailed",
                    "A valid threadId is required.",
                    400,
                  ),
              ),
            );
            const thread = yield* projections.getThreadShellById(threadId).pipe(
              Effect.mapError((cause) =>
                internalError("Failed to verify attachment thread.", cause),
              ),
            );
            if (thread._tag === "None") {
              return yield* Effect.fail(
                new CompanionHttpError("NotFound", "Thread not found.", 404),
              );
            }
            if (!state.file) {
              return yield* Effect.fail(
                new CompanionHttpError("ValidationFailed", "An attachment file is required.", 400),
              );
            }
            const mediaType = state.file.mediaType;
            const kind = isImageMediaType(mediaType) ? "image" : "file";
            if (kind === "image" && !matchesImageSignature(mediaType, state.file.signature)) {
              return yield* Effect.fail(
                new CompanionHttpError(
                  "ValidationFailed",
                  "The image contents do not match its declared media type.",
                  400,
                ),
              );
            }
            const persisted = yield* attachments
              .registerPersisted({
                sessionId: session.sessionId,
                threadId,
                filename: state.fields.filename || state.file.filename,
                mediaType,
                kind,
                sizeBytes: state.file.sizeBytes,
                sha256: state.file.sha256,
                temporaryPath: state.file.temporaryPath,
              })
              .pipe(
                Effect.mapError((cause) =>
                  cause.reason === "inactive-session"
                    ? new CompanionHttpError("SessionExpired", "The session has expired.", 401)
                    : internalError("Failed to persist attachment.", cause),
                ),
              );
            return HttpServerResponse.jsonUnsafe(
              {
                id: persisted.uploadId,
                threadId,
                attachment: persisted.attachment,
                expiresAt: persisted.expiresAt,
              },
              { status: 201, headers: NO_STORE_HEADERS },
            );
          }).pipe(Effect.ensuring(cleanupTemporaryFile));
        }),
      (reservation) => reservation.release,
    );
  })),
);

const deleteUploadRoute = HttpRouter.add(
  "DELETE",
  "/api/companion/v1/attachments/:id",
  companionHttpErrorBoundary(Effect.gen(function* () {
    const { session } = yield* requireCompanionRequest;
    const params = yield* HttpRouter.params;
    const uploadId = yield* Schema.decodeUnknownEffect(CompanionUploadId)(params.id).pipe(
      Effect.mapError(
        () => new CompanionHttpError("ValidationFailed", "Invalid attachment id.", 400),
      ),
    );
    const attachments = yield* CompanionAttachmentStore;
    const deleted = yield* attachments.delete({ sessionId: session.sessionId, uploadId }).pipe(
      Effect.mapError((cause) => internalError("Failed to cancel attachment.", cause)),
    );
    return HttpServerResponse.jsonUnsafe({ deleted }, { headers: NO_STORE_HEADERS });
  })),
);

const updateDeviceLabelRoute = HttpRouter.add(
  "PATCH",
  "/api/companion/v1/session/device-label",
  companionHttpErrorBoundary(Effect.gen(function* () {
    const { request, session } = yield* requireCompanionRequest;
    const body = yield* request.json.pipe(
      Effect.flatMap(decodeUpdateDeviceLabelInput),
      Effect.mapError(
        (cause) =>
          new CompanionHttpError("ValidationFailed", "Invalid device label.", 400, { cause }),
      ),
    );
    const sessions = yield* SessionCredentialService;
    const updated = yield* sessions
      .updateClientLabel(session.sessionId, body.deviceLabel)
      .pipe(
        Effect.mapError((cause) =>
          cause.message === "Session is no longer active."
            ? new CompanionHttpError("SessionExpired", "The session has expired.", 401)
            : internalError("Failed to update the device label.", cause),
        ),
      );
    return HttpServerResponse.jsonUnsafe(
      { deviceLabel: updated.client.label ?? body.deviceLabel },
      { headers: NO_STORE_HEADERS },
    );
  })),
);

const pushConfigRoute = HttpRouter.add(
  "GET",
  "/api/companion/v1/push/config",
  companionHttpErrorBoundary(Effect.gen(function* () {
    yield* requireCompanionRequest;
    const push = yield* CompanionPushService;
    return HttpServerResponse.jsonUnsafe(
      { supported: true, vapidPublicKey: push.vapidPublicKey },
      { headers: NO_STORE_HEADERS },
    );
  })),
);

const registerPushRoute = HttpRouter.add(
  "POST",
  "/api/companion/v1/push-subscriptions",
  companionHttpErrorBoundary(Effect.gen(function* () {
    const { request, session } = yield* requireCompanionRequest;
    const body = yield* request.json.pipe(
      Effect.flatMap(decodePushInput),
      Effect.mapError(
        (cause) =>
          new CompanionHttpError("ValidationFailed", "Invalid push subscription.", 400, {
            cause,
          }),
      ),
    );
    const push = yield* CompanionPushService;
    const subscription = yield* push.register({ sessionId: session.sessionId, value: body }).pipe(
      Effect.mapError((cause) => internalError("Failed to save push subscription.", cause)),
    );
    return HttpServerResponse.jsonUnsafe({ subscription }, { status: 201, headers: NO_STORE_HEADERS });
  })),
);

const deletePushRoute = HttpRouter.add(
  "DELETE",
  "/api/companion/v1/push-subscriptions/:id",
  companionHttpErrorBoundary(Effect.gen(function* () {
    const { session } = yield* requireCompanionRequest;
    const params = yield* HttpRouter.params;
    if (!params.id || params.id.length > 128) {
      return yield* Effect.fail(
        new CompanionHttpError("ValidationFailed", "Invalid subscription id.", 400),
      );
    }
    const push = yield* CompanionPushService;
    const deleted = yield* push.remove({ sessionId: session.sessionId, subscriptionId: params.id }).pipe(
      Effect.mapError((cause) => internalError("Failed to remove push subscription.", cause)),
    );
    return HttpServerResponse.jsonUnsafe({ deleted }, { headers: NO_STORE_HEADERS });
  })),
);

const testPushRoute = HttpRouter.add(
  "POST",
  "/api/companion/v1/push/test",
  companionHttpErrorBoundary(Effect.gen(function* () {
    const { session } = yield* requireCompanionRequest;
    const push = yield* CompanionPushService;
    const accepted = yield* push.sendTest(session.sessionId).pipe(
      Effect.mapError((cause) => internalError("Failed to queue test notification.", cause)),
    );
    return HttpServerResponse.jsonUnsafe({ accepted }, { status: accepted ? 202 : 409, headers: NO_STORE_HEADERS });
  })),
);

const infoRoute = HttpRouter.add(
  "GET",
  "/api/companion/v1/info",
  companionHttpErrorBoundary(Effect.gen(function* () {
    const config = yield* ServerConfig;
    return HttpServerResponse.jsonUnsafe(
      {
        enabled: config.companionEnabled === true,
        protocolVersion: 1,
        serverVersion,
      },
      { headers: NO_STORE_HEADERS },
    );
  })),
);

const companionHttpRoutes = Layer.mergeAll(
  infoRoute,
  updateDeviceLabelRoute,
  uploadRoute,
  deleteUploadRoute,
  pushConfigRoute,
  registerPushRoute,
  deletePushRoute,
  testPushRoute,
);

export const companionHttpRouteLayer = companionHttpRoutes;
