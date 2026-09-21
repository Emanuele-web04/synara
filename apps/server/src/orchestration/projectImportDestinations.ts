import type { OrchestrationReadModel, ThreadId } from "@synara/contracts";
import type { ProjectImportOrigin } from "../persistence/projectImportRepository";

/** Use the same destination liveness rules for preview, deduplication, and retries. */
export function makeProjectImportDestinations(
  model: Pick<OrchestrationReadModel, "projects" | "threads">,
) {
  const projects = new Set(
    model.projects.filter((project) => project.deletedAt === null).map((project) => project.id),
  );
  const threads = new Map(model.threads.map((thread) => [thread.id, thread]));

  const findThread = (threadId: ThreadId) => {
    const thread = threads.get(threadId);
    if (!thread || thread.deletedAt !== null || !projects.has(thread.projectId)) return undefined;
    return { threadId, projectId: thread.projectId };
  };

  const findOrigin = (origin: ProjectImportOrigin | undefined): ProjectImportOrigin | undefined => {
    if (!origin) return undefined;
    const destination = findThread(origin.threadId);
    if (destination) return { ...origin, ...destination };
    // A crash after reservation but before thread.create must retry the same identity.
    if (
      origin.status === "pending" &&
      !threads.has(origin.threadId) &&
      projects.has(origin.projectId)
    ) {
      return origin;
    }
    return undefined;
  };

  return { findThread, findOrigin };
}
