// Purpose: Decider handlers for execution-runtime instance lifecycle commands
//   (provision, instance/process records, snapshots, ports, leases, failures).
// Layer: orchestration (event-sourcing decider). Pure event derivation, no I/O.
// Exports: decideRuntimeCommand.

import type { OrchestrationCommand, OrchestrationReadModel } from "@t3tools/contracts";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { requireThread } from "./commandInvariants.ts";
import { withEventBase, type DeciderReturn } from "./decider.shared.ts";

type RuntimeCommand = Extract<
  OrchestrationCommand,
  {
    type:
      | "thread.runtime.provision"
      | "thread.runtime.instance.record"
      | "thread.runtime.state.record"
      | "thread.runtime.stop"
      | "thread.runtime.destroy"
      | "thread.runtime.process.start"
      | "thread.runtime.process.output"
      | "thread.runtime.process.complete"
      | "thread.runtime.snapshot"
      | "thread.runtime.expose-port"
      | "thread.runtime.lease.acquire"
      | "thread.runtime.lease.release"
      | "thread.runtime.fail";
  }
>;

export const decideRuntimeCommand = Effect.fn("decideRuntimeCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: RuntimeCommand;
  readonly readModel: OrchestrationReadModel;
}): DeciderReturn {
  switch (command.type) {
    case "thread.runtime.provision": {
      yield* requireThread({ readModel, command, threadId: command.threadId });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.runtime-provision-requested",
        payload: {
          threadId: command.threadId,
          targetKind: command.targetKind,
          provider: command.provider,
          role: command.role,
          requestedAt: command.createdAt,
        },
      };
    }

    case "thread.runtime.instance.record": {
      yield* requireThread({ readModel, command, threadId: command.threadId });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.runtime-instance-created",
        payload: {
          threadId: command.threadId,
          instanceId: command.instanceId,
          provider: command.provider,
          status: command.status,
          rootPath: command.rootPath,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.runtime.state.record": {
      yield* requireThread({ readModel, command, threadId: command.threadId });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.runtime-instance-state-changed",
        payload: {
          threadId: command.threadId,
          instanceId: command.instanceId,
          status: command.status,
          ...(command.rootPath !== undefined ? { rootPath: command.rootPath } : {}),
          ...(command.failureReason !== undefined ? { failureReason: command.failureReason } : {}),
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.runtime.stop": {
      yield* requireThread({ readModel, command, threadId: command.threadId });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.runtime-instance-state-changed",
        payload: {
          threadId: command.threadId,
          instanceId: command.instanceId,
          status: "stopping",
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.runtime.destroy": {
      yield* requireThread({ readModel, command, threadId: command.threadId });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.runtime-destroyed",
        payload: {
          threadId: command.threadId,
          instanceId: command.instanceId,
          destroyedAt: command.createdAt,
        },
      };
    }

    case "thread.runtime.process.start": {
      yield* requireThread({ readModel, command, threadId: command.threadId });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.runtime-process-started",
        payload: {
          threadId: command.threadId,
          instanceId: command.instanceId,
          processId: command.processId,
          role: command.role,
          command: command.command,
          startedAt: command.createdAt,
        },
      };
    }

    case "thread.runtime.process.output": {
      yield* requireThread({ readModel, command, threadId: command.threadId });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.runtime-process-output",
        payload: {
          threadId: command.threadId,
          instanceId: command.instanceId,
          processId: command.processId,
          stream: command.stream,
          tail: command.tail,
          occurredAt: command.createdAt,
        },
      };
    }

    case "thread.runtime.process.complete": {
      yield* requireThread({ readModel, command, threadId: command.threadId });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.runtime-process-completed",
        payload: {
          threadId: command.threadId,
          instanceId: command.instanceId,
          processId: command.processId,
          status: command.status,
          exitCode: command.exitCode,
          ...(command.failureReason !== undefined ? { failureReason: command.failureReason } : {}),
          ...(command.tail !== undefined ? { tail: command.tail } : {}),
          exitedAt: command.createdAt,
        },
      };
    }

    case "thread.runtime.snapshot": {
      yield* requireThread({ readModel, command, threadId: command.threadId });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.runtime-snapshot-created",
        payload: {
          threadId: command.threadId,
          instanceId: command.instanceId,
          snapshotId: command.snapshotId,
          ...(command.label !== undefined ? { label: command.label } : {}),
          ...(command.secretTainted !== undefined ? { secretTainted: command.secretTainted } : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.runtime.expose-port": {
      yield* requireThread({ readModel, command, threadId: command.threadId });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.runtime-route-exposed",
        payload: {
          threadId: command.threadId,
          instanceId: command.instanceId,
          routeId: command.routeId,
          port: command.port,
          url: command.url,
          ...(command.label !== undefined ? { label: command.label } : {}),
          exposedAt: command.createdAt,
        },
      };
    }

    case "thread.runtime.lease.acquire": {
      yield* requireThread({ readModel, command, threadId: command.threadId });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.runtime-lease-renewed",
        payload: {
          threadId: command.threadId,
          instanceId: command.instanceId,
          leaseId: command.leaseId,
          reason: command.reason,
          acquiredAt: command.createdAt,
          renewedAt: command.createdAt,
          ...(command.expiresAt !== undefined ? { expiresAt: command.expiresAt } : {}),
          released: false,
        },
      };
    }

    case "thread.runtime.lease.release": {
      yield* requireThread({ readModel, command, threadId: command.threadId });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.runtime-lease-renewed",
        payload: {
          threadId: command.threadId,
          instanceId: command.instanceId,
          leaseId: command.leaseId,
          reason: command.reason,
          acquiredAt: command.acquiredAt,
          renewedAt: command.createdAt,
          released: true,
        },
      };
    }

    case "thread.runtime.fail": {
      yield* requireThread({ readModel, command, threadId: command.threadId });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.runtime-failed",
        payload: {
          threadId: command.threadId,
          instanceId: command.instanceId,
          failureReason: command.failureReason,
          occurredAt: command.createdAt,
        },
      };
    }

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
