import { describe, expect, it } from "vitest";

import {
  githubRunAttemptJobs,
  waitForReleaseJob,
  type JobListing,
  type ReleaseJob,
} from "./release-job-wait.ts";

const JOB = "Build macOS x64 / Package and qualify";
const job = (status: string, conclusion: string | null = null, name = JOB): ReleaseJob => ({
  name,
  status,
  conclusion,
});
const jobs = (...list: ReleaseJob[]): JobListing => ({ kind: "jobs", jobs: list });
const unavailable = (reason: string, permanent = false): JobListing => ({
  kind: "unavailable",
  reason,
  permanent,
});

function harness(listings: readonly JobListing[], timeoutMs = 600_000) {
  let clock = 0;
  let calls = 0;
  const log: string[] = [];
  const result = waitForReleaseJob({
    jobName: JOB,
    listJobs: async () => listings[Math.min(calls++, listings.length - 1)]!,
    timeoutMs,
    pollIntervalMs: 10_000,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    log: (message) => log.push(message),
  });
  return { result, log, calls: () => calls, elapsed: () => clock };
}

describe("waitForReleaseJob", () => {
  it("waits through queued and running states until the job succeeds", async () => {
    const run = harness([
      jobs(job("in_progress", null, "Build portable JavaScript")),
      jobs(job("queued")),
      jobs(job("in_progress")),
      jobs(job("in_progress")),
      jobs(job("completed", "success")),
    ]);
    await run.result;
    expect(run.calls()).toBe(5);
    expect(run.elapsed()).toBe(40_000);
    // One line per state change, not per poll.
    expect(run.log).toEqual([
      `[release-job-wait] ${JOB}: not created yet`,
      `[release-job-wait] ${JOB}: queued`,
      `[release-job-wait] ${JOB}: in_progress`,
      `[release-job-wait] ${JOB}: completed successfully`,
    ]);
  });

  it("accepts a job a partial rerun carried over as already successful", async () => {
    const run = harness([jobs(job("completed", "success"))]);
    await run.result;
    expect(run.calls()).toBe(1);
    expect(run.elapsed()).toBe(0);
  });

  it.each(["failure", "cancelled", "skipped", "timed_out", "neutral", null])(
    "fails when the job completes with %s",
    async (conclusion) => {
      const run = harness([jobs(job("in_progress")), jobs(job("completed", conclusion))]);
      await expect(run.result).rejects.toThrow("not success");
    },
  );

  it("never treats another job's success as this job's", async () => {
    const run = harness(
      [jobs(job("completed", "success", "Build macOS arm64 / Package and qualify"))],
      30_000,
    );
    await expect(run.result).rejects.toThrow("did not complete within");
  });

  it("fails on an ambiguous job name", async () => {
    const run = harness([jobs(job("completed", "success"), job("in_progress"))]);
    await expect(run.result).rejects.toThrow("2 jobs are named");
  });

  it("fails at the deadline when the job never completes", async () => {
    const run = harness([jobs(job("in_progress"))], 60_000);
    await expect(run.result).rejects.toThrow("did not complete within 1 minutes");
    expect(run.elapsed()).toBeLessThanOrEqual(60_000);
  });

  it("retries transient listing failures and still requires success", async () => {
    const run = harness([
      unavailable("HTTP 502"),
      unavailable("request failed: Error: socket hang up"),
      jobs(job("in_progress")),
      unavailable("HTTP 503"),
      jobs(job("completed", "success")),
    ]);
    await run.result;
    expect(run.calls()).toBe(5);
  });

  it("fails at the deadline when the job list stays unavailable", async () => {
    const run = harness([unavailable("HTTP 502")], 30_000);
    await expect(run.result).rejects.toThrow("did not complete within");
  });

  it("stops early on repeated permanent listing failures", async () => {
    const run = harness([unavailable("HTTP 401", true)]);
    await expect(run.result).rejects.toThrow("Cannot read this run's jobs: HTTP 401");
    expect(run.calls()).toBe(3);
  });

  it("does not count interrupted permanent failures as repeated", async () => {
    const run = harness([
      unavailable("HTTP 404", true),
      unavailable("HTTP 404", true),
      jobs(job("in_progress")),
      unavailable("HTTP 404", true),
      unavailable("HTTP 404", true),
      jobs(job("completed", "success")),
    ]);
    await run.result;
  });
});

const respond = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

describe("githubRunAttemptJobs", () => {
  const config = {
    apiUrl: "https://api.example.test",
    repository: "owner/repo",
    runId: "42",
    runAttempt: "3",
    token: "token",
  };

  it("reads every page of this run attempt's jobs", async () => {
    const urls: string[] = [];
    const pages = [
      { total_count: 3, jobs: [job("completed", "success", "a"), job("queued", null, "b")] },
      { total_count: 3, jobs: [job("in_progress", null, "c")] },
    ];
    const list = githubRunAttemptJobs({
      ...config,
      fetch: async (url, init) => {
        urls.push(url);
        expect(init.headers.authorization).toBe("Bearer token");
        return respond(200, pages[urls.length - 1]);
      },
    });
    expect(await list()).toEqual({
      kind: "jobs",
      jobs: [
        job("completed", "success", "a"),
        job("queued", null, "b"),
        job("in_progress", null, "c"),
      ],
    });
    expect(urls).toEqual([
      "https://api.example.test/repos/owner/repo/actions/runs/42/attempts/3/jobs?per_page=100&page=1",
      "https://api.example.test/repos/owner/repo/actions/runs/42/attempts/3/jobs?per_page=100&page=2",
    ]);
  });

  it.each([
    [401, true],
    [404, true],
    [403, false],
    [429, false],
    [502, false],
  ])("reports HTTP %i as unavailable (permanent: %s)", async (status, permanent) => {
    const list = githubRunAttemptJobs({ ...config, fetch: async () => respond(status, {}) });
    expect(await list()).toEqual({ kind: "unavailable", reason: `HTTP ${status}`, permanent });
  });

  it.each([
    ["not json", "malformed response"],
    [{ jobs: [] }, "malformed response"],
    [{ total_count: 1, jobs: "none" }, "malformed response"],
    [{ total_count: 1, jobs: [{ name: JOB, status: "completed" }] }, "malformed job entry"],
    [{ total_count: 1, jobs: [{ name: JOB, status: 7, conclusion: null }] }, "malformed job entry"],
  ])("never returns a partial or malformed listing (%#)", async (body, reason) => {
    const list = githubRunAttemptJobs({ ...config, fetch: async () => respond(200, body) });
    expect(await list()).toEqual({ kind: "unavailable", reason, permanent: false });
  });

  it("reports a thrown request as transient", async () => {
    const list = githubRunAttemptJobs({
      ...config,
      fetch: async () => {
        throw new Error("socket hang up");
      },
    });
    expect(await list()).toMatchObject({ kind: "unavailable", permanent: false });
  });
});
