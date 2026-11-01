import type { EditorIntelligenceInput, EditorIntelligenceResult } from "@synara/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

interface CompilerWorker {
  messages: { id: number }[];
  emit(event: "message", message: { id: number; result: EditorIntelligenceResult }): boolean;
  terminate: ReturnType<typeof vi.fn>;
}
const { workers } = vi.hoisted(() => ({ workers: [] as CompilerWorker[] }));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Worker: class extends EventEmitter {
      messages: { id: number }[] = [];
      terminate = vi.fn().mockResolvedValue(0);
      constructor() {
        super();
        workers.push(this);
      }
      postMessage(message: { id: number }) {
        this.messages.push(message);
      }
    },
  };
});
import { EditorLanguageService } from "./languageService";

const input: EditorIntelligenceInput = {
  cwd: process.cwd(),
  relativePath: "main.ts",
  documents: [{ relativePath: "main.ts", contents: "const value = 1;", version: 1 }],
  operation: "hover",
  offset: 6,
  length: 0,
};
let service: EditorLanguageService;
beforeEach(() => {
  vi.useFakeTimers();
  workers.length = 0;
  service = new EditorLanguageService();
});
afterEach(() => {
  service.dispose();
  vi.useRealTimers();
});

it("counts timed-out compiler work until a reply frees its admission slot", async () => {
  const requests = Array.from({ length: 16 }, () =>
    service.request("client", input).catch((error: Error) => error),
  );
  await vi.waitFor(() => expect(workers[0]?.messages).toHaveLength(16));
  const worker = workers[0]!;
  await vi.advanceTimersByTimeAsync(15_000);
  for (const result of await Promise.all(requests))
    expect(result).toMatchObject({ message: expect.stringContaining("15-second deadline") });

  let overflowError: Error | undefined;
  const overflow = service.request("client", input).catch((error: Error) => {
    overflowError = error;
    return error;
  });
  await vi.waitFor(() => expect(overflowError || worker.messages.length === 17).toBeTruthy());
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await overflow).toMatchObject({ message: "Too many pending language requests." });

  worker.emit("message", { id: worker.messages[0]!.id, result: { version: 1 } });
  const next = service.request("client", input);
  await vi.waitFor(() => expect(worker.messages).toHaveLength(17));
  worker.emit("message", {
    id: worker.messages.at(-1)!.id,
    result: { version: 1, text: "the compiler stayed warm" },
  });
  expect(await next).toEqual({ version: 1, text: "the compiler stayed warm" });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(worker.terminate).not.toHaveBeenCalled();
});

it("replaces a silent worker after timed-out callers have already settled", async () => {
  const request = service.request("client", input).catch((error: Error) => error);
  await vi.waitFor(() => expect(workers[0]?.messages).toHaveLength(1));
  const silent = workers[0]!;
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await request).toMatchObject({ message: expect.stringContaining("15-second deadline") });
  expect(silent.terminate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(45_000);
  expect(silent.terminate).toHaveBeenCalledOnce();

  const retry = service.request("client", input);
  await vi.waitFor(() => expect(workers).toHaveLength(2));
  const replacement = workers[1]!;
  replacement.emit("message", {
    id: replacement.messages[0]!.id,
    result: { version: 1, text: "replacement ready" },
  });
  expect(await retry).toEqual({ version: 1, text: "replacement ready" });
});
