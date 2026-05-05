import { Effect, Layer } from "effect";

import {
  browseWorkspaceEntries,
  clearWorkspaceIndexCache,
  listWorkspaceDirectories,
  searchLocalEntries,
  searchWorkspaceEntries,
} from "../../workspaceEntries";
import { toWorkspaceEntriesError, WorkspaceEntries } from "../Services/WorkspaceEntries";

export const WorkspaceEntriesLive = Layer.succeed(WorkspaceEntries, {
  browse: (input) =>
    Effect.tryPromise({
      try: () => browseWorkspaceEntries(input),
      catch: (cause) => toWorkspaceEntriesError("browse filesystem", cause),
    }),
  search: (input) =>
    Effect.tryPromise({
      try: () => searchWorkspaceEntries(input),
      catch: (cause) => toWorkspaceEntriesError("search workspace entries", cause),
    }),
  listDirectories: (input) =>
    Effect.tryPromise({
      try: () => listWorkspaceDirectories(input),
      catch: (cause) => toWorkspaceEntriesError("list workspace directories", cause),
    }),
  searchLocal: (input) =>
    Effect.tryPromise({
      try: () => searchLocalEntries(input),
      catch: (cause) => toWorkspaceEntriesError("search local entries", cause),
    }),
  invalidate: (cwd) => Effect.sync(() => clearWorkspaceIndexCache(cwd)),
});
