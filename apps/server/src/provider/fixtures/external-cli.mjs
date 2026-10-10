import { createInterface } from "node:readline";
const mode = process.argv[2];
const basic = mode.startsWith("basic");
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const workspace = () => JSON.stringify({ cwd: process.cwd(), pwd: process.env.PWD });
if (basic) process.stdout.write("ready\n");
else send({ type: "session.hello", protocolVersion: 1, capabilityIds: [] });
createInterface({ input: process.stdin }).on("line", (line) => {
  if (basic) {
    process.stdout.write(`${workspace()}\n`, () => process.exit(mode === "basic-success" ? 0 : 3));
    return;
  }
  const command = JSON.parse(line);
  if (command.type !== "cli.command.turn.start") return;
  const { turnId } = command;
  if (mode === "structured-eof") {
    process.exit(0);
    return;
  }
  if (mode === "structured-failure") {
    send({ type: "turn.failed", turnId, message: "fixture refused the turn" });
    return;
  }
  send({ type: "turn.text", turnId: "foreign-turn", text: "wrong attribution" });
  send({ type: "turn.completed", turnId: "foreign-turn", stopReason: "end_turn" });
  send({ type: "turn.text", turnId, text: workspace() });
  send({ type: "turn.completed", turnId, stopReason: "end_turn" });
});
