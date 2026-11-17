// FILE: release-job-wait.ts
// Purpose: Lets a release job start its own setup early and then wait for one
//          sibling job of the same run attempt, instead of idling behind `needs`.
// Layer: Release/build helper

export interface ReleaseJob {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
}

export type JobListing =
  | { readonly kind: "jobs"; readonly jobs: readonly ReleaseJob[] }
  | { readonly kind: "unavailable"; readonly reason: string; readonly permanent: boolean };

export interface WaitForReleaseJobOptions {
  readonly jobName: string;
  readonly listJobs: () => Promise<JobListing>;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (message: string) => void;
}

// A wrong token or a missing run does not heal; three in a row is not a blip.
const PERMANENT_FAILURE_LIMIT = 3;

/**
 * Resolves once the named job of this run attempt has completed successfully.
 *
 * It rejects when that job completes with any other conclusion, when two jobs
 * share the name, or when the deadline passes. A job that is not listed yet is
 * still pending, and a failed listing is retried until the deadline: neither
 * can ever be read as success. The listing is the run attempt's own job list,
 * which carries over jobs a partial rerun did not repeat, so a rerun waits for
 * the job that produces this attempt's artifact rather than an older one.
 */
export async function waitForReleaseJob(options: WaitForReleaseJobOptions): Promise<void> {
  const deadline = options.now() + options.timeoutMs;
  let permanentFailures = 0;
  let lastState = "";
  const report = (state: string) => {
    if (state !== lastState) options.log(`[release-job-wait] ${options.jobName}: ${state}`);
    lastState = state;
  };
  for (;;) {
    const listing = await options.listJobs();
    if (listing.kind === "unavailable") {
      permanentFailures = listing.permanent ? permanentFailures + 1 : 0;
      if (permanentFailures >= PERMANENT_FAILURE_LIMIT)
        throw new Error(`Cannot read this run's jobs: ${listing.reason}.`);
      report(`job list unavailable (${listing.reason}); retrying`);
    } else {
      permanentFailures = 0;
      const matches = listing.jobs.filter((job) => job.name === options.jobName);
      if (matches.length > 1)
        throw new Error(`${matches.length} jobs are named "${options.jobName}".`);
      const job = matches[0];
      if (!job) report("not created yet");
      else if (job.status !== "completed") report(job.status);
      else if (job.conclusion === "success") {
        report("completed successfully");
        return;
      } else {
        throw new Error(
          `"${options.jobName}" completed with ${job.conclusion ?? "no conclusion"}, not success.`,
        );
      }
    }
    if (options.now() + options.pollIntervalMs > deadline)
      throw new Error(
        `"${options.jobName}" did not complete within ${Math.round(options.timeoutMs / 60_000)} minutes.`,
      );
    await options.sleep(options.pollIntervalMs);
  }
}

interface JobsPage {
  readonly total_count?: unknown;
  readonly jobs?: unknown;
}

function parseJob(value: unknown): ReleaseJob | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { name, status, conclusion } = value as Record<string, unknown>;
  if (typeof name !== "string" || typeof status !== "string") return undefined;
  if (conclusion !== null && typeof conclusion !== "string") return undefined;
  return { name, status, conclusion };
}

/**
 * Lists every job of one run attempt through the GitHub REST API. Any response
 * that is not a complete, well-formed listing is reported as unavailable.
 */
export function githubRunAttemptJobs(config: {
  readonly apiUrl: string;
  readonly repository: string;
  readonly runId: string;
  readonly runAttempt: string;
  readonly token: string;
  readonly fetch: (
    url: string,
    init: { readonly headers: Record<string, string> },
  ) => Promise<Response>;
}): () => Promise<JobListing> {
  const base = `${config.apiUrl}/repos/${config.repository}/actions/runs/${config.runId}/attempts/${config.runAttempt}/jobs`;
  return async () => {
    const jobs: ReleaseJob[] = [];
    for (let page = 1; ; page += 1) {
      let response: Response;
      try {
        response = await config.fetch(`${base}?per_page=100&page=${page}`, {
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${config.token}`,
            "x-github-api-version": "2022-11-28",
          },
        });
      } catch (error) {
        return {
          kind: "unavailable",
          reason: `request failed: ${String(error)}`,
          permanent: false,
        };
      }
      if (!response.ok)
        return {
          kind: "unavailable",
          reason: `HTTP ${response.status}`,
          permanent: response.status === 401 || response.status === 404,
        };
      let body: JobsPage;
      try {
        body = (await response.json()) as JobsPage;
      } catch {
        return { kind: "unavailable", reason: "malformed response", permanent: false };
      }
      if (typeof body.total_count !== "number" || !Array.isArray(body.jobs))
        return { kind: "unavailable", reason: "malformed response", permanent: false };
      for (const entry of body.jobs) {
        const job = parseJob(entry);
        if (!job) return { kind: "unavailable", reason: "malformed job entry", permanent: false };
        jobs.push(job);
      }
      if (jobs.length >= body.total_count || body.jobs.length === 0) return { kind: "jobs", jobs };
    }
  };
}
