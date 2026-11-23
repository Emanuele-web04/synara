import { describe, expect, it } from "vitest";

import { queueReasonKey } from "./stateWords";

describe("queueReasonKey", () => {
  it("says why a task is queued in the user's words, never the server's raw string", () => {
    expect(queueReasonKey("Waiting for an available worker slot")).toBe("synbot:queue_waitingSlot");
    expect(queueReasonKey("Resume this hub before starting work")).toBe("synbot:queue_resumeBot");
    expect(queueReasonKey("Link this repository before starting")).toBe("synbot:queue_linkProject");
    expect(queueReasonKey("Something new from the server")).toBe("synbot:task_queued");
    expect(queueReasonKey(null)).toBe("synbot:task_queued");
  });
});
