import type { ComputerEvent } from "@synara/contracts";

/** Weak connection identities release interests when their connection closes. */
export class ComputerEventInterests {
  private readonly clients = new WeakMap<object, Set<string>>();

  watch(clientId: object, threadId: string): void {
    const threads = this.clients.get(clientId) ?? new Set<string>();
    threads.delete(threadId);
    threads.add(threadId);
    if (threads.size > 64) threads.delete(threads.values().next().value!);
    this.clients.delete(clientId);
    this.clients.set(clientId, threads);
  }

  accepts(clientId: object, event: ComputerEvent): boolean {
    const threadId =
      event.type === "computer.thread-state"
        ? event.state.threadId
        : event.type === "computer.action"
          ? event.threadId
          : undefined;
    return threadId === undefined || this.clients.get(clientId)?.has(threadId) === true;
  }

  forget(clientId: object): void {
    this.clients.delete(clientId);
  }
}
