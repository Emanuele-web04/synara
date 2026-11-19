import { expect, test } from "./synbot.ts";

test("SynBot answers a quick question in its own chat", async ({ synbot, screen, app }) => {
  synbot.script({
    rules: [{ match: "PING-ANSWER", steps: [{ say: "PONG from the scripted SynBot." }] }],
    fallback: [{ say: "SILENT" }],
  });
  await synbot.open();
  await expect(screen.getByRole("button", "New bot")).toBeVisible();
  await synbot.send("PING-ANSWER please reply");

  await expect(screen.getByText("PONG from the scripted SynBot.")).toBeVisible({ timeout: 60_000 });
  const prompt = (await synbot.waitForLog((entry) => entry.event === "prompt"))[0]!;
  expect(prompt.text).toContain("PING-ANSWER");
  await app.screenshot("main-answer");
});
