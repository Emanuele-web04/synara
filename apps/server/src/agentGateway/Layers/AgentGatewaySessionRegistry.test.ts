import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@synara/contracts";

import { makeAgentGatewaySessionRegistry } from "./AgentGatewaySessionRegistry.ts";

describe("AgentGatewaySessionRegistry", () => {
  it("allows independent legitimate sessions for the same thread", () => {
    let nextId = 0;
    const registry = makeAgentGatewaySessionRegistry({ randomId: () => String(++nextId) });
    const first = registry.issue(ThreadId.makeUnsafe("thread-1"), "codex");
    const second = registry.issue(ThreadId.makeUnsafe("thread-1"), "claudeAgent");
    assert.notEqual(first.token, second.token);
    assert.equal(registry.verify(first.token)?.threadId, "thread-1");
    assert.equal(registry.verify(second.token)?.threadId, "thread-1");
    assert.equal(registry.verify(first.token)?.provider, "codex");
    assert.equal(registry.verify(second.token)?.provider, "claudeAgent");
  });

  it("revokes one session without revoking another", () => {
    let nextId = 0;
    const registry = makeAgentGatewaySessionRegistry({ randomId: () => String(++nextId) });
    const first = registry.issue(ThreadId.makeUnsafe("thread-1"), "codex");
    const second = registry.issue(ThreadId.makeUnsafe("thread-1"), "codex");
    registry.revoke(first.token);
    assert.isNull(registry.verify(first.token));
    assert.equal(registry.verify(second.token)?.threadId, "thread-1");
  });

  it("keeps credentials valid for a long-lived provider session but not across restart", () => {
    let time = 1_000;
    const firstRegistry = makeAgentGatewaySessionRegistry({
      now: () => time,
      randomId: () => "first",
    });
    const issued = firstRegistry.issue(ThreadId.makeUnsafe("thread-1"), "codex");
    time += 48 * 60 * 60 * 1_000;
    assert.equal(firstRegistry.verify(issued.token)?.threadId, "thread-1");

    const afterRestart = makeAgentGatewaySessionRegistry({ randomId: () => "second" });
    assert.isNull(afterRestart.verify(issued.token));
  });

  it("keeps raw bearer tokens out of verified session identity snapshots", () => {
    const registry = makeAgentGatewaySessionRegistry({ randomId: () => "opaque-secret" });
    const issued = registry.issue(ThreadId.makeUnsafe("thread-1"), "codex");
    const verified = registry.verify(issued.token);
    assert.match(issued.token, /^sagw_session_/);
    assert.notProperty(verified, "token");
    assert.notInclude(JSON.stringify(verified), issued.token);
  });
});
