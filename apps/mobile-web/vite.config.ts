import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));
const serviceWorkerPlaceholder = "__SYNARA_MOBILE_PRECACHE__";

function companionPwaPlugin(): Plugin {
  return {
    name: "synara-companion-pwa",
    apply: "build",
    generateBundle(_options, bundle) {
      const serviceWorker = Object.values(bundle).find(
        (entry) => entry.type === "chunk" && entry.name === "service-worker",
      );
      if (serviceWorker?.type !== "chunk") {
        this.error("The Synara Companion service worker was not emitted.");
        return;
      }

      const generatedShellAssets = Object.values(bundle)
        .filter(
          (entry) =>
            entry.fileName !== serviceWorker.fileName &&
            !entry.fileName.endsWith(".map") &&
            (entry.fileName.endsWith(".js") || entry.fileName.endsWith(".css")),
        )
        .map((entry) => `/mobile/${entry.fileName}`);
      const precache = [
        "/mobile/",
        "/mobile/manifest.webmanifest",
        "/mobile/icons/synara.svg",
        "/mobile/icons/synara-maskable.svg",
        "/mobile/icons/synara-192.png",
        "/mobile/icons/synara-512.png",
        "/mobile/icons/synara-maskable-192.png",
        "/mobile/icons/synara-maskable-512.png",
        "/mobile/icons/apple-touch-icon.png",
        ...generatedShellAssets,
      ];

      if (!serviceWorker.code.includes(serviceWorkerPlaceholder)) {
        this.error("The Synara Companion service worker precache marker is missing.");
        return;
      }
      serviceWorker.code = serviceWorker.code.replace(
        serviceWorkerPlaceholder,
        JSON.stringify(precache),
      );
    },
  };
}

export default defineConfig({
  root: rootDirectory,
  base: "/mobile/",
  plugins: [react(), companionPwaPlugin()],
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    port: Number(process.env.PORT ?? 5743),
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        main: path.resolve(rootDirectory, "index.html"),
        "service-worker": path.resolve(rootDirectory, "src/service-worker.ts"),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "service-worker" ? "sw.js" : "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
