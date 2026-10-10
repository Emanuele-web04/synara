// Only reuse CI for the exact release source, never a merely green parent.
export function hasVerifiedReleaseCi(payload: unknown, sourceCommit: string): boolean {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) return false;
  if (!payload || typeof payload !== "object" || !("workflow_runs" in payload)) return false;
  const runs = payload.workflow_runs;
  if (!Array.isArray(runs)) return false;
  const candidates = runs.filter(
    (run): run is Record<string, unknown> =>
      run !== null &&
      typeof run === "object" &&
      run.head_sha === sourceCommit &&
      run.head_branch === "main" &&
      run.event === "push" &&
      run.path === ".github/workflows/ci.yml" &&
      typeof run.id === "number" &&
      Number.isSafeInteger(run.id),
  );
  candidates.sort((left, right) => Number(right.id) - Number(left.id));
  const latest = candidates[0];
  return latest?.status === "completed" && latest.conclusion === "success";
}
