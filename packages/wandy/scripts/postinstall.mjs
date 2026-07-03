#!/usr/bin/env node
const mcpConfig = {
  mcpServers: {
    wandy: {
      command: "wandy",
      args: ["mcp"],
    },
  },
};
const lines = [
  "",
  "Installed wandy@0.1.52.",
  "This is Synara's private Wandy runtime package.",
  "Commands: wandy, wandy-mcp",
  "Native runtime will be selected from bundled artifacts for " +
    process.platform +
    "-" +
    process.arch +
    ".",
  "",
  "Next for local development:",
  "1. Run wandy --version",
  "2. On macOS, Wandy opens its permission window automatically when approval is needed",
  "",
  "Synara MCP config shape:",
  JSON.stringify(mcpConfig, null, 2),
  "",
];
for (const line of lines) {
  console.log(line);
}
