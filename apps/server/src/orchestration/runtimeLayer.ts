import { Layer } from "effect";

import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore";
import { ManagedAttachmentRepositoryLive } from "../persistence/Layers/ManagedAttachments";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery";

export const OrchestrationEventInfrastructureLayerLive = Layer.mergeAll(
  OrchestrationEventStoreLive,
  OrchestrationCommandReceiptRepositoryLive,
  ManagedAttachmentRepositoryLive,
);

export const OrchestrationProjectionPipelineLayerLive = OrchestrationProjectionPipelineLive.pipe(
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(ManagedAttachmentRepositoryLive),
);

export const OrchestrationInfrastructureLayerLive = Layer.mergeAll(
  OrchestrationProjectionSnapshotQueryLive,
  OrchestrationEventInfrastructureLayerLive,
  OrchestrationProjectionPipelineLayerLive,
);

export const OrchestrationLayerLive = Layer.mergeAll(
  OrchestrationInfrastructureLayerLive,
  OrchestrationEngineLive.pipe(Layer.provide(OrchestrationInfrastructureLayerLive)),
);
