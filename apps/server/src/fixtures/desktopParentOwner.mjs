import { spawn } from "node:child_process";

const [fixture, dbPath, statePath, mode] = process.argv.slice(2);
const backend = spawn(process.execPath, [fixture, dbPath, statePath, mode], {
  env: { ...process.env, SYNARA_DESKTOP_PARENT_STDIN: "1" },
  stdio: ["pipe", "ignore", "pipe"],
});
backend.stderr.pipe(process.stderr);
backend.on("exit", (code, signal) => process.send?.({ code, signal }));
process.on("message", (message) => {
  if (message === "close") backend.stdin.end();
});
