import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  makeExternalMcpAuditCompletion,
  type ExternalMcpAuditCompletion,
} from "./auditCompletion.ts";

describe("makeExternalMcpAuditCompletion", () => {
  it("preserves a successful outcome and retries an ordinary persistence failure", async () => {
    let attempts = 0;
    const persisted: ExternalMcpAuditCompletion[] = [];
    const completion = makeExternalMcpAuditCompletion((input) =>
      Effect.suspend(() => {
        attempts += 1;
        if (attempts === 1) return Effect.fail(new Error("database locked"));
        return Effect.sync(() => persisted.push(input)).pipe(Effect.asVoid);
      }),
    );
    const fallback = {
      auditId: "audit-retry",
      outcome: "error",
      detail: "Tool call ended before audit completion.",
    } as const;
    const success = {
      auditId: "audit-retry",
      outcome: "success",
      createdTaskIds: ["thread-created"],
    } as const;

    completion.markPending(fallback);
    await Effect.runPromise(completion.complete(success));
    expect(attempts).toBe(1);
    expect(persisted).toEqual([]);

    await Effect.runPromise(completion.retryPending());
    expect(attempts).toBe(2);
    expect(persisted).toEqual([success]);
  });
});
