import { Deferred, Effect } from "effect";

import { GitCommandError } from "../Errors.ts";
import type { ExecuteGitInput } from "../Services/GitCore.ts";

const GIT_SHORT_COMMAND_PERMITS = 6;
const GIT_LONG_COMMAND_PERMITS = 2;
const GIT_COMMAND_MAX_QUEUED_PER_CLASS = 128;
const GIT_COMMAND_ADMISSION_WARNING_MS = 2_000;

type AdmissionClass = {
  readonly permits: number;
  readonly queue: Ticket[];
  running: number;
};
type Ticket = {
  readonly admissionClass: AdmissionClass;
  readonly ready: Deferred.Deferred<void>;
  state: "queued" | "running" | "released";
};

// Independent FIFO classes reserve checkpoint/read capacity even while hooks or
// network commands wait indefinitely. Both classes are shared by live instances.
const shortCommands: AdmissionClass = { permits: GIT_SHORT_COMMAND_PERMITS, queue: [], running: 0 };
const longCommands: AdmissionClass = { permits: GIT_LONG_COMMAND_PERMITS, queue: [], running: 0 };

export function gitSubcommand(args: ReadonlyArray<string>): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    // Git global options with a separate value precede the actual subcommand.
    if (
      arg === "-c" ||
      arg === "-C" ||
      arg === "--git-dir" ||
      arg === "--work-tree" ||
      arg === "--namespace" ||
      arg === "--config-env"
    ) {
      index++;
    } else if (!arg.startsWith("-")) {
      return arg;
    }
  }
  return undefined;
}

const releaseTicket = (ticket: Ticket): void => {
  if (ticket.state === "released") return;
  const group = ticket.admissionClass;
  if (ticket.state === "queued") {
    const index = group.queue.indexOf(ticket);
    if (index !== -1) group.queue.splice(index, 1);
  } else {
    group.running--;
    const next = group.queue.shift();
    if (next) {
      // Transfer ownership before waking the waiter: a new caller cannot barge
      // into the released slot while the FIFO head is resuming.
      next.state = "running";
      group.running++;
      Deferred.doneUnsafe(next.ready, Effect.void);
    }
  }
  ticket.state = "released";
};

export const withGitCommandAdmission = <A, E, R>(
  input: ExecuteGitInput,
  execution: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | GitCommandError, R> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const subcommand = gitSubcommand(input.args);
      const group =
        input.timeoutMs === null ||
        subcommand === "commit" ||
        subcommand === "push" ||
        subcommand === "pull" ||
        subcommand === "fetch" ||
        subcommand === "clone"
          ? longCommands
          : shortCommands;
      if (group.queue.length >= GIT_COMMAND_MAX_QUEUED_PER_CLASS) {
        return yield* new GitCommandError({
          operation: input.operation,
          command: "git admission",
          cwd: input.cwd,
          detail: "Git command admission queue is full; try again after pending commands finish.",
        });
      }
      const ticket: Ticket = {
        admissionClass: group,
        ready: Deferred.makeUnsafe<void>(),
        state: group.running < group.permits ? "running" : "queued",
      };
      if (ticket.state === "running") group.running++;
      else group.queue.push(ticket);

      // Registration and the finalizer are indivisible. Cancellation can remove a
      // queued ticket or release a just-transferred slot, but can never leak it.
      return yield* restore(
        Effect.gen(function* () {
          if (ticket.state === "queued") {
            yield* Effect.scoped(
              Effect.gen(function* () {
                yield* Effect.forkScoped(
                  Effect.sleep(GIT_COMMAND_ADMISSION_WARNING_MS).pipe(
                    Effect.andThen(
                      Effect.logWarning("Git command admission waited over two seconds", {
                        operation: input.operation,
                      }),
                    ),
                  ),
                );
                yield* Deferred.await(ticket.ready);
              }),
            );
          }
          return yield* execution;
        }),
      ).pipe(Effect.ensuring(Effect.sync(() => releaseTicket(ticket))));
    }),
  );
