import * as nodeFs from "node:fs";
import * as nodePath from "node:path";

import { RUN_DIR } from "../paths.ts";
import { expect, test } from "./synbot.ts";

test("A bot proposal card creates the bot", async ({ synbot, screen, app }) => {
  const name = `Docs ${Date.now() % 100000}`;
  synbot.script({
    rules: [
      {
        match: "You are SynBot, the main SynBot bot.*PROPOSE-1",
        steps: [
          {
            tool: "synara_bot_propose",
            args: { name, role: "Writes and fixes docs", reason: "You asked for docs help." },
          },
          { say: "I proposed a docs bot." },
        ],
      },
    ],
    fallback: [{ say: "SILENT" }],
  });
  await synbot.open();
  await synbot.send("PROPOSE-1 I need a docs bot");
  // Earlier tests leave answered proposals in SynBot's chat, their pick still reading "Create
  // bot": wait for this proposal's card, the newest, before taking its button.
  await expect(screen.getByText(`Save "${name}" as a bot?`)).toBeVisible({ timeout: 60_000 });
  const create = screen.getByText("Create bot", { exact: true }).last();
  await expect(create).toBeVisible({ timeout: 60_000 });
  await app.screenshot("proposal-card");
  await create.tap();
  await expect(screen.getByRole("navigation", "My bots").getByText(name).first()).toBeVisible({
    timeout: 30_000,
  });
  await app.screenshot("proposal-created");
  const { bots } = await synbot.bots();
  expect(bots.map((b) => b.name)).toContain(name);
});

test("Adding a non-git folder offers to make it a repository", async ({ synbot, screen, app }) => {
  const folder = nodePath.join(RUN_DIR, `plain-folder-${Date.now()}`);
  nodeFs.mkdirSync(folder, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(folder, "notes.md"), "# notes\n");
  synbot.script({
    rules: [
      {
        match: "You are SynBot, the main SynBot bot.*ADDPROJ-1",
        steps: [
          { tool: "synara_bot_add_project", args: { path: folder } },
          { say: "That folder is not a repository yet." },
        ],
      },
    ],
    fallback: [{ say: "SILENT" }],
  });
  await synbot.open();
  await synbot.send("ADDPROJ-1 add my notes folder");
  const make = screen.getByText("Make it a repository", { exact: true }).last();
  await expect(make).toBeVisible({ timeout: 60_000 });
  await app.screenshot("git-init-card");
  await make.tap();
  await expect
    .poll(() => nodeFs.existsSync(nodePath.join(folder, ".git")), { timeout: 30_000 })
    .toBe(true);
  await app.screenshot("git-init-done");
});
