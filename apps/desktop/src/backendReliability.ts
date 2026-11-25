import type { ChildProcess } from "node:child_process";
import { Schema } from "effect";
import { ReliabilityInput } from "@synara/contracts";

const Message = Schema.Struct({
  type: Schema.Literal("synara:reliability"),
  issue: ReliabilityInput,
}).annotate({ parseOptions: { onExcessProperty: "error" } });

/** Observe the child we spawned until close, including its graceful shutdown tail. */
export function attachBackendReliability(
  child: ChildProcess,
  input: {
    report: (issue: ReliabilityInput) => void;
  },
): void {
  const onMessage = (message: unknown) => {
    try {
      if (Schema.is(Message)(message)) input.report(message.issue);
    } catch {
      // Reporting cannot fail the backend event listener.
    }
  };
  child.on("message", onMessage);
  child.once("close", () => child.off("message", onMessage));
}
