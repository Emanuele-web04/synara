// Fresh process for every mode/sample. Production optimized key function.
// node --expose-gc .../opencode-snapshot-key-memory.mjs baseline|optimized
import { randomBytes } from "node:crypto";
import { openCodeSnapshotKey } from "../../../apps/server/src/provider/openCodeMessageState.ts";

if (!globalThis.gc) throw new Error("Run with --expose-gc");
const mode = process.argv[2];
if (!["baseline", "optimized"].includes(mode)) throw new Error("Expected baseline or optimized");
const gcHeap = () => {
  globalThis.gc();
  globalThis.gc();
  return process.memoryUsage().heapUsed;
};
const emptyHeap = gcHeap();
const parts = Array.from({ length: 200 }, (_, index) => ({
  id: `part-${index}`,
  messageID: `message-${index}`,
  type: "tool",
  state: { status: "completed", output: randomBytes(128 * 1024).toString("hex") },
}));
const payloadHeap = gcHeap();
const started = performance.now();
const keys = new Map(
  parts.map((part) => [
    part.id,
    mode === "baseline" ? JSON.stringify(part) : openCodeSnapshotKey(part),
  ]),
);
const keyCreationMs = performance.now() - started;
globalThis.retainedBenchmarkState = { parts, keys };
const retainedHeap = gcHeap();
console.log(
  JSON.stringify(
    {
      mode,
      node: process.version,
      partCount: parts.length,
      outputBytesPerPart: 256 * 1024,
      keyCharacters: [...keys.values()].reduce((total, key) => total + key.length, 0),
      retainedPayloadHeapBytes: payloadHeap - emptyHeap,
      retainedKeyHeapBytes: retainedHeap - payloadHeap,
      totalRetainedHeapBytes: retainedHeap - emptyHeap,
      keyCreationMs,
      memory: process.memoryUsage(),
    },
    null,
    2,
  ),
);
