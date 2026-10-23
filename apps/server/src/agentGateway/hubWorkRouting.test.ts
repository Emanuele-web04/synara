import { assert, it } from "@effect/vitest";
import { ProjectId } from "@synara/contracts";

import {
  hubWorkLogicalTaskKey,
  hubWorkPositionalTaskKey,
  hubWorkRequestFingerprint,
  hubWorkTaskFingerprint,
  hubWorkWorkItemId,
  normalizeHubTaskKey,
} from "./hubWorkRouting";

const projectId = ProjectId.makeUnsafe("routing-unit");

it("normalizes a proposed task key and rejects one the server cannot freeze", () => {
  assert.equal(normalizeHubTaskKey("  Login-Page  "), "login-page");
  assert.equal(normalizeHubTaskKey("api.v2_rollback:step-3"), "api.v2_rollback:step-3");
  assert.equal(normalizeHubTaskKey("0"), "0");
  for (const invalid of ["", "   ", "Login Page", "task/1", "tAsked".repeat(129), "-leading"]) {
    assert.equal(normalizeHubTaskKey(invalid), null);
  }
});

it("derives one identity per hub, scope and task key", () => {
  const identity = (taskKey: string, scopeKey = "source:a") =>
    hubWorkWorkItemId({ projectId, scopeKey, taskKey });
  assert.equal(identity("alpha"), identity("alpha"));
  assert.notEqual(identity("alpha"), identity("beta"));
  assert.notEqual(identity("alpha"), "source:a");
  assert.notEqual(identity("alpha", "source:b"), identity("alpha", "source:a"));
  assert.notEqual(
    hubWorkWorkItemId({
      projectId: ProjectId.makeUnsafe("other-hub"),
      scopeKey: "source:a",
      taskKey: "alpha",
    }),
    identity("alpha"),
  );
  assert.equal(hubWorkWorkItemId({ projectId, scopeKey: "source:a", taskKey: "alpha" }).length, 49);
});

it("keeps unkeyed tasks addressable by their frozen position", () => {
  assert.equal(hubWorkLogicalTaskKey({ taskIndex: 2 }), hubWorkPositionalTaskKey(2));
  assert.equal(hubWorkLogicalTaskKey({ taskIndex: 0, taskKey: "alpha" }), "alpha");
});

it("freezes a task decision independently of order and of the routing reason", () => {
  const first = hubWorkTaskFingerprint({
    sourceMessages: [{ messageId: "m1" }],
    spec: { prompt: "Task", target: { provider: "codex", model: "gpt-5" } },
    title: "Task",
  });
  assert.equal(
    first,
    hubWorkTaskFingerprint({
      sourceMessages: [{ messageId: "m1" }],
      spec: { target: { model: "gpt-5", provider: "codex" }, prompt: "Task" },
      title: "Task",
    }),
  );
  assert.notEqual(
    first,
    hubWorkTaskFingerprint({
      sourceMessages: [{ messageId: "m2" }],
      spec: { prompt: "Task", target: { provider: "codex", model: "gpt-5" } },
      title: "Task",
    }),
  );
  assert.notEqual(
    first,
    hubWorkTaskFingerprint({
      sourceMessages: [{ messageId: "m1" }],
      spec: { prompt: "Changed", target: { provider: "codex", model: "gpt-5" } },
      title: "Task",
    }),
  );
  assert.equal(
    hubWorkRequestFingerprint({
      sourceMessages: [{ messageId: "m1" }],
      taskKeys: ["b", "a"],
    }),
    hubWorkRequestFingerprint({
      sourceMessages: [{ messageId: "m1" }],
      taskKeys: ["a", "b"],
    }),
  );
  assert.notEqual(
    hubWorkRequestFingerprint({
      sourceMessages: [{ messageId: "m1" }],
      taskKeys: ["a"],
    }),
    hubWorkRequestFingerprint({
      sourceMessages: [{ messageId: "m1" }],
      taskKeys: ["a", "b"],
    }),
  );
});
