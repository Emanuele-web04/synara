// A scripted GitHub CLI for SynBot scenarios: the merge proof reads pull requests through `gh`,
// and no scenario may reach GitHub.
//
// It answers from `<state>/gh.json` (a `GhScript`, written by the scenario) and appends every
// call to `<state>/gh-log.ndjson`. Without a script it acts like a `gh` that is not signed in,
// which is what every other scenario had before. Answered calls:
//
//   gh pr view <n> --repo <r> --json …          the pull request (`prs[n].detail`)
//   gh pr diff <n> --repo <r> …                  its patch (`prs[n].patch`)
//   gh repo view <r> --json …                    the repository's merge methods
//   gh api graphql … (stack / review threads)    no stack, no review threads
//   gh api … PUT …/merge-async                   HTTP 404 (no async merge), like most repositories
//   gh pr merge <n> --repo <r> --<method>        marks the pull request merged
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";

export interface GhPullRequest {
  readonly detail: Record<string, unknown>;
  readonly patch: string;
}

export interface GhScript {
  readonly repository: string;
  readonly prs: Readonly<Record<string, GhPullRequest>>;
}

const STATE_DIR = process.env.SYNBOT_FAKE_STATE_DIR ?? "";
const SCRIPT_PATH = nodePath.join(STATE_DIR, "gh.json");
const LOG_PATH = nodePath.join(STATE_DIR, "gh-log.ndjson");

const args = process.argv.slice(2);

const log = (data: Record<string, unknown>) => {
  if (!STATE_DIR) return;
  try {
    nodeFs.appendFileSync(
      LOG_PATH,
      `${JSON.stringify({ t: new Date().toISOString(), args, ...data })}\n`,
    );
  } catch {
    // Logging is best effort.
  }
};

const exit = (code: number, stdout: string, stderr = "") => {
  log({ code, stdout: stdout.slice(0, 200), stderr });
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(code);
};

const readScript = (): GhScript | null => {
  try {
    return JSON.parse(nodeFs.readFileSync(SCRIPT_PATH, "utf8")) as GhScript;
  } catch {
    return null;
  }
};

const script = readScript();
if (!script) {
  exit(4, "", "To get started with GitHub CLI, please run:  gh auth login\n");
}
const { repository, prs } = script!;

const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const [command, sub, target] = args;

/** `--repo` as Synara passes it: `github.com/<owner>/<name>` (the host pinned). */
const repoArg = () =>
  option("--repo")
    ?.replace(/^github\.com\//i, "")
    .toLowerCase();

const pullRequest = (number: string | undefined) => {
  const found = number ? prs[number] : undefined;
  if (!found || repoArg() !== repository.toLowerCase()) {
    exit(1, "", `GraphQL: Could not resolve to a PullRequest with the number of ${number}.\n`);
  }
  return found!;
};

if (command === "pr" && sub === "view") {
  const found = pullRequest(target);
  exit(0, `${JSON.stringify(found.detail)}\n`);
} else if (command === "pr" && sub === "diff") {
  exit(0, pullRequest(target).patch);
} else if (command === "pr" && sub === "merge") {
  const found = pullRequest(target);
  const merged: GhScript = {
    repository,
    prs: {
      ...prs,
      [target!]: {
        ...found,
        detail: { ...found.detail, state: "MERGED", mergedAt: new Date().toISOString() },
      },
    },
  };
  nodeFs.writeFileSync(SCRIPT_PATH, JSON.stringify(merged, null, 2));
  exit(0, "");
} else if (command === "repo" && sub === "view") {
  exit(
    0,
    `${JSON.stringify({
      mergeCommitAllowed: true,
      squashMergeAllowed: true,
      rebaseMergeAllowed: true,
      deleteBranchOnMerge: false,
    })}\n`,
  );
} else if (command === "api" && sub === "graphql") {
  const query = args.find((arg) => arg.startsWith("query=")) ?? "";
  if (query.includes("stackEntry")) {
    exit(
      0,
      `${JSON.stringify({ data: { repository: { pullRequest: { stackEntry: null, stack: null } } } })}\n`,
    );
  } else if (query.includes("reviewThreads")) {
    exit(
      0,
      `${JSON.stringify({
        data: {
          repository: {
            pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } },
          },
        },
      })}\n`,
    );
  }
  exit(1, "", "fake gh: this GraphQL query is not scripted\n");
} else if (command === "api" && args.some((arg) => arg.endsWith("/merge-async"))) {
  exit(1, `{"message":"Not Found","status":"404"}`, "gh: Not Found (HTTP 404)\n");
}
exit(1, "", `fake gh: \`gh ${args.join(" ")}\` is not scripted\n`);
