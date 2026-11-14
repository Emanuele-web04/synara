import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const sizeWorkflow = read("../workflows/pr-size.yml");
// Execute the actual github-script blocks; no second implementation of the classifier.
const scripts = [...sizeWorkflow.matchAll(/          script: \|\n((?:            .*\n|\n)+)/g)].map(
  (match) => match[1].replace(/^            /gm, ""),
);
assert.equal(scripts.length, 3);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const execute = (script, github, core, context) =>
  new AsyncFunction("github", "core", "context", script)(github, core, context);
let labels;
await execute(scripts[0], {}, { setOutput: (_, value) => (labels = JSON.parse(value)) }, {});
// The workflow passes this exact JSON between jobs through the environment.
process.env.PR_SIZE_LABELS_JSON = JSON.stringify(labels);
const context = {
  eventName: "pull_request_target",
  repo: { owner: "example", repo: "synara" },
  payload: { pull_request: { number: 1 } },
};
const file = (filename, additions, deletions = 0) => ({ filename, additions, deletions });
async function classify(files, current = [], totalFiles = files.length) {
  const mutations = [];
  const warnings = [];
  const github = {
    paginate: async () => files,
    rest: {
      pulls: { listFiles() {}, get: async () => ({ data: { changed_files: totalFiles } }) },
      issues: {
        listLabelsOnIssue: async () => ({ data: current.map((name) => ({ name })) }),
        removeLabel: async ({ name }) => mutations.push(["remove", name]),
        addLabels: async ({ labels: added }) => mutations.push(["add", ...added]),
      },
    },
  };
  await execute(scripts[2], github, { warning: (text) => warnings.push(text), info() {} }, context);
  return { mutations, warnings };
}

test("all size boundaries select exactly one bucket", async () => {
  const boundaries = [0, 10, 50, 200, 600, 1000, 3000, 6000, 12000, 25000, 50000];
  const names = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "3XL", "4XL", "5XL", "6XL"];
  for (let index = 0; index < boundaries.length; index++) {
    const minimum = boundaries[index];
    assert.deepEqual((await classify([file("src/app.ts", minimum)])).mutations, [
      ["add", `size:${names[index]}`],
    ]);
    if (index > 0) {
      assert.deepEqual((await classify([file("src/app.ts", minimum - 1)])).mutations, [
        ["add", `size:${names[index - 1]}`],
      ]);
    }
  }
  assert.deepEqual((await classify([file("src/app.ts", 1000000)])).mutations, [
    ["add", "size:6XL"],
  ]);
  assert.equal(labels[0].description.split(" changed")[0], "0-9");
  assert.equal(labels[6].description.split(" changed")[0], "3,000-5,999");
});

test("exclusions, deletions and test-only fallback preserve existing behavior", async () => {
  const ignored = [
    "bun.lock",
    "apps/web/package-lock.json",
    "dist/app.js",
    "src/generated/api.ts",
    "assets/icon.svg",
    "audit/receipt.md",
    ".github/pr-assets/demo/image.png",
  ].map((name) => file(name, 100000));
  const tests = [file("src/app.test.ts", 600), file("tests/helper.ts", 400)];
  assert.deepEqual((await classify([...ignored, ...tests, file("src/app.ts", 5, 5)])).mutations, [
    ["add", "size:XS"],
  ]);
  assert.deepEqual((await classify([...ignored, ...tests])).mutations, [["add", "size:XL"]]);
  assert.deepEqual((await classify(ignored)).mutations, [["add", "size:XXS"]]);
});

test("replaces all obsolete sizes while preserving unrelated and manual labels", async () => {
  const current = ["size:XXS", "size:XXL", "size:6XL", "performance", "area:ci"];
  assert.deepEqual((await classify([file("src/app.ts", 6000)], current)).mutations, [
    ["remove", "size:XXS"],
    ["remove", "size:XXL"],
    ["remove", "size:6XL"],
    ["add", "size:3XL"],
  ]);
  assert.deepEqual((await classify([file("src/app.ts", 6000)], ["size:3XL"])).mutations, []);
});

test("truncated API results never replace the existing size; exactly 3000 files can be classified", async () => {
  const files = Array.from({ length: 3000 }, (_, index) => file(`src/${index}.ts`, 1));
  const truncated = await classify(files, ["size:6XL"], 3001);
  assert.deepEqual(truncated.mutations, []);
  assert.equal(truncated.warnings.length, 1);
  assert.deepEqual((await classify(files)).mutations, [["add", "size:XXL"]]);
});

test("definition sync sends only GitHub label fields, not internal thresholds", async () => {
  const created = [];
  await execute(
    scripts[1],
    {
      rest: {
        issues: {
          getLabel: async () => {
            throw Object.assign(new Error("missing"), { status: 404 });
          },
          createLabel: async (definition) => created.push(definition),
        },
      },
    },
    {},
    context,
  );
  assert.equal(created.length, 11);
  for (const definition of created) {
    assert.equal("maxExclusive" in definition, false);
    assert.ok(definition.name && definition.description && definition.color);
  }
});

const rules = JSON.parse(read("../labeler.json"));
const matching = (filename) =>
  Object.entries(rules)
    .filter(([, rules]) =>
      rules[0]["changed-files"][0]["any-glob-to-any-file"].some((glob) =>
        matchesGlob(filename, glob),
      ),
    )
    .map(([label]) => label);

test("path rules identify representative provider and area paths without generic-name collisions", () => {
  for (const [filename, expected] of [
    ["apps/server/src/provider/Layers/DevinAdapter.ts", ["area:providers", "provider:devin"]],
    [
      "apps/server/src/providerUsage/providers/droidSecureStorage.ts",
      ["area:providers", "provider:droid"],
    ],
    ["apps/server/src/provider/Layers/PiAdapter.test.ts", ["area:providers", "provider:pi"]],
    ["apps/server/src/git/Layers/GrokTextGeneration.ts", ["area:git", "provider:grok"]],
    [".github/workflows/pr-size.yml", ["area:ci"]],
    ["apps/web/src/components/terminal/TerminalViewport.tsx", ["area:terminal"]],
  ])
    assert.deepEqual(matching(filename).toSorted(), expected.toSorted(), filename);
  for (const filename of [
    "apps/web/src/components/ProjectPicker.tsx",
    "apps/web/src/pinnedMessages.ts",
    "README.md",
  ])
    assert.deepEqual(matching(filename), [], filename);
});

test("privileged path workflow never executes PR code and preserves manual labels", () => {
  const workflow = read("../workflows/pr-labels.yml");
  assert.ok(workflow.includes("pull_request_target:"));
  assert.ok(workflow.includes("sync-labels: false"));
  assert.ok(!workflow.includes("actions/checkout"));
  assert.ok(!workflow.includes("run:"));
});

test("every path label has a synchronized definition", () => {
  const workflow = read("../workflows/issue-labels.yml");
  const definition = workflow.match(/const managedLabels = (\[[\s\S]*?\n            \]);/)[1];
  const managed = new Function(`return ${definition}`)();
  const names = new Set(managed.map((label) => label.name));
  for (const name of Object.keys(rules)) assert.ok(names.has(name), name);
});
