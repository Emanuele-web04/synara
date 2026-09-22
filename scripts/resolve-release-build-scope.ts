import { appendFileSync } from "node:fs";
import { resolveReleaseBuildScope } from "./lib/release-build-scope.ts";

const scope = resolveReleaseBuildScope(
  process.env.BUILD_PLATFORM || "all",
  process.env.BUILD_STAGE || "artifact",
  process.env.PUBLISH_RELEASE === "true",
);
if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required.");
for (const [key, value] of Object.entries(scope))
  appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${JSON.stringify(value)}\n`);
