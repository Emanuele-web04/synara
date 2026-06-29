// Purpose: Orchestration decider entry point — routes each OrchestrationCommand
//   to a domain handler that derives the resulting OrchestrationEvent(s).
// Layer: orchestration (event-sourcing decider). Pure event derivation, no I/O.
// Exports: decideOrchestrationCommand (the complete public decider surface).

import type { OrchestrationCommand, OrchestrationReadModel } from "@t3tools/contracts";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import type { DeciderReturn } from "./decider.shared.ts";
import { decideProjectCommand } from "./decider.project.ts";
import { decideThreadLifecycleCommand } from "./decider.threadLifecycle.ts";
import { decideTurnCommand } from "./decider.turn.ts";
import { decideRuntimeCommand } from "./decider.runtime.ts";

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
}): DeciderReturn {
  switch (command.type) {
    case "project.create":
    case "project.meta.update":
    case "project.delete":
      return yield* decideProjectCommand({ command, readModel });

    case "thread.create":
    case "thread.handoff.create":
    case "thread.fork.create":
    case "thread.delete":
    case "thread.archive":
    case "thread.unarchive":
    case "thread.meta.update":
    case "thread.pinned-message.add":
    case "thread.pinned-message.remove":
    case "thread.pinned-message.done.set":
    case "thread.pinned-message.label.set":
    case "thread.marker.add":
    case "thread.marker.remove":
    case "thread.marker.done.set":
    case "thread.marker.label.set":
    case "thread.runtime-mode.set":
    case "thread.interaction-mode.set":
      return yield* decideThreadLifecycleCommand({ command, readModel });

    case "thread.turn.start":
    case "thread.turn.dispatch-queued":
    case "thread.turn.interrupt":
    case "thread.approval.respond":
    case "thread.user-input.respond":
    case "thread.checkpoint.revert":
    case "thread.conversation.rollback":
    case "thread.message.edit-and-resend":
    case "thread.session.stop":
    case "thread.session.ensure":
    case "thread.context.inject":
    case "thread.runtime.action":
    case "thread.session.set":
    case "thread.messages.import":
    case "thread.message.assistant.delta":
    case "thread.message.assistant.complete":
    case "thread.proposed-plan.upsert":
    case "thread.provider-item.upsert":
    case "thread.turn.diff.complete":
    case "thread.revert.complete":
    case "thread.conversation.rollback.complete":
    case "thread.activity.append":
      return yield* decideTurnCommand({ command, readModel });

    case "thread.runtime.provision":
    case "thread.runtime.instance.record":
    case "thread.runtime.state.record":
    case "thread.runtime.stop":
    case "thread.runtime.destroy":
    case "thread.runtime.process.start":
    case "thread.runtime.process.output":
    case "thread.runtime.process.complete":
    case "thread.runtime.snapshot":
    case "thread.runtime.expose-port":
    case "thread.runtime.lease.acquire":
    case "thread.runtime.lease.release":
    case "thread.runtime.fail":
      return yield* decideRuntimeCommand({ command, readModel });

    default: {
      command satisfies never;
      const fallback = command as never as { type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unknown command type: ${fallback.type}`,
      });
    }
  }
});
