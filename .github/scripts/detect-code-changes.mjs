// FILE: detect-code-changes.mjs
// Purpose: Decides inside each CI lane whether a change is docs-only, so no
//          lane waits for a separate filter job before it starts.
// Layer: First step after checkout in every heavy ci.yml lane.
// Usage: node .github/scripts/detect-code-changes.mjs  (writes code=true|false)

import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const IMAGE = /\.(png|jpg|jpeg|gif|svg|webp|ico)$/;

/**
 * Code-free paths: prose, doc images and marketing content. Directory rules
 * stay scoped to code-free trees: marketing ships .tsx under docs/ dirs and web
 * ships a .ts module under assets/, so only the root docs/ tree is excluded.
 * Runtime images stay on the code path because browser tests validate them.
 */
export function isDocsPath(path) {
  return (
    path.endsWith(".md") ||
    path.endsWith(".mdx") ||
    path.startsWith("docs/") ||
    path.startsWith("apps/marketing/content/") ||
    (path.startsWith(".github/") && IMAGE.test(path))
  );
}

/** True unless every changed path is code-free. An empty list proves nothing. */
export function hasCodeChanges(paths) {
  return paths.length === 0 || paths.some((path) => !isDocsPath(path));
}

const PAGE = 100;
const PULL_REQUEST_FILE_LIMIT = 3000;
const COMPARE_FILE_LIMIT = 300;

async function get(api, path, token) {
  const response = await fetch(`${api}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
  return response.json();
}

// A rename away from a code path is a code change, so both names count.
const names = (files) =>
  files.flatMap((file) =>
    file.previous_filename ? [file.filename, file.previous_filename] : [file.filename],
  );

/**
 * Changed paths for this event, or null when the list is unavailable or may be
 * truncated. Null always runs every lane.
 */
export async function changedPaths({ eventName, event, repository, api, token, request = get }) {
  if (eventName === "pull_request") {
    const paths = [];
    for (let page = 1; page <= PULL_REQUEST_FILE_LIMIT / PAGE; page += 1) {
      const files = await request(
        api,
        `/repos/${repository}/pulls/${event.pull_request.number}/files?per_page=${PAGE}&page=${page}`,
        token,
      );
      paths.push(...names(files));
      if (files.length < PAGE) return paths;
    }
    return null;
  }
  if (eventName === "push") {
    if (!event.before || /^0+$/.test(event.before) || event.forced) return null;
    const comparison = await request(
      api,
      `/repos/${repository}/compare/${event.before}...${event.after}?per_page=${PAGE}`,
      token,
    );
    const files = comparison.files ?? [];
    if (files.length >= COMPARE_FILE_LIMIT) return null;
    return names(files);
  }
  return null;
}

async function main() {
  const env = process.env;
  let code = true;
  try {
    const paths = await changedPaths({
      eventName: env.GITHUB_EVENT_NAME,
      event: JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")),
      repository: env.GITHUB_REPOSITORY,
      api: env.GITHUB_API_URL ?? "https://api.github.com",
      token: env.GITHUB_TOKEN,
    });
    if (paths === null) console.log("Changed files unavailable or truncated: running every lane.");
    else code = hasCodeChanges(paths);
  } catch (error) {
    // Never skip validation because the file list could not be read.
    console.log(`::warning::Change detection failed (${error.message}): running every lane.`);
  }
  console.log(`code=${code}`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `code=${code}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
