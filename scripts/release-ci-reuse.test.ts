import { describe, expect, it } from "vitest";
import { hasVerifiedReleaseCi, REQUIRED_RELEASE_CI_JOBS } from "./lib/release-ci-reuse";

const sha = "a".repeat(40);
const success = {
  id: 1,
  run_attempt: 2,
  path: ".github/workflows/ci.yml",
  head_sha: sha,
  head_branch: "main",
  event: "push",
  status: "completed",
  conclusion: "success",
};

const runsPayload = (runs: unknown[] = [success]) => ({
  total_count: runs.length,
  workflow_runs: runs,
});
const successfulJobs = REQUIRED_RELEASE_CI_JOBS.map((name, index) => ({
  id: index + 10,
  name,
  run_id: success.id,
  run_attempt: success.run_attempt,
  head_sha: sha,
  status: "completed",
  conclusion: "success",
}));
const jobsPayload = (jobs: unknown[] = successfulJobs) => ({ total_count: jobs.length, jobs });

describe("release CI reuse", () => {
  it("accepts successful jobs from the exact main commit, run and latest attempt", () => {
    expect(hasVerifiedReleaseCi(runsPayload(), sha, jobsPayload())).toBe(true);
  });
  it.each([
    { head_sha: "b".repeat(40) },
    { head_branch: "feature" },
    { event: "pull_request" },
    { path: ".github/workflows/unrelated.yml" },
    { status: "in_progress" },
    { conclusion: "failure" },
    { conclusion: "cancelled" },
    { run_attempt: 0 },
    { run_attempt: undefined },
  ])("rejects insufficient evidence %j", (override) => {
    expect(
      hasVerifiedReleaseCi(runsPayload([{ ...success, ...override }]), sha, jobsPayload()),
    ).toBe(false);
  });
  it.each(["failure", null])("does not reuse old success over a newer run: %s", (conclusion) => {
    expect(
      hasVerifiedReleaseCi(
        runsPayload([success, { ...success, id: 2, conclusion }]),
        sha,
        jobsPayload(),
      ),
    ).toBe(false);
  });
  it("rejects successful aggregate results when docs-only jobs were skipped", () => {
    const jobs = successfulJobs.map((job) => ({
      ...job,
      conclusion: [
        "Detect code changes",
        "Static Checks (fast)",
        "Format, Lint, Typecheck, Test, Browser Test, Build",
      ].includes(job.name)
        ? "success"
        : "skipped",
    }));
    expect(hasVerifiedReleaseCi(runsPayload(), sha, jobsPayload(jobs))).toBe(false);
  });
  it("requires every mandatory lane even when the aggregate passed", () => {
    for (const name of REQUIRED_RELEASE_CI_JOBS) {
      const jobs = successfulJobs.filter((job) => job.name !== name);
      expect(hasVerifiedReleaseCi(runsPayload(), sha, jobsPayload(jobs)), name).toBe(false);
    }
  });
  it.each([
    { run_id: 2 },
    { run_attempt: 1 },
    { head_sha: "b".repeat(40) },
    { status: "in_progress", conclusion: null },
    { conclusion: "failure" },
    { conclusion: "cancelled" },
    { conclusion: "skipped" },
    { conclusion: "neutral" },
  ])("rejects a stale or unsuccessful required job: %j", (override) => {
    const jobs = successfulJobs.map((job, index) => (index === 2 ? { ...job, ...override } : job));
    expect(hasVerifiedReleaseCi(runsPayload(), sha, jobsPayload(jobs))).toBe(false);
  });
  it("rejects jobs from an earlier run or attempt after metadata refresh", () => {
    for (const override of [{ id: 2 }, { run_attempt: 3 }]) {
      expect(
        hasVerifiedReleaseCi(runsPayload([{ ...success, ...override }]), sha, jobsPayload()),
      ).toBe(false);
    }
  });
  it("rejects duplicate job identities and incomplete job pages", () => {
    const duplicateName = [...successfulJobs, { ...successfulJobs[0]!, id: 999 }];
    const duplicateId = successfulJobs.map((job, index) =>
      index === 1 ? { ...job, id: 10 } : job,
    );
    for (const payload of [
      jobsPayload(duplicateName),
      jobsPayload(duplicateId),
      { ...jobsPayload(), total_count: successfulJobs.length + 1 },
    ]) {
      expect(hasVerifiedReleaseCi(runsPayload(), sha, payload)).toBe(false);
    }
  });
  it.each([null, {}, { jobs: null }, jobsPayload([null, 7, {}])])(
    "fails closed for malformed job evidence: %j",
    (payload) => {
      expect(hasVerifiedReleaseCi(runsPayload(), sha, payload)).toBe(false);
    },
  );
  it("rejects incomplete, duplicate or malformed workflow pages", () => {
    for (const payload of [
      { ...runsPayload(), total_count: 2 },
      runsPayload([success, success]),
      runsPayload([success, { ...success, id: undefined }]),
    ]) {
      expect(hasVerifiedReleaseCi(payload, sha, jobsPayload())).toBe(false);
    }
  });
  it.each([null, {}, { workflow_runs: null }, { workflow_runs: [null, 7, {}] }])(
    "fails closed for malformed or missing evidence: %j",
    (payload) => {
      expect(hasVerifiedReleaseCi(payload, sha, jobsPayload())).toBe(false);
    },
  );
});
