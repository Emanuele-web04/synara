import { Effect } from "effect";

import type { ComputerSpaceReservation } from "@synara/contracts";
import type { ComputerManager } from "../computer/ComputerManager.ts";
import { ComputerSpaceError } from "../computer/ComputerSpaceBroker.ts";
import { assertDesktopOperationActive } from "../computer/DesktopOperationQueue.ts";
import { withModelDesktopObservation } from "../computer/modelDesktopObservation.ts";
import { ToolInputError } from "./toolInput.ts";
import type { ToolContext, ToolEntry, ToolHandler } from "./toolRuntime.ts";

interface SpaceToolsOptions {
  readonly manager: ComputerManager;
  readonly handle: (
    name: string,
    run: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>,
  ) => ToolHandler;
  readonly resolveSpaceDesignation?: (context: ToolContext) => Promise<readonly number[]>;
}

function spaceId(value: unknown, required: boolean): number | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ToolInputError(
      '"space_id" must be a positive safe integer from the current Space inventory.',
    );
  }
  return value;
}

/** The caller sees its selection, never another thread's identity. */
function publicReservation(value: ComputerSpaceReservation | null) {
  if (!value) return null;
  const { threadId: _threadId, turnId: _turnId, ...selection } = value;
  return selection;
}

/** A discoverable route through computer_inspect, with no added idle tool schema. */
export function makeComputerSpaceTools(options: SpaceToolsOptions): readonly ToolEntry[] {
  const broker = options.manager.spaceBroker;
  return [
    {
      requiredCapability: "computer:control",
      requiresActiveTurn: true,
      discoveryOnly: true,
      definition: {
        name: "computer_spaces",
        description:
          "Observe managed macOS Spaces, including empty Spaces, or reserve an existing user-designated noncurrent Space for this task. Selection returns an exact window_id to drive in place; it never activates or moves anything. No native Space create/move/switch/follow is supported. Read computer_help topic spaces for designation and limits.",
        inputSchema: {
          type: "object",
          properties: {
            operation: {
              type: "string",
              description:
                "list (default), reserve, release, select, or peek. create, move, switch and follow return an explicit unsupported-operation refusal.",
            },
            space_id: {
              type: "number",
              description:
                "Exact current native Space ID; required for reserve, optional filter for list/peek. Do not use Mission Control position numbers.",
            },
            window_id: {
              type: "string",
              description:
                "Exact existing window in the reserved Space; required for select, optional with reserve or peek. Selection changes only the task's logical target.",
            },
          },
          additionalProperties: false,
        },
        annotations: {
          title: "Manage the task's desktop Space",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      handler: options.handle("computer_spaces", async (args, context) => {
        for (const key of Object.keys(args)) {
          if (key !== "operation" && key !== "space_id" && key !== "window_id")
            throw new ToolInputError(`Unknown argument "${key}".`);
        }
        const operation = args.operation ?? "list";
        if (typeof operation !== "string")
          throw new ToolInputError('"operation" must be a string.');
        if (["create", "move", "switch", "follow"].includes(operation)) {
          throw new ComputerSpaceError(
            "computer_space_operation_unsupported",
            "This backend cannot create or switch managed Spaces, move windows between them, or follow a window by switching the user's desktop. Use an existing exact window in place. Nothing was moved or activated.",
          );
        }
        if (!["list", "reserve", "release", "select", "peek"].includes(operation))
          throw new ToolInputError("Unknown Space operation.");
        const id = spaceId(args.space_id, operation === "reserve");
        const windowId = args.window_id;
        if (
          windowId !== undefined &&
          (typeof windowId !== "string" || windowId.trim().length === 0 || windowId.length > 256)
        )
          throw new ToolInputError('"window_id" must name an exact observed window.');
        if (operation === "select" && !windowId)
          throw new ToolInputError('"select" requires "window_id".');
        const owner = { threadId: context.callerThreadId, turnId: context.callerTurnId };
        if (operation === "release") {
          if (id !== undefined || windowId !== undefined)
            throw new ToolInputError(
              "Release acts only on this task's reservation and accepts no target.",
            );
          broker.release(owner.threadId, owner.turnId ?? undefined);
          return { operation, reservation: null, changedDesktop: false };
        }
        if (operation === "reserve") {
          const designation = (await options.resolveSpaceDesignation?.(context)) ?? [];
          await Effect.runPromise(context.assertCallerTurnActive());
          assertDesktopOperationActive();
          const reservation = await broker.reserve(owner, id!, designation, windowId, async () => {
            const fresh = (await options.resolveSpaceDesignation?.(context)) ?? [];
            await Effect.runPromise(context.assertCallerTurnActive());
            return fresh.includes(id!);
          });
          return { operation, reservation: publicReservation(reservation), changedDesktop: false };
        }
        if (operation === "select") {
          if (id !== undefined)
            throw new ToolInputError("Select uses this task's reservation; omit space_id.");
          return {
            operation,
            reservation: publicReservation(await broker.select(owner, windowId!)),
            changedDesktop: false,
          };
        }
        const snapshot = await broker.inspect(id);
        if (operation === "list" && windowId !== undefined)
          throw new ToolInputError("Use peek to inspect one exact window.");
        const target =
          windowId === undefined
            ? undefined
            : snapshot.windows.find((window) => window.id === windowId);
        if (windowId !== undefined && !target)
          throw new ComputerSpaceError(
            "computer_space_target_outside_reservation",
            "That window is absent from this fresh Space inventory. List Spaces and windows again.",
          );
        const state = target
          ? await withModelDesktopObservation(() =>
              options.manager.getState({
                windowId: target.id,
                includeScreenshot: false,
                includeText: true,
              }),
            )
          : undefined;
        return {
          operation,
          ...snapshot,
          reservation: publicReservation(broker.reservationFor(owner)),
          ...(state ? { state } : {}),
          changedDesktop: false,
        };
      }),
    },
  ];
}
