// FILE: resolve-release-build-scope.ts
// Purpose: Passes validated flavor and platform scope to the release workflow.
import { appendFileSync } from "node:fs";
import { resolveReleaseBuildScope } from "./lib/release-build-scope.ts";

const flavor = process.env.DESKTOP_FLAVOR || "production";
if (flavor !== "production" && flavor !== "beta" && flavor !== "remote")
  throw new Error(`Unsupported release flavor: ${flavor}`);
const scope = resolveReleaseBuildScope(
  process.env.BUILD_PLATFORM || "all",
  process.env.BUILD_STAGE || "artifact",
  process.env.PUBLISH_RELEASE === "true",
  process.env.CUA_BENCHMARK_BASELINE || "",
  flavor,
);
if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required.");
for (const [key, value] of Object.entries(scope))
  appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${JSON.stringify(value)}\n`);
