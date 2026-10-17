import { parentPort, workerData } from "node:worker_threads";
import { createTypeScriptService } from "./typescriptService.ts";
import type { EditorIntelligenceInput } from "@synara/contracts";

if (!parentPort) throw new Error("Language services must run in a worker.");
const service = createTypeScriptService(workerData.root as string);
parentPort.on("message", ({ id, input }: { id: number; input: EditorIntelligenceInput }) => {
  try {
    parentPort!.postMessage({ id, result: service.request(input) });
  } catch (error) {
    parentPort!.postMessage({
      id,
      error: error instanceof Error ? error.message : "Language service failed.",
    });
  }
});
parentPort.on("close", () => service.dispose());
