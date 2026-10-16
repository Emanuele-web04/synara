import { createHash } from "node:crypto";
import { writeCodeOssNotices } from "./code-oss-notices.mjs";
import { createRequire } from "node:module";
import { readFile, mkdir, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = process.env.SYNARA_CODE_OSS_SOURCE;
const output = path.resolve(
  process.env.SYNARA_CODE_OSS_OUTPUT ?? path.join(root, "apps/server/dist/code-oss"),
);
const commit = "7debcd0e2acdea1c52de81bf9ee1620444407dda";
const version = "1.138.0";
if (!source || !path.isAbsolute(source))
  throw new Error("SYNARA_CODE_OSS_SOURCE must identify the verified upstream checkout.");
const upstream = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
if (upstream.version !== version)
  throw new Error("Upstream API version does not match the pinned host adapter.");
const require = createRequire(import.meta.url);
const builder = process.env.SYNARA_ESBUILD_MODULE ?? require.resolve("esbuild");
const { build } = await import(builder);
await mkdir(output, { recursive: true });
const entry = path.join(root, "apps/server/src/extensions/host/entry.mjs");
const result = await build({
  entryPoints: [entry],
  outfile: path.join(output, "extension-host.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  sourcemap: false,
  metafile: true,
  tsconfigRaw: {
    compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false },
  },
  nodePaths: [path.join(source, "node_modules")],
  banner: {
    js: 'import { createRequire as __synaraCreateRequire } from "node:module"; const require = __synaraCreateRequire(import.meta.url);',
  },
  external: [
    "@vscode/windows-ca-certs",
    "@vscode/spdlog",
    "@vscode/windows-process-tree",
    "@vscode/windows-mutex",
    "@vscode/windows-registry",
    "@vscode/native-watchdog",
    "@vscode/deviceid",
    "@vscode/vsce-sign",
    "native-keymap",
    "native-is-elevated",
    "node-pty",
    "kerberos",
    "electron",
    "@vscode/sqlite3",
  ],
  plugins: [
    {
      name: "pinned-code-oss",
      setup(builder) {
        builder.onResolve({ filter: /^@code-oss\// }, ({ path: specifier }) => ({
          path: path.join(
            source,
            "src",
            specifier.slice("@code-oss/".length).replace(/\.js$/, ".ts"),
          ),
        }));
        builder.onLoad(
          { filter: /[\\/]extHostDiskFileSystemProvider\.ts$/ },
          async ({ path: filename }) => {
            const contents = await readFile(filename, "utf8");
            const expected =
              "extHostConsumerFileSystem.addFileSystemProvider(Schemas.file, new DiskFileSystemProviderAdapter(logService), { isCaseSensitive: isLinux });";
            if (contents.split(expected).length !== 2)
              throw new Error(
                "Upstream local filesystem optimization changed; review the document-writer boundary.",
              );
            // All VS Code file operations retain the MainThreadFileSystem RPC path.
            // OS sandboxing must separately block direct node:fs workspace writes.
            return {
              contents: contents.replace(
                expected,
                "// Synara brokers file operations through MainThreadFileSystem.",
              ),
              loader: "ts",
            };
          },
        );
      },
    },
  ],
});
await copyFile(path.join(source, "LICENSE.txt"), path.join(output, "CODE-OSS-LICENSE.txt"));
await writeFile(
  path.join(output, "package.json"),
  JSON.stringify({ private: true, type: "module", version }, null, 2) + "\n",
);
await writeCodeOssNotices(Object.keys(result.metafile.inputs), source, output);
const bundle = await readFile(path.join(output, "extension-host.mjs"));
await writeFile(
  path.join(output, "runtime.json"),
  JSON.stringify(
    {
      commit,
      version,
      sha256: createHash("sha256").update(bundle).digest("hex"),
      bytes: bundle.length,
      entry: "extension-host.mjs",
      upstreamFiles: Object.keys(result.metafile.inputs).filter((file) => file.includes("/vs/"))
        .length,
      patches: [
        "Disable the local file-provider optimization; preserve the authoritative Synara document writer.",
      ],
    },
    null,
    2,
  ) + "\n",
);
console.log(await readFile(path.join(output, "runtime.json"), "utf8"));
