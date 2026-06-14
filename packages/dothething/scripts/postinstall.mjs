#!/usr/bin/env node
const mcpConfig = {
  mcpServers: {
    dothething: {
      command: "dothething",
      args: ["mcp"],
    },
  },
};
const lines = [
  "",
  "Installed dothething@0.1.52.",
  "This is Synara's private Do The Thing runtime package.",
  "Commands: dothething, dothething-mcp",
  "Native runtime will be selected from bundled artifacts for " +
    process.platform +
    "-" +
    process.arch +
    ".",
  "",
  "Next for local development:",
  "1. Run dothething --version",
  "2. On macOS, Do The Thing opens its permission window automatically when approval is needed",
  "",
  "Synara MCP config shape:",
  JSON.stringify(mcpConfig, null, 2),
  "",
];
for (const line of lines) {
  console.log(line);
}
