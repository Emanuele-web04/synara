import { WorkspaceEntriesLive } from "./Layers/WorkspaceEntries";
import { WorkspaceFileSystemLive } from "./Layers/WorkspaceFileSystem";
import { WorkspacePathsLive } from "./Layers/WorkspacePaths";
import { Layer } from "effect";

export const WorkspaceLayerLive = Layer.mergeAll(
  WorkspacePathsLive,
  WorkspaceEntriesLive,
  WorkspaceFileSystemLive.pipe(
    Layer.provide(WorkspacePathsLive),
    Layer.provide(WorkspaceEntriesLive),
  ),
);
