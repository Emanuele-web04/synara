#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const packageRoot = path.resolve(repoRoot, "..");
const defaultOutDir = path.join(repoRoot, "dist", "private-package");
const appBundleName = "Wandy.app";
const appExecutableName = "Wandy";
const privatePackageName = "@t3tools/wandy";
const runtimeTargets = [
  {
    os: "darwin",
    cpu: "arm64",
    kind: "macos-app",
    executablePath: ["dist", appBundleName, "Contents", "MacOS", appExecutableName],
  },
  {
    os: "linux",
    cpu: "arm64",
    kind: "binary",
    buildArch: "arm64",
    executablePath: ["dist", "linux", "arm64", "wandy"],
  },
  {
    os: "linux",
    cpu: "x64",
    kind: "binary",
    buildArch: "amd64",
    executablePath: ["dist", "linux", "amd64", "wandy"],
  },
  {
    os: "win32",
    cpu: "arm64",
    kind: "binary",
    buildArch: "arm64",
    executablePath: ["dist", "windows", "arm64", "wandy.exe"],
  },
  {
    os: "win32",
    cpu: "x64",
    kind: "binary",
    buildArch: "amd64",
    executablePath: ["dist", "windows", "amd64", "wandy.exe"],
  },
];

function parseArgs(argv) {
  const options = {
    arch: "universal",
    configuration: "release",
    outDir: defaultOutDir,
    skipBuild: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case "--arch":
        options.arch = argv[index + 1];
        index += 1;
        break;
      case "--configuration":
        options.configuration = argv[index + 1];
        index += 1;
        break;
      case "--out-dir":
        options.outDir = path.resolve(repoRoot, argv[index + 1]);
        index += 1;
        break;
      case "--skip-build":
        options.skipBuild = true;
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  process.stdout.write(`Usage: node ./scripts/npm/build-packages.mjs [options]

Build a private Synara package staging directory for ${privatePackageName}.
This script never publishes to npmjs.org.

Options:
  --configuration debug|release
  --arch native|arm64|x86_64|universal  macOS app build arch. Defaults to universal.
  --out-dir <dir>
  --skip-build
`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`,
    );
  }
}

function readJSON(filePath) {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

function removeJunkFiles(targetPath) {
  if (!existsSync(targetPath)) {
    return;
  }

  const entryStat = statSync(targetPath);
  if (entryStat.isDirectory()) {
    for (const entry of readdirSync(targetPath)) {
      removeJunkFiles(path.join(targetPath, entry));
    }
    return;
  }

  if (path.basename(targetPath) === ".DS_Store") {
    unlinkSync(targetPath);
  }
}

function ensureBuilt(configuration, arch) {
  run(path.join(repoRoot, "scripts", "build-wandy-app.sh"), [
    "--configuration",
    configuration,
    "--arch",
    arch,
  ]);

  for (const buildArch of ["arm64", "amd64"]) {
    run(path.join(repoRoot, "scripts", "build-wandy-linux.sh"), [
      "--configuration",
      configuration,
      "--arch",
      buildArch,
    ]);
    run(path.join(repoRoot, "scripts", "build-wandy-windows.sh"), [
      "--configuration",
      configuration,
      "--arch",
      buildArch,
    ]);
  }
}

function writeExecutable(filePath, content) {
  writeFileSync(filePath, content, "utf-8");
  chmodSync(filePath, 0o755);
}

function platformLaunchTable() {
  return Object.fromEntries(
    runtimeTargets.map((runtimeTarget) => [
      `${runtimeTarget.os}-${runtimeTarget.cpu}`,
      {
        executablePath: runtimeTarget.executablePath,
      },
    ]),
  );
}

function renderMcpLauncherDelegate() {
  return `#!/usr/bin/env node
// Delegates to the wandy launcher, defaulting to the stdio MCP server so MCP
// clients can configure \`wandy-mcp\` as their command without arguments.
if (process.argv.length <= 2) {
  process.argv.push("mcp");
}
require("./wandy");
`;
}

function renderLauncher() {
  return `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const platformPackages = ${JSON.stringify(platformLaunchTable(), null, 2)};
const packageRoot = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const command = args[0] || "";
const installCommands = new Map([
  ["install-claude-mcp", "install-claude-mcp.sh"],
  ["install-clauce-mcp", "install-claude-mcp.sh"],
  ["install-gemini-mcp", "install-gemini-mcp.sh"],
  ["install-codex-mcp", "install-codex-mcp.sh"],
  ["install-opencode-mcp", "install-opencode-mcp.sh"],
  ["install-codex-plugin", "install-codex-plugin.sh"],
]);

function printLauncherHelp() {
  console.log(\`Wandy

Usage:
  wandy [command] [options]
  wandy

Commands:
  mcp                  Start the stdio MCP server.
  doctor               Print permission status and launch onboarding if needed on macOS.
  list-apps            Print running or recently used apps.
  snapshot <app>       Print the current accessibility snapshot for an app.
  call <tool>          Call one tool, or run a JSON array of tool calls.
  turn-ended           Notify the running MCP process that the host turn ended.
  install-claude-mcp   Install the MCP server into ~/.claude.json for this project.
  install-gemini-mcp   Install the MCP server into Gemini CLI config.
  install-codex-mcp    Install the MCP server into ~/.codex/config.toml.
  install-opencode-mcp Install the MCP server into ~/.config/opencode.
  install-codex-plugin Install this private package into the local Codex plugin cache.
  help [command]       Show general or command-specific help.
  version              Print the CLI version.

Global options:
  -h, --help           Show help.
  -v, --version        Show version.\`);
}

function printInstallHelp(scriptName, usage) {
  console.log(\`Usage:
  \${usage}

This helper updates a local MCP or plugin config to run:
  wandy mcp

Script:
  \${scriptName}\`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function spawnAndExit(executable, executableArgs) {
  const child = spawn(executable, executableArgs, {
    stdio: "inherit",
    windowsHide: false,
  });

  child.on("error", (error) => {
    fail(\`Failed to start \${executable}: \${error.message}\`);
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      child.kill(signal);
    });
  }

  child.on("exit", (code, signal) => {
    if (signal) {
      process.exit(1);
    }
    process.exit(code ?? 0);
  });
}

function runInstallCommand(scriptName, scriptArgs) {
  if (process.platform === "win32") {
    fail(\`\${command} currently requires a POSIX shell. Configure your MCP client with command "wandy" and args ["mcp"] on Windows.\`);
  }

  const scriptPath = path.join(packageRoot, "scripts", scriptName);
  if (!fs.existsSync(scriptPath)) {
    fail(\`Missing installer helper at \${scriptPath}.\`);
  }

  spawnAndExit(scriptPath, scriptArgs);
}

function resolveNativeExecutable() {
  const platformKey = \`\${process.platform}-\${process.arch}\`;
  const target = platformPackages[platformKey];
  if (!target) {
    const supported = Object.keys(platformPackages).sort().join(", ");
    fail(\`Unsupported platform \${platformKey}. Supported platforms: \${supported}.\`);
  }

  const executablePath = path.join(packageRoot, ...target.executablePath);
  if (!fs.existsSync(executablePath)) {
    fail(\`Missing bundled native runtime for \${platformKey} at \${executablePath}.

Rebuild the private Synara package with:
  bun --cwd packages/wandy run build:macos\`);
  }

  return executablePath;
}

if (command === "-h" || command === "--help" || (command === "help" && args.length <= 1)) {
  printLauncherHelp();
  process.exit(0);
}

if (command === "help" && args[1] === "install-codex-plugin") {
  printInstallHelp("install-codex-plugin.sh", "wandy install-codex-plugin");
  process.exit(0);
}

if (command === "help" && args[1] === "install-codex-mcp") {
  printInstallHelp("install-codex-mcp.sh", "wandy install-codex-mcp");
  process.exit(0);
}

if (command === "help" && args[1] === "install-gemini-mcp") {
  printInstallHelp("install-gemini-mcp.sh", "wandy install-gemini-mcp [--scope project|user]");
  process.exit(0);
}

if (command === "help" && args[1] === "install-opencode-mcp") {
  printInstallHelp("install-opencode-mcp.sh", "wandy install-opencode-mcp");
  process.exit(0);
}

if (command === "help" && (args[1] === "install-claude-mcp" || args[1] === "install-clauce-mcp")) {
  printInstallHelp("install-claude-mcp.sh", "wandy install-claude-mcp");
  process.exit(0);
}

if (installCommands.has(command)) {
  const scriptName = installCommands.get(command);
  runInstallCommand(scriptName, args.slice(1));
} else {
  spawnAndExit(resolveNativeExecutable(), args);
}
`;
}

function renderPostinstall(packageName, version) {
  return `#!/usr/bin/env node
const lines = [
  "",
  "Installed ${packageName}@${version}.",
  "This is Synara's private Wandy runtime package.",
  "It is not published to npmjs.org and should be consumed only from the Synara workspace or private artifact store.",
  "",
];
for (const line of lines) {
  console.log(line);
}
`;
}

function renderReadme(packageName, version) {
  return `# ${packageName}

Synara's private desktop automation runtime for Wandy.

This package bundles the native Wandy runtime and exposes the local \`wandy\` / \`wandy-mcp\` commands used by Synara's MCP integration. It is intentionally marked \`private: true\` and is not a public npm package.

## Supported Runtime Targets

${runtimeTargets.map((runtimeTarget) => `- \`${runtimeTarget.os}-${runtimeTarget.cpu}\``).join("\n")}

## Local Use

\`\`\`bash
wandy --version
wandy --help
wandy mcp
wandy doctor
\`\`\`

## MCP Config Shape

\`\`\`json
{
  "mcpServers": {
    "wandy": {
      "command": "wandy",
      "args": ["mcp"]
    }
  }
}
\`\`\`

## Release Boundary

- Package name: \`${packageName}\`
- Version: \`${version}\`
- Distribution: Synara workspace/private artifact only
- Public npm publish path: disabled
- GitHub release workflow: disabled
`;
}

function renderMetaPackageJson(packageName, version) {
  return {
    name: packageName,
    version,
    private: true,
    description: "Synara's private desktop automation runtime for Wandy.",
    license: "MIT",
    keywords: ["computer-use", "codex", "mcp", "desktop-automation", "synara"],
    bin: {
      wandy: "bin/wandy",
      "wandy-mcp": "bin/wandy-mcp",
    },
    scripts: {
      postinstall: "node ./scripts/postinstall.mjs",
    },
    files: [
      ".agents/plugins/marketplace.json",
      "bin/",
      "dist/Wandy.app/",
      "dist/linux/",
      "dist/windows/",
      "plugins/wandy/.codex-plugin/",
      "plugins/wandy/.mcp.json",
      "plugins/wandy/assets/",
      "plugins/wandy/scripts/",
      "scripts/install-claude-mcp.sh",
      "scripts/install-gemini-mcp.sh",
      "scripts/install-config-helper.mjs",
      "scripts/install-codex-mcp.sh",
      "scripts/install-opencode-mcp.sh",
      "scripts/install-codex-plugin.sh",
      "scripts/postinstall.mjs",
      "README.md",
      "LICENSE",
      "NOTICES.md",
    ],
  };
}

function copyInstallerScripts(stagedPackageRoot) {
  cpSync(
    path.join(repoRoot, "scripts", "install-claude-mcp.sh"),
    path.join(stagedPackageRoot, "scripts", "install-claude-mcp.sh"),
  );
  cpSync(
    path.join(repoRoot, "scripts", "install-gemini-mcp.sh"),
    path.join(stagedPackageRoot, "scripts", "install-gemini-mcp.sh"),
  );
  cpSync(
    path.join(repoRoot, "scripts", "install-config-helper.mjs"),
    path.join(stagedPackageRoot, "scripts", "install-config-helper.mjs"),
  );
  cpSync(
    path.join(repoRoot, "scripts", "install-codex-mcp.sh"),
    path.join(stagedPackageRoot, "scripts", "install-codex-mcp.sh"),
  );
  cpSync(
    path.join(repoRoot, "scripts", "install-opencode-mcp.sh"),
    path.join(stagedPackageRoot, "scripts", "install-opencode-mcp.sh"),
  );
  cpSync(
    path.join(repoRoot, "scripts", "install-codex-plugin.sh"),
    path.join(stagedPackageRoot, "scripts", "install-codex-plugin.sh"),
  );

  for (const scriptName of [
    "install-claude-mcp.sh",
    "install-gemini-mcp.sh",
    "install-codex-mcp.sh",
    "install-opencode-mcp.sh",
    "install-codex-plugin.sh",
  ]) {
    chmodSync(path.join(stagedPackageRoot, "scripts", scriptName), 0o755);
  }
}

function assertFileExists(filePath, packageName) {
  if (!existsSync(filePath)) {
    throw new Error(
      `Missing artifact for ${packageName}: ${filePath}. Run without --skip-build first.`,
    );
  }
}

function copyBundledRuntimes(stagedPackageRoot, packageName) {
  const distRoot = path.join(stagedPackageRoot, "dist");
  mkdirSync(distRoot, { recursive: true });

  const macosSourcePath = path.join(repoRoot, "dist", appBundleName);
  const macosDestinationPath = path.join(distRoot, appBundleName);
  assertFileExists(macosSourcePath, packageName);
  cpSync(macosSourcePath, macosDestinationPath, { recursive: true });

  for (const platformDir of ["linux", "windows"]) {
    const sourcePath = path.join(repoRoot, "dist", platformDir);
    const destinationPath = path.join(distRoot, platformDir);
    assertFileExists(sourcePath, packageName);
    cpSync(sourcePath, destinationPath, { recursive: true });
  }

  for (const runtimeTarget of runtimeTargets) {
    const executablePath = path.join(stagedPackageRoot, ...runtimeTarget.executablePath);
    assertFileExists(executablePath, packageName);
    if (runtimeTarget.kind !== "macos-app") {
      chmodSync(executablePath, 0o755);
    }
  }
}

function stagePrivatePackage(packageName, version, outDir) {
  const stagedPackageRoot = path.join(outDir, packageName.replace("/", "__"));
  rmSync(stagedPackageRoot, { recursive: true, force: true });

  mkdirSync(path.join(stagedPackageRoot, ".agents", "plugins"), { recursive: true });
  mkdirSync(path.join(stagedPackageRoot, "bin"), { recursive: true });
  mkdirSync(path.join(stagedPackageRoot, "dist"), { recursive: true });
  mkdirSync(path.join(stagedPackageRoot, "plugins"), { recursive: true });
  mkdirSync(path.join(stagedPackageRoot, "scripts"), { recursive: true });

  cpSync(
    path.join(repoRoot, ".agents", "plugins", "marketplace.json"),
    path.join(stagedPackageRoot, ".agents", "plugins", "marketplace.json"),
  );
  cpSync(
    path.join(repoRoot, "plugins", "wandy"),
    path.join(stagedPackageRoot, "plugins", "wandy"),
    {
      recursive: true,
    },
  );
  cpSync(path.join(packageRoot, "LICENSE"), path.join(stagedPackageRoot, "LICENSE"));
  cpSync(path.join(packageRoot, "NOTICES.md"), path.join(stagedPackageRoot, "NOTICES.md"));
  copyBundledRuntimes(stagedPackageRoot, packageName);
  copyInstallerScripts(stagedPackageRoot);

  const launcher = renderLauncher();
  writeExecutable(path.join(stagedPackageRoot, "bin", "wandy"), launcher);
  writeExecutable(path.join(stagedPackageRoot, "bin", "wandy-mcp"), renderMcpLauncherDelegate());
  writeFileSync(
    path.join(stagedPackageRoot, "scripts", "postinstall.mjs"),
    renderPostinstall(packageName, version),
    "utf-8",
  );
  writeFileSync(
    path.join(stagedPackageRoot, "README.md"),
    renderReadme(packageName, version),
    "utf-8",
  );
  writeFileSync(
    path.join(stagedPackageRoot, "package.json"),
    `${JSON.stringify(renderMetaPackageJson(packageName, version), null, 2)}\n`,
    "utf-8",
  );

  removeJunkFiles(stagedPackageRoot);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { version } = readJSON(path.join(packageRoot, "package.json"));

  if (!options.skipBuild) {
    ensureBuilt(options.configuration, options.arch);
  }

  rmSync(options.outDir, { recursive: true, force: true });
  mkdirSync(options.outDir, { recursive: true });

  stagePrivatePackage(privatePackageName, version, options.outDir);

  process.stdout.write(`${options.outDir}\n`);
}

main();
