import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import * as Path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { McpConnectorConnectInput } from "@synara/contracts";
import { normalizeConnectorInput } from "./config.ts";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Read only known configuration locations; discovery never executes commands. */
export async function importMcpServerCandidates(workspace: string | null) {
  const home = homedir();
  const desktop =
    process.platform === "darwin"
      ? Path.join(home, "Library/Application Support/Claude/claude_desktop_config.json")
      : process.platform === "win32"
        ? Path.join(
            process.env.APPDATA ?? Path.join(home, "AppData/Roaming"),
            "Claude/claude_desktop_config.json",
          )
        : Path.join(home, ".config/Claude/claude_desktop_config.json");
  const sources = [
    { path: Path.join(home, ".claude.json"), label: "Claude Code", toml: false },
    { path: Path.join(home, ".codex/config.toml"), label: "Codex", toml: true },
    { path: desktop, label: "Claude Desktop", toml: false },
    ...(workspace
      ? [{ path: Path.join(workspace, ".mcp.json"), label: "Workspace .mcp.json", toml: false }]
      : []),
  ];
  const candidates: Array<{ input: McpConnectorConnectInput; source: string }> = [];
  const warnings: string[] = [];
  for (const source of sources) {
    let parsed: Record<string, unknown>;
    try {
      if ((await stat(source.path)).size > 1024 * 1024) {
        warnings.push(`${source.label}: config exceeds 1 MiB.`);
        continue;
      }
      const text = await readFile(source.path, "utf8");
      parsed = record(source.toml ? parseToml(text) : JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        warnings.push(`${source.label}: could not read the config.`);
      continue;
    }
    const scopes = [
      {
        servers: record(parsed[source.toml ? "mcp_servers" : "mcpServers"]),
        label: source.label,
        cwd: home,
      },
    ];
    if (source.label === "Workspace .mcp.json" && workspace) scopes[0]!.cwd = workspace;
    if (source.label === "Claude Code" && workspace) {
      const project = record(record(parsed.projects)[workspace]);
      scopes.push({
        servers: record(project.mcpServers),
        label: "Claude Code project",
        cwd: workspace,
      });
    }
    for (const scope of scopes)
      for (const [name, raw] of Object.entries(scope.servers)) {
        if (candidates.length >= 60) {
          warnings.push("Import is limited to 60 servers at a time.");
          return { candidates, warnings };
        }
        const config = record(raw);
        if (config.disabled === true || config.enabled === false) continue;
        try {
          if (
            config.headers ||
            config.http_headers ||
            config.env_http_headers ||
            config.bearer_token_env_var
          )
            throw new Error("unsupported credentials");
          const input = normalizeConnectorInput(
            typeof config.command === "string"
              ? {
                  name,
                  command: config.command,
                  args: config.args ?? [],
                  ...(config.env ? { env: config.env } : {}),
                  ...(config.cwd ? { cwd: config.cwd } : {}),
                }
              : { name, url: config.url },
            scope.cwd,
          );
          candidates.push({ input, source: scope.label });
        } catch {
          warnings.push(`${scope.label}: skipped a server with unsupported or invalid settings.`);
        }
      }
  }
  return { candidates, warnings };
}
