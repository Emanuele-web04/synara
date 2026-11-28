import type {
  GitHubProjectProvisionInput,
  GitHubProjectProvisionProgressEvent,
  NativeApi,
  OrchestrationShellSnapshot,
  ProjectId,
} from "@synara/contracts";
import { t } from "~/i18n";
import {
  buildGitHubProjectProvisionRequest,
  recoverGitHubProjectRegistration,
  runProjectProvisionWithCancellationRecovery,
} from "../githubProjectProvisioning";
import { waitForRecoverableProjectInReadModel } from "../projectCreateRecovery";

/** Runs only inside the execution host's frame; never forwards credentials or an RPC client. */
export async function provisionGitHubProjectOnHost({
  api,
  input,
  signal,
  onProgress,
  available,
  syncSnapshot,
  openProject,
}: {
  api: {
    projects: Pick<NativeApi["projects"], "provisionFromGitHub" | "onProvisionProgress">;
    orchestration: Pick<NativeApi["orchestration"], "getShellSnapshot">;
  };
  input: Pick<
    GitHubProjectProvisionInput,
    "operationId" | "repository" | "destinationParent" | "directoryName"
  >;
  signal: AbortSignal;
  onProgress: (event: GitHubProjectProvisionProgressEvent) => void;
  available: () => boolean;
  syncSnapshot: (snapshot: OrchestrationShellSnapshot) => void;
  openProject: (projectId: ProjectId, signal: AbortSignal) => Promise<string>;
}) {
  if (!available()) throw new Error(t("git:cloneComputerUnavailable"));
  signal.throwIfAborted();
  const request = buildGitHubProjectProvisionRequest(input, null);
  const projectId = request.projectId;
  const loadSnapshot = () =>
    available() ? api.orchestration.getShellSnapshot().catch(() => null) : Promise.resolve(null);
  let recovered: {
    project: OrchestrationShellSnapshot["projects"][number] | null;
    snapshot: OrchestrationShellSnapshot | null;
  } | null = null;
  const unsubscribe = api.projects.onProvisionProgress((event) => {
    if (available() && event.operationId === input.operationId) onProgress(event);
  });
  try {
    const provision = await runProjectProvisionWithCancellationRecovery({
      signal,
      provision: () => api.projects.provisionFromGitHub(request, { signal }),
      recoverCommittedProject: async () => {
        recovered = await recoverGitHubProjectRegistration(projectId, loadSnapshot);
        return Boolean(recovered.project);
      },
    });
    if (!available()) throw new Error(t("git:cloneConnectionChanged"));
    const result =
      recovered ??
      (await waitForRecoverableProjectInReadModel({
        projectId: provision.status === "completed" ? provision.result.projectId : projectId,
        loadSnapshot,
      }));
    if (!available()) throw new Error(t("git:cloneConnectionChanged"));
    if (!result.project || !result.snapshot) throw new Error(t("git:cloneProjectStillSyncing"));
    // Recovery preserves the durable project, not the cancelled UI operation.
    syncSnapshot(result.snapshot);
    signal.throwIfAborted();
    const path = await openProject(result.project.id, signal);
    if (!available()) throw new Error(t("git:cloneConnectionChanged"));
    signal.throwIfAborted();
    return { projectId: result.project.id, path, created: result.project.id === projectId };
  } finally {
    unsubscribe();
  }
}
