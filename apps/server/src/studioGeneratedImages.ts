import { constants as fileSystemConstants } from "node:fs";
import { copyFile, link, mkdir, readFile, realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";

import {
  CommandId,
  EventId,
  STUDIO_OUTPUTS_ACTIVITY_KIND,
  type EventId as EventIdType,
  type ThreadId,
  type TurnId,
} from "@synara/contracts";
import { isSupportedLocalImagePath } from "@synara/shared/localPreviewFiles";
import { Effect } from "effect";

import { resolveCodexGeneratedImagesRoots } from "./codexGeneratedImages.ts";
import type { OrchestrationEngineShape } from "./orchestration/Services/OrchestrationEngine.ts";
import { studioOutputsCapturedActivityPayload } from "./studioOutputs.ts";

const STUDIO_IMAGES_RELATIVE_DIRECTORY = ["Outbox", "Images"] as const;

// generated images are single digital pictures — the cap only refuses to duplicate something clearly not one of them
export const MAX_STUDIO_GENERATED_IMAGE_BYTES = 64 * 1024 * 1024;

export interface StudioGeneratedImageCopyResult {
  readonly relativePath: string;
  readonly fullPath: string;
}

function datePrefix(createdAt: string): string {
  const timestamp = new Date(createdAt);
  return Number.isNaN(timestamp.getTime())
    ? "undated"
    : timestamp.toISOString().slice(0, "YYYY-MM-DD".length);
}

export function studioGeneratedImageFileName(input: {
  readonly sourcePath: string;
  readonly createdAt: string;
  readonly collisionNumber: number;
}): string {
  const extension = path.extname(input.sourcePath).toLowerCase();
  const suffix = input.collisionNumber > 1 ? `-${input.collisionNumber}` : "";
  return `${datePrefix(input.createdAt)}_generated-image${suffix}${extension}`;
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/** the copy source must be a regular, reasonably-sized image whose real path lives under a trusted Codex generated-image root — anything else (crafted path, escaping symlink, directory) is rejected so provider payload data can never exfiltrate arbitrary local files into the user-visible Studio folder */
async function resolveTrustedGeneratedImageSource(
  sourcePath: string,
  trustedSourceRoots?: readonly string[],
): Promise<{ realPath: string; sizeBytes: number } | null> {
  let realSourcePath: string;
  try {
    realSourcePath = await realpath(sourcePath);
  } catch {
    return null;
  }
  const info = await stat(realSourcePath).catch(() => null);
  if (!info?.isFile() || info.size > MAX_STUDIO_GENERATED_IMAGE_BYTES) {
    return null;
  }

  const rootCandidates = trustedSourceRoots ?? resolveCodexGeneratedImagesRoots();
  const realRoots = await Promise.all(
    rootCandidates.map((root) => realpath(root).catch(() => null)),
  );
  const contained = realRoots.some((root) => root !== null && isPathInside(realSourcePath, root));
  return contained ? { realPath: realSourcePath, sizeBytes: info.size } : null;
}

async function haveIdenticalContent(
  leftPath: string,
  leftSizeBytes: number,
  rightPath: string,
): Promise<boolean> {
  const rightInfo = await stat(rightPath).catch(() => null);
  if (!rightInfo?.isFile() || rightInfo.size !== leftSizeBytes) {
    return false;
  }
  try {
    const [leftBytes, rightBytes] = await Promise.all([readFile(leftPath), readFile(rightPath)]);
    return leftBytes.equals(rightBytes);
  } catch {
    return false;
  }
}

/** atomically claims destinationPath via link(2) which fails EEXIST instead of overwriting; false on collision */
async function claimDestinationExclusively(
  temporaryPath: string,
  destinationPath: string,
): Promise<boolean> {
  try {
    await link(temporaryPath, destinationPath);
    return true;
  } catch (error) {
    if (isErrorWithCode(error, "EEXIST")) {
      return false;
    }
    throw error;
  }
}

/** never overwrites an existing deliverable; a replayed event whose bytes already exist under a candidate name reuses that file instead of minting -2/-3 duplicates; fully written to a hidden temp then atomically linked so a concurrent scan never sees a half-copied file */
export const copyGeneratedImageToStudioWorkspace = Effect.fnUntraced(function* (input: {
  readonly sourcePath: string;
  readonly workspaceRoot: string;
  readonly createdAt: string;
  /** test seam — production callers rely on the Codex generated-image roots */
  readonly trustedSourceRoots?: readonly string[];
}) {
  if (!isSupportedLocalImagePath(input.sourcePath)) {
    return null;
  }
  const source = yield* Effect.tryPromise(() =>
    resolveTrustedGeneratedImageSource(input.sourcePath, input.trustedSourceRoots),
  );
  if (!source) {
    return null;
  }

  const imagesDirectory = path.join(
    path.resolve(input.workspaceRoot),
    ...STUDIO_IMAGES_RELATIVE_DIRECTORY,
  );
  yield* Effect.tryPromise(() => mkdir(imagesDirectory, { recursive: true }));

  const temporaryPath = path.join(imagesDirectory, `.tmp-generated-image-${crypto.randomUUID()}`);
  yield* Effect.tryPromise(() =>
    copyFile(source.realPath, temporaryPath, fileSystemConstants.COPYFILE_EXCL),
  );

  const copyIntoWorkspace = Effect.tryPromise(async () => {
    // a Studio folder is human-scale — this only prevents an externally managed dir with pathological collisions from spinning forever
    for (let collisionNumber = 1; collisionNumber <= 10_000; collisionNumber += 1) {
      const fileName = studioGeneratedImageFileName({
        sourcePath: source.realPath,
        createdAt: input.createdAt,
        collisionNumber,
      });
      const fullPath = path.join(imagesDirectory, fileName);
      if (await claimDestinationExclusively(temporaryPath, fullPath)) {
        return { fileName, fullPath };
      }
      // replay idempotency — identical bytes already delivered under this name means the same image again
      if (await haveIdenticalContent(source.realPath, source.sizeBytes, fullPath)) {
        return { fileName, fullPath };
      }
    }
    throw new Error("Studio generated-image naming exhausted 10,000 collision candidates");
  });

  const destination = yield* copyIntoWorkspace.pipe(
    Effect.ensuring(Effect.promise(() => unlink(temporaryPath).catch(() => undefined))),
  );

  return {
    relativePath: [...STUDIO_IMAGES_RELATIVE_DIRECTORY, destination.fileName].join("/"),
    fullPath: destination.fullPath,
  } satisfies StudioGeneratedImageCopyResult;
});

/** copy first, then directly attribute — required even though the turn-end scan may also see the copy: runtime subscribers are independent so terminal scan ordering is no correctness guarantee; the listing deduplicates both paths */
export const copyAndAttributeStudioGeneratedImage = Effect.fnUntraced(function* (input: {
  readonly orchestrationEngine: Pick<OrchestrationEngineShape, "dispatch">;
  readonly sourcePath: string;
  readonly workspaceRoot: string;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly eventId: EventIdType;
  readonly createdAt: string;
  readonly trustedSourceRoots?: readonly string[];
}) {
  const copied = yield* copyGeneratedImageToStudioWorkspace({
    sourcePath: input.sourcePath,
    workspaceRoot: input.workspaceRoot,
    createdAt: input.createdAt,
    ...(input.trustedSourceRoots ? { trustedSourceRoots: input.trustedSourceRoots } : {}),
  });
  if (!copied) {
    return null;
  }

  yield* input.orchestrationEngine.dispatch({
    type: "thread.activity.append",
    commandId: CommandId.makeUnsafe(
      `server:studio-generated-image:${input.eventId}:${crypto.randomUUID()}`,
    ),
    threadId: input.threadId,
    activity: {
      id: EventId.makeUnsafe(crypto.randomUUID()),
      tone: "info",
      kind: STUDIO_OUTPUTS_ACTIVITY_KIND,
      summary: "Studio outputs captured",
      payload: studioOutputsCapturedActivityPayload([copied.relativePath], {
        generatedImage: {
          sourcePath: input.sourcePath,
          fullPath: copied.fullPath,
        },
      }),
      turnId: input.turnId ?? null,
      createdAt: input.createdAt,
    },
    createdAt: input.createdAt,
  });

  return copied;
});
