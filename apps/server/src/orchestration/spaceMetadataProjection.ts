import type { OrchestrationEvent } from "@synara/contracts";
import { Effect, Option } from "effect";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import type { ProjectionSpaceRepositoryShape } from "../persistence/Services/ProjectionSpaces.ts";

export type SpaceMetadataOrchestrationEvent = Extract<
  OrchestrationEvent,
  {
    type: "space.created" | "space.meta-updated" | "space.order-updated" | "space.deleted";
  }
>;

export const applySpaceMetadataProjection = (input: {
  readonly event: SpaceMetadataOrchestrationEvent;
  readonly projectionSpaceRepository: ProjectionSpaceRepositoryShape;
}): Effect.Effect<void, ProjectionRepositoryError> =>
  Effect.gen(function* () {
    switch (input.event.type) {
      case "space.created":
        yield* input.projectionSpaceRepository.upsert({
          spaceId: input.event.payload.spaceId,
          name: input.event.payload.name,
          icon: input.event.payload.icon,
          sortOrder: input.event.payload.sortOrder,
          createdAt: input.event.payload.createdAt,
          updatedAt: input.event.payload.updatedAt,
          deletedAt: null,
        });
        return;

      case "space.meta-updated": {
        const existing = yield* input.projectionSpaceRepository.getById({
          spaceId: input.event.payload.spaceId,
        });
        if (Option.isSome(existing)) {
          yield* input.projectionSpaceRepository.upsert({
            ...existing.value,
            ...(input.event.payload.name !== undefined ? { name: input.event.payload.name } : {}),
            ...(input.event.payload.icon !== undefined ? { icon: input.event.payload.icon } : {}),
            updatedAt: input.event.payload.updatedAt,
          });
        }
        return;
      }

      case "space.order-updated": {
        const updatedAt = input.event.payload.updatedAt;
        const rows = yield* input.projectionSpaceRepository.listAll();
        const orderBySpaceId = new Map(
          input.event.payload.orderedSpaceIds.map((spaceId, index) => [spaceId, index] as const),
        );
        yield* Effect.forEach(
          rows,
          (row) => {
            const sortOrder = orderBySpaceId.get(row.spaceId);
            // Unmoved rows are skipped so a reorder writes only the rows that changed and
            // stays in lockstep with the in-memory read model's identity-preserving update.
            return sortOrder === undefined || sortOrder === row.sortOrder
              ? Effect.void
              : input.projectionSpaceRepository.upsert({
                  ...row,
                  sortOrder,
                  updatedAt,
                });
          },
          { concurrency: 1 },
        );
        return;
      }

      case "space.deleted": {
        const existing = yield* input.projectionSpaceRepository.getById({
          spaceId: input.event.payload.spaceId,
        });
        if (Option.isSome(existing)) {
          yield* input.projectionSpaceRepository.upsert({
            ...existing.value,
            updatedAt: input.event.payload.deletedAt,
            deletedAt: input.event.payload.deletedAt,
          });
        }
      }
    }
  });
