#!/usr/bin/env node
// Prepares what the measurements need, outside the repository:
//   node benchmarks/desktop-perf/prepare.mjs --ref origin/main [--name main] [--templates] [--template-set default]
// --ref        git ref to check out and build under ~/synara-perf-bench/builds/<name>
// --templates     (re)create the empty and seeded data-home templates with that build
// --template-set  name of the template set to create (default "default"); builds with an
//                 older database schema need a set created by a build of that schema
// --realistic     also seed the long threads of seed-realistic-threads.ts (use a separate
//                 template set, e.g. "longchat", so the default set stays comparable)
import { buildName, createTemplates, prepareBuild, useTemplateSet } from "./lib/builds.mjs";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const ref = value("ref");
if (!ref) {
  console.error("usage: prepare.mjs --ref <git ref> [--name <build name>] [--templates]");
  process.exit(1);
}
const build = prepareBuild(ref, value("name") ?? buildName(ref));
console.log(
  `[prepare] build ${build.name}: ${build.version} ${build.commit.slice(0, 12)} (${build.buildType})`,
);
if (args.includes("--templates")) {
  useTemplateSet(value("template-set") ?? "default");
  await createTemplates(build, {
    ...(args.includes("--realistic") ? { shape: { realisticThreads: true } } : {}),
  });
}
process.exit(0);
