import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createServer } from "vite";

// Measure the actual Vite transform pipeline without browser/network/backend
// time or speculative transforms. Each invalidation models retransforming an
// edited module, not end-to-end HMR latency. Run variants serially.
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--compiler")) {
  throw new Error("Usage: node scripts/measure-dev-transforms.mjs [--compiler]");
}
process.env.SYNARA_DEV_REACT_COMPILER = args.includes("--compiler") ? "1" : "0";
const root = fileURLToPath(new URL("..", import.meta.url));
process.chdir(root);
const files = [
  "/src/main.tsx",
  "/src/routes/__root.tsx",
  "/src/components/ChatView.tsx",
  "/src/components/chat/SingleChatSurface.tsx",
  "/src/components/chat/MessagesTimeline.tsx",
];
const startedAt = performance.now();
const server = await createServer({
  root,
  configFile: path.join(root, "vite.config.ts"),
  mode: "development",
  logLevel: "error",
  server: {
    host: "127.0.0.1",
    port: 0,
    strictPort: false,
    watch: null,
    preTransformRequests: false,
  },
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  await server.listen();
  const initializedMs = performance.now() - startedAt;
  const results = [];
  for (const file of files) {
    const timesMs = [];
    for (let run = 0; run < 4; run += 1) {
      const module = await server.moduleGraph.getModuleByUrl(file);
      if (module) server.moduleGraph.invalidateModule(module);
      const start = performance.now();
      const result = await server.transformRequest(file);
      if (!result) throw new Error(`No transform result for ${file}`);
      timesMs.push(performance.now() - start);
    }
    results.push({ file, initialMs: timesMs[0], retransformMs: timesMs.slice(1) });
  }
  console.log(
    JSON.stringify(
      {
        revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).length > 0,
        node: process.version,
        platform: `${os.platform()} ${os.release()} ${os.arch()}`,
        cpu: os.cpus()[0]?.model,
        compiler: server.config.plugins.some((plugin) => plugin.name === "@rolldown/plugin-babel"),
        initializedMs,
        results,
      },
      null,
      2,
    ),
  );
} finally {
  await server.close();
}
