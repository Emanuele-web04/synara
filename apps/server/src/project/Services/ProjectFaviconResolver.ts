import { Effect, ServiceMap } from "effect";

export interface ProjectFaviconResolverShape {
  /**
   * Discover a local image inside an authoritative saved project's absolute workspace root.
   * Returns the lexical candidate (including confined symlinks), not a grant to read it:
   * callers must recheck containment and type before serving the current bytes.
   */
  readonly resolvePath: (workspaceRoot: string) => Effect.Effect<string | null>;
}

export class ProjectFaviconResolver extends ServiceMap.Service<
  ProjectFaviconResolver,
  ProjectFaviconResolverShape
>()("synara/project/Services/ProjectFaviconResolver") {}
