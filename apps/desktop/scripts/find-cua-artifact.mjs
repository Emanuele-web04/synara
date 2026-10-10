// Only the dedicated successful default-branch producer may supply cross-run
// binaries. Exact build-key and executable verification still happen on import.
export async function findCuaArtifact(github, repo, key) {
  if (!/^cua-v1-[a-f0-9]{64}$/.test(key)) throw new Error("Invalid Cua build key.");
  const { data: repository } = await github.rest.repos.get(repo);
  const { data: workflow } = await github.rest.actions.getWorkflow({
    ...repo,
    workflow_id: "cua-release-cache.yml",
  });
  // Bound lookup cost even if unrelated workflows upload colliding names. A
  // miss compiles pinned source; it never relaxes trust or fingerprint checks.
  for (let page = 1; page <= 3; page++) {
    const { data } = await github.rest.actions.listArtifactsForRepo({
      ...repo,
      name: key,
      per_page: 100,
      page,
    });
    for (const artifact of data.artifacts) {
      const origin = artifact.workflow_run;
      if (
        artifact.name !== key ||
        artifact.expired !== false ||
        !(Date.parse(artifact.expires_at) > Date.now()) ||
        !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? "") ||
        origin?.repository_id !== repository.id ||
        origin?.head_repository_id !== repository.id ||
        origin?.head_branch !== repository.default_branch
      )
        continue;
      const { data: run } = await github.rest.actions.getWorkflowRun({
        ...repo,
        run_id: origin.id,
      });
      if (
        run.workflow_id === workflow.id &&
        run.path === ".github/workflows/cua-release-cache.yml" &&
        run.repository?.id === repository.id &&
        run.head_repository?.id === repository.id &&
        run.head_branch === repository.default_branch &&
        run.head_sha === origin.head_sha &&
        run.status === "completed" &&
        run.conclusion === "success" &&
        ["push", "schedule", "workflow_dispatch"].includes(run.event)
      )
        return { artifactId: artifact.id, runId: run.id };
    }
    if (data.artifacts.length < 100) break;
  }
  return undefined;
}
