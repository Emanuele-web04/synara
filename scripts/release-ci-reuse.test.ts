import { describe, expect, it } from "vitest";
import { hasVerifiedReleaseCi } from "./lib/release-ci-reuse";

const sha = "a".repeat(40);
const success = {
  id: 1,
  path: ".github/workflows/ci.yml",
  head_sha: sha,
  head_branch: "main",
  event: "push",
  status: "completed",
  conclusion: "success",
};
describe("release CI reuse", () => {
  it("accepts successful CI for the exact main commit", () => {
    expect(hasVerifiedReleaseCi({ workflow_runs: [success] }, sha)).toBe(true);
  });
  it.each([
    { head_sha: "b".repeat(40) },
    { head_branch: "feature" },
    { event: "pull_request" },
    { path: ".github/workflows/unrelated.yml" },
    { status: "in_progress" },
    { conclusion: "failure" },
    { conclusion: "cancelled" },
  ])("rejects insufficient evidence %j", (override) => {
    expect(hasVerifiedReleaseCi({ workflow_runs: [{ ...success, ...override }] }, sha)).toBe(false);
  });
  it.each(["failure", null])("does not reuse old success over a newer run: %s", (conclusion) => {
    expect(
      hasVerifiedReleaseCi({ workflow_runs: [success, { ...success, id: 2, conclusion }] }, sha),
    ).toBe(false);
  });
  it.each([null, {}, { workflow_runs: null }, { workflow_runs: [null, 7, {}] }])(
    "fails closed for malformed or missing evidence: %j",
    (payload) => {
      expect(hasVerifiedReleaseCi(payload, sha)).toBe(false);
    },
  );
});
