import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as Path from "node:path";
import { expect, it, vi } from "vitest";

const home = vi.hoisted(() => ({ path: "" }));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  homedir: () => home.path,
}));
const { importMcpServerCandidates } = await import("./importServers.ts");

it("discovers user/project Claude, Codex, workspace and Desktop servers without running them", async () => {
  home.path = await mkdtemp(Path.join(tmpdir(), "synara-import-mcp-"));
  const workspace = Path.join(home.path, "project");
  try {
    await mkdir(workspace);
    await mkdir(Path.join(home.path, ".codex"));
    const desktop =
      process.platform === "darwin"
        ? "Library/Application Support/Claude"
        : process.platform === "win32"
          ? "AppData/Roaming/Claude"
          : ".config/Claude";
    await mkdir(Path.join(home.path, desktop), { recursive: true });
    if (process.platform === "win32")
      vi.stubEnv("APPDATA", Path.join(home.path, "AppData/Roaming"));
    await writeFile(
      Path.join(home.path, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          paper: { command: "~/.paper/bin/paper", args: ["mcp"], env: { PAPER_TOKEN: "secret" } },
        },
        projects: {
          [workspace]: { mcpServers: { habits: { url: "http://127.0.0.1:3000/mcp" } } },
          "/unrelated": { mcpServers: { hidden: { command: "no", args: [] } } },
        },
      }),
    );
    await writeFile(
      Path.join(home.path, ".codex/config.toml"),
      '[mcp_servers.docs]\nurl="https://docs.example.com/mcp"\n',
    );
    await writeFile(
      Path.join(workspace, ".mcp.json"),
      JSON.stringify({ mcpServers: { project: { command: "node", args: ["server.mjs"] } } }),
    );
    await writeFile(
      Path.join(home.path, desktop, "claude_desktop_config.json"),
      JSON.stringify({ mcpServers: { desktop: { command: "desktop", args: [] } } }),
    );
    const result = await importMcpServerCandidates(workspace);
    expect(result.candidates.map((entry) => entry.input.name)).toEqual([
      "paper",
      "habits",
      "docs",
      "desktop",
      "project",
    ]);
    expect(result.candidates[0]?.input).toMatchObject({
      command: Path.join(home.path, ".paper/bin/paper"),
      args: ["mcp"],
      env: { PAPER_TOKEN: "secret" },
    });
    expect(result.candidates.at(-1)?.input).toMatchObject({ cwd: workspace });
    expect(result.warnings).toEqual([]);
  } finally {
    vi.unstubAllEnvs();
    await rm(home.path, { recursive: true, force: true });
  }
});
