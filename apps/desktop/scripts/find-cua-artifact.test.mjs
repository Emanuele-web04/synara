import { describe, expect, it, vi } from "vitest";
import { findCuaArtifact } from "./find-cua-artifact.mjs";

const key = `cua-v1-${"a".repeat(64)}`;
const repo = { owner: "owner", repo: "synara" };
const artifact = () => ({
  id: 42,
  name: key,
  expired: false,
  expires_at: "2099-01-01T00:00:00Z",
  digest: `sha256:${"b".repeat(64)}`,
  workflow_run: {
    id: 123,
    repository_id: 1,
    head_repository_id: 1,
    head_branch: "main",
    head_sha: "c".repeat(40),
  },
});
const run = () => ({
  id: 123,
  workflow_id: 7,
  path: ".github/workflows/cua-release-cache.yml",
  repository: { id: 1 },
  head_repository: { id: 1 },
  head_branch: "main",
  head_sha: "c".repeat(40),
  status: "completed",
  conclusion: "success",
  event: "push",
});
function api(artifacts = [artifact()], producer = run()) {
  return {
    rest: {
      repos: {
        get: vi.fn().mockResolvedValue({ data: { id: 1, default_branch: "main" } }),
      },
      actions: {
        getWorkflow: vi.fn().mockResolvedValue({ data: { id: 7 } }),
        listArtifactsForRepo: vi.fn().mockResolvedValue({ data: { artifacts } }),
        getWorkflowRun: vi.fn().mockResolvedValue({ data: producer }),
      },
    },
  };
}

describe("trusted persistent Cua artifact lookup", () => {
  it.each(["push", "workflow_dispatch", "schedule"])(
    "accepts an exact artifact from the successful %s producer",
    async (event) => {
      const github = api([artifact()], { ...run(), event });
      expect(await findCuaArtifact(github, repo, key)).toEqual({ artifactId: 42, runId: 123 });
      expect(github.rest.actions.getWorkflow).toHaveBeenCalledWith({
        ...repo,
        workflow_id: "cua-release-cache.yml",
      });
      expect(github.rest.actions.listArtifactsForRepo).toHaveBeenCalledWith({
        ...repo,
        name: key,
        page: 1,
        per_page: 100,
      });
    },
  );
  it.each([
    ["different key", { name: `${key}-partial` }],
    ["expired", { expired: true }],
    ["past retention", { expires_at: "2000-01-01T00:00:00Z" }],
    ["missing digest", { digest: undefined }],
    ["missing origin", { workflow_run: undefined }],
    ["other repository", { workflow_run: { ...artifact().workflow_run, repository_id: 2 } }],
    ["fork", { workflow_run: { ...artifact().workflow_run, head_repository_id: 2 } }],
    ["PR branch", { workflow_run: { ...artifact().workflow_run, head_branch: "feature" } }],
  ])("ignores an artifact with %s", async (_, change) => {
    expect(await findCuaArtifact(api([{ ...artifact(), ...change }]), repo, key)).toBeUndefined();
  });
  it.each([
    ["another workflow", { workflow_id: 8 }],
    ["another workflow path", { path: ".github/workflows/release.yml" }],
    ["another repository", { repository: { id: 2 } }],
    ["a fork", { head_repository: { id: 2 } }],
    ["a branch", { head_branch: "feature" }],
    ["another commit", { head_sha: "d".repeat(40) }],
    ["unfinished run", { status: "in_progress" }],
    ["failed run", { conclusion: "failure" }],
    ["cancelled run", { conclusion: "cancelled" }],
    ["PR event", { event: "pull_request" }],
    ["privileged PR event", { event: "pull_request_target" }],
  ])("rejects a matching artifact from %s", async (_, change) => {
    expect(
      await findCuaArtifact(api([artifact()], { ...run(), ...change }), repo, key),
    ).toBeUndefined();
  });
  it("returns a cold miss for missing artifacts and continues past stale results", async () => {
    expect(await findCuaArtifact(api([]), repo, key)).toBeUndefined();
    const github = api();
    github.rest.actions.listArtifactsForRepo
      .mockResolvedValueOnce({
        data: { artifacts: Array(100).fill({ ...artifact(), expired: true }) },
      })
      .mockResolvedValueOnce({ data: { artifacts: [artifact()] } });
    expect(await findCuaArtifact(github, repo, key)).toEqual({ artifactId: 42, runId: 123 });
  });
  it("never treats unavailable trust metadata as permission to reuse", async () => {
    const github = api();
    github.rest.actions.getWorkflowRun.mockRejectedValue(new Error("API unavailable"));
    await expect(findCuaArtifact(github, repo, key)).rejects.toThrow("API unavailable");
  });
});
