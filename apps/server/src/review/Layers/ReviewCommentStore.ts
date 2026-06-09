import { createHash, randomUUID } from "node:crypto";

import {
  ReviewCommentList,
  type ReviewLocalComment,
  type ReviewRemoveCommentResult,
  type ReviewTargetKey,
} from "@t3tools/contracts";
import { Clock, Effect, FileSystem, Layer, Path, Ref, Schema } from "effect";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { ServerConfig } from "../../config.ts";
import { ReviewError } from "../Errors.ts";
import {
  ReviewCommentStore,
  type ReviewCommentStoreShape,
} from "../Services/ReviewCommentStore.ts";

function targetFileName(target: ReviewTargetKey): string {
  if (target._tag === "pullRequest") {
    return `pr-${target.number}`;
  }
  const hash = createHash("sha256")
    .update(`${target.base}...${target.head}`)
    .digest("hex")
    .slice(0, 16);
  return `range-${hash}`;
}

const decodeCommentList = Schema.decodeUnknownEffect(ReviewCommentList);

const makeReviewCommentStore = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const locks = yield* Ref.make(new Map<string, Semaphore.Semaphore>());

  const reviewsDir = path.join(stateDir, "reviews");

  const filePathFor = (target: ReviewTargetKey) =>
    path.join(reviewsDir, target.repositoryId, `${targetFileName(target)}.json`);

  const nowIso = Clock.currentTimeMillis.pipe(
    Effect.map((millis) => new Date(millis).toISOString()),
  );

  const lockFor = (filePath: string) =>
    Ref.get(locks).pipe(
      Effect.flatMap((map) => {
        const existing = map.get(filePath);
        if (existing) {
          return Effect.succeed(existing);
        }
        return Semaphore.make(1).pipe(
          Effect.tap((created) =>
            Ref.update(locks, (current) => new Map(current).set(filePath, created)),
          ),
        );
      }),
    );

  const readComments = (filePath: string): Effect.Effect<ReadonlyArray<ReviewLocalComment>> =>
    Effect.gen(function* () {
      const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
      if (!exists) {
        return [];
      }
      const raw = yield* fs.readFileString(filePath).pipe(Effect.option);
      if (raw._tag === "None") {
        yield* Effect.logWarning(
          `ReviewCommentStore: failed to read ${filePath}, treating as empty`,
        );
        return [];
      }
      const decoded = yield* decodeCommentList(safeParse(raw.value)).pipe(Effect.option);
      if (decoded._tag === "None") {
        yield* Effect.logWarning(
          `ReviewCommentStore: corrupt or invalid comments file ${filePath}, treating as empty`,
        );
        return [];
      }
      return decoded.value.comments;
    });

  const writeComments = (
    target: ReviewTargetKey,
    filePath: string,
    comments: ReadonlyArray<ReviewLocalComment>,
  ) => {
    const payload: ReviewCommentList = { target, comments };
    return writeFileStringAtomically({
      filePath,
      contents: `${JSON.stringify(payload, null, 2)}\n`,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) =>
          new ReviewError({
            operation: "ReviewCommentStore.write",
            detail: `failed to persist comments to ${filePath}`,
            cause,
          }),
      ),
    );
  };

  const withLock = <A, E>(filePath: string, effect: Effect.Effect<A, E>) =>
    lockFor(filePath).pipe(Effect.flatMap((lock) => lock.withPermits(1)(effect)));

  const list: ReviewCommentStoreShape["list"] = (input) =>
    readComments(filePathFor(input.target)).pipe(
      Effect.map((comments) => ({ target: input.target, comments })),
    );

  const add: ReviewCommentStoreShape["add"] = (input) => {
    const filePath = filePathFor(input.target);
    return withLock(
      filePath,
      Effect.gen(function* () {
        const timestamp = yield* nowIso;
        const comment: ReviewLocalComment = {
          id: randomUUID(),
          threadId: input.threadId ?? randomUUID(),
          path: input.path,
          line: input.line,
          side: input.side,
          body: input.body,
          resolved: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        const existing = yield* readComments(filePath);
        yield* writeComments(input.target, filePath, [...existing, comment]);
        return comment;
      }),
    );
  };

  const update: ReviewCommentStoreShape["update"] = (input) => {
    const filePath = filePathFor(input.target);
    return withLock(
      filePath,
      Effect.gen(function* () {
        const timestamp = yield* nowIso;
        const existing = yield* readComments(filePath);
        const target = existing.find((comment) => comment.id === input.id);
        if (!target) {
          return yield* Effect.fail(
            new ReviewError({
              operation: "ReviewCommentStore.update",
              detail: `No comment ${input.id}`,
            }),
          );
        }
        const next: ReviewLocalComment = {
          ...target,
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.resolved !== undefined ? { resolved: input.resolved } : {}),
          updatedAt: timestamp,
        };
        yield* writeComments(
          input.target,
          filePath,
          existing.map((comment) => (comment.id === input.id ? next : comment)),
        );
        return next;
      }),
    );
  };

  const remove: ReviewCommentStoreShape["remove"] = (input) => {
    const filePath = filePathFor(input.target);
    return withLock(
      filePath,
      Effect.gen(function* () {
        const existing = yield* readComments(filePath);
        if (!existing.some((comment) => comment.id === input.id)) {
          return { removed: false } satisfies ReviewRemoveCommentResult;
        }
        yield* writeComments(
          input.target,
          filePath,
          existing.filter((comment) => comment.id !== input.id),
        );
        return { removed: true };
      }),
    );
  };

  return {
    list,
    add,
    update,
    remove,
  } satisfies ReviewCommentStoreShape;
});

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export const ReviewCommentStoreLive = Layer.effect(ReviewCommentStore, makeReviewCommentStore);
