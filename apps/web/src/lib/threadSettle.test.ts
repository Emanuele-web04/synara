import { describe, expect, it } from "vitest";

import {
  createOptimisticSettledMutation,
  recordOptimisticSettledMutationSequence,
  reconcileOptimisticSettledMutation,
} from "./threadSettle";

describe("optimistic thread settlement", () => {
  it("acknowledges a projection that reaches a newly requested state", () => {
    const mutation = createOptimisticSettledMutation({
      desiredSettled: true,
      serverSettledAtDispatch: false,
    });

    expect(reconcileOptimisticSettledMutation(mutation, true).acknowledged).toBe(true);
  });

  it("does not mistake the pre-Done snapshot for acknowledgement of a fast Undo", () => {
    const undo = createOptimisticSettledMutation({
      desiredSettled: false,
      serverSettledAtDispatch: false,
    });

    const beforeDoneProjects = reconcileOptimisticSettledMutation(undo, false);
    expect(beforeDoneProjects.acknowledged).toBe(false);
    expect(beforeDoneProjects.mutation.observedDifferentState).toBe(false);

    const doneProjects = reconcileOptimisticSettledMutation(beforeDoneProjects.mutation, true);
    expect(doneProjects.acknowledged).toBe(false);
    expect(doneProjects.mutation.observedDifferentState).toBe(true);

    expect(reconcileOptimisticSettledMutation(doneProjects.mutation, false).acknowledged).toBe(
      true,
    );
  });

  it("acknowledges a batched replay once it reaches the durable command sequence", () => {
    const undo = recordOptimisticSettledMutationSequence(
      createOptimisticSettledMutation({
        desiredSettled: false,
        serverSettledAtDispatch: false,
      }),
      42,
    );

    expect(reconcileOptimisticSettledMutation(undo, false, 41).acknowledged).toBe(false);
    expect(reconcileOptimisticSettledMutation(undo, false, 42).acknowledged).toBe(true);
  });
});
