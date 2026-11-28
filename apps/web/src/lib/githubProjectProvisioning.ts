import type {
  GitHubProjectProvisionInput,
  OrchestrationShellSnapshot,
  ProjectId,
  SpaceId,
} from "@synara/contracts";
import { getDefaultModel } from "@synara/shared/model";
import { newCommandId, newProjectId } from "./utils";
import { waitForRecoverableProjectInReadModel } from "./projectCreateRecovery";

/** Local and connected computers register the same server-owned operation. */
export function buildGitHubProjectProvisionRequest(
  source: Pick<
    GitHubProjectProvisionInput,
    "operationId" | "repository" | "destinationParent" | "directoryName"
  >,
  spaceId: SpaceId | null,
): GitHubProjectProvisionInput {
  return {
    ...source,
    commandId: newCommandId(),
    projectId: newProjectId(),
    newProjectSpaceId: spaceId,
    defaultModelSelection: { provider: "codex", model: getDefaultModel("codex") },
    createdAt: new Date().toISOString(),
  };
}

/** An occupied destination is not evidence that this operation committed. */
export async function recoverGitHubProjectRegistration(
  projectId: ProjectId,
  loadSnapshot: () => Promise<OrchestrationShellSnapshot | null>,
) {
  const deadline = Date.now() + 5_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      waitForRecoverableProjectInReadModel({
        projectId,
        loadSnapshot: () => (Date.now() < deadline ? loadSnapshot() : Promise.resolve(null)),
        maxAttempts: 8,
        delayMs: 150,
      }),
      new Promise<{ project: null; snapshot: null }>((resolve) => {
        timer = setTimeout(() => resolve({ project: null, snapshot: null }), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runProjectProvisionWithCancellationRecovery<T>(input: {
  readonly signal: AbortSignal;
  readonly provision: () => Promise<T>;
  readonly recoverCommittedProject: () => Promise<boolean>;
}): Promise<
  { readonly status: "completed"; readonly result: T } | { readonly status: "recovered" }
> {
  try {
    return { status: "completed", result: await input.provision() };
  } catch (error) {
    if (!input.signal.aborted || !(await input.recoverCommittedProject())) throw error;
    return { status: "recovered" };
  }
}
