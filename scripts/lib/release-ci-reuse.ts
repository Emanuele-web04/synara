export const REQUIRED_RELEASE_CI_JOBS = [
  "Detect code changes",
  "Static Checks (fast)",
  "Static Checks (typecheck)",
  "Unit Tests (core)",
  "Unit Tests (web)",
  "Unit Tests (server 1/3)",
  "Unit Tests (server 2/3)",
  "Unit Tests (server 3/3)",
  "Browser Tests (chat-follow 1/1)",
  "Browser Tests (chat-projects 1/1)",
  "Browser Tests (chat-workflows 1/1)",
  "Browser Tests (components 1/3)",
  "Browser Tests (components 2/3)",
  "Browser Tests (components 3/3)",
  "Desktop Build",
  "Windows Process Regression",
  "Migration Lineage",
  "Format, Lint, Typecheck, Test, Browser Test, Build",
] as const;

// Only reuse the latest run for the exact release source, never a green parent.
export function findReleaseCiRun(payload: unknown, sourceCommit: string) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) return null;
  if (!payload || typeof payload !== "object" || !("workflow_runs" in payload)) return null;
  const runs = payload.workflow_runs;
  if (!Array.isArray(runs) || !("total_count" in payload) || payload.total_count !== runs.length)
    return null;
  const candidates = runs.filter(
    (run): run is Record<string, unknown> =>
      run !== null &&
      typeof run === "object" &&
      run.head_sha === sourceCommit &&
      run.head_branch === "main" &&
      run.event === "push" &&
      run.path === ".github/workflows/ci.yml" &&
      typeof run.id === "number" &&
      Number.isSafeInteger(run.id) &&
      run.id > 0,
  );
  if (candidates.length !== runs.length) return null;
  candidates.sort((left, right) => Number(right.id) - Number(left.id));
  const latest = candidates[0];
  if (
    !latest ||
    latest.status !== "completed" ||
    latest.conclusion !== "success" ||
    typeof latest.run_attempt !== "number" ||
    !Number.isSafeInteger(latest.run_attempt) ||
    latest.run_attempt < 1 ||
    candidates[1]?.id === latest.id
  )
    return null;
  return { id: Number(latest.id), attempt: latest.run_attempt };
}

export function hasVerifiedReleaseCi(
  payload: unknown,
  sourceCommit: string,
  jobsPayload: unknown,
): boolean {
  const run = findReleaseCiRun(payload, sourceCommit);
  if (!run || !jobsPayload || typeof jobsPayload !== "object" || !("jobs" in jobsPayload))
    return false;
  const jobs = jobsPayload.jobs;
  if (
    !Array.isArray(jobs) ||
    !("total_count" in jobsPayload) ||
    jobsPayload.total_count !== jobs.length
  )
    return false;
  const ids = new Set<number>();
  const byName = new Map<string, Record<string, unknown>>();
  for (const job of jobs) {
    if (
      !job ||
      typeof job !== "object" ||
      typeof job.id !== "number" ||
      !Number.isSafeInteger(job.id) ||
      job.id < 1 ||
      ids.has(job.id) ||
      typeof job.name !== "string" ||
      byName.has(job.name) ||
      job.run_id !== run.id ||
      job.run_attempt !== run.attempt ||
      job.head_sha !== sourceCommit
    )
      return false;
    ids.add(job.id);
    byName.set(job.name, job);
  }
  return REQUIRED_RELEASE_CI_JOBS.every((name) => {
    const job = byName.get(name);
    return job?.status === "completed" && job.conclusion === "success";
  });
}
