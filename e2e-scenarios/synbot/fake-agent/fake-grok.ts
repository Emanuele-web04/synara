// Impersonates the Grok CLI for Synara: `--version`, `models`, and `... agent ... stdio`.
// Synara's Grok adapter needs nothing else (see GrokAcpSupport.ts / GrokAdapter.ts).
import { startFakeAgent } from "./fakeAcpAgent.ts";

const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("grok 0.0.1-fake\n");
  process.exit(0);
}

if (args[0] === "models") {
  process.stdout.write(
    ["Default model: grok-4.6", "", "Available models:", "- grok-4.6 (default)", ""].join("\n"),
  );
  process.exit(0);
}

if (args.includes("stdio")) {
  startFakeAgent({ agentName: "grok" });
} else {
  process.stderr.write(`fake grok: unsupported arguments ${JSON.stringify(args)}\n`);
  process.exit(2);
}
