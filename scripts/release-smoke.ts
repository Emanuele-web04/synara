// FILE: release-smoke.ts
// Purpose: Smoke-tests release version alignment and merged macOS updater manifests.
// Layer: Release verification script
// Depends on: update-release-package-versions.ts and merge-mac-update-manifests.ts.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SYNARA_DESKTOP_UPDATE_CHANNEL,
  SYNARA_PRODUCTION_BUNDLE_ID,
} from "@synara/shared/desktopIdentity";

import {
  readReleaseUpdatePolicyConfig,
  resolveReleaseUpdatePolicy,
} from "./lib/release-update-policy.ts";
import {
  RELEASE_LOCKFILE_PATH,
  RELEASE_PATCHES_PATH,
  RELEASE_WORKSPACE_MANIFEST_PATHS,
} from "./lib/release-workspace-manifests.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function copyWorkspaceManifestFixture(targetRoot: string): void {
  for (const relativePath of RELEASE_WORKSPACE_MANIFEST_PATHS) {
    const sourcePath = resolve(repoRoot, relativePath);
    const destinationPath = resolve(targetRoot, relativePath);
    mkdirSync(dirname(destinationPath), { recursive: true });
    cpSync(sourcePath, destinationPath);
  }
  cpSync(resolve(repoRoot, RELEASE_LOCKFILE_PATH), resolve(targetRoot, RELEASE_LOCKFILE_PATH));
  cpSync(resolve(repoRoot, RELEASE_PATCHES_PATH), resolve(targetRoot, RELEASE_PATCHES_PATH), {
    recursive: true,
  });
}

function writeMacManifestFixtures(targetRoot: string): { arm64Path: string; x64Path: string } {
  const assetDirectory = resolve(targetRoot, "release-assets");
  mkdirSync(assetDirectory, { recursive: true });

  const arm64Path = resolve(assetDirectory, "latest-mac.yml");
  const x64Path = resolve(assetDirectory, "latest-mac-x64.yml");

  writeFileSync(
    arm64Path,
    `version: 9.9.9-smoke.0
files:
  - url: Synara-9.9.9-smoke.0-arm64.zip
    sha512: arm64zip
    size: 125621344
path: Synara-9.9.9-smoke.0-arm64.zip
sha512: arm64zip
releaseDate: '2026-03-08T10:32:14.587Z'
`,
  );

  writeFileSync(
    x64Path,
    `version: 9.9.9-smoke.0
files:
  - url: Synara-9.9.9-smoke.0-x64.zip
    sha512: x64zip
    size: 132000112
path: Synara-9.9.9-smoke.0-x64.zip
sha512: x64zip
releaseDate: '2026-03-08T10:36:07.540Z'
`,
  );

  return { arm64Path, x64Path };
}

function assertContains(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(message);
  }
}

function assertNotContains(haystack: string, needle: string, message: string): void {
  if (haystack.includes(needle)) {
    throw new Error(message);
  }
}

function verifyCanonicalIdentity(): void {
  const serverPackage = JSON.parse(
    readFileSync(resolve(repoRoot, "apps/server/package.json"), "utf8"),
  ) as { name?: string; bin?: Record<string, string> };
  if (serverPackage.name !== "@synara/cli") {
    throw new Error(`Expected CLI package @synara/cli, got ${serverPackage.name ?? "<missing>"}.`);
  }
  const expectedBinaries = {
    synara: "dist/index.mjs",
    "synara-restore-migration-backup": "dist/restoreMigrationBackup.mjs",
  };
  if (JSON.stringify(serverPackage.bin ?? {}) !== JSON.stringify(expectedBinaries)) {
    throw new Error(
      "Expected the CLI to expose only the Synara entry point and migration recovery binary.",
    );
  }
  if (SYNARA_PRODUCTION_BUNDLE_ID !== "com.emanueledipietro.synara") {
    throw new Error(`Unexpected production bundle ID: ${SYNARA_PRODUCTION_BUNDLE_ID}.`);
  }
  if (SYNARA_DESKTOP_UPDATE_CHANNEL !== "synara") {
    throw new Error(`Unexpected desktop update channel: ${SYNARA_DESKTOP_UPDATE_CHANNEL}.`);
  }

  const releasePolicy = readReleaseUpdatePolicyConfig(repoRoot);
  const resolvedPolicy = resolveReleaseUpdatePolicy("9.9.9", releasePolicy);
  if (
    resolvedPolicy.lane !== "clean" ||
    !resolvedPolicy.makeLatest ||
    resolvedPolicy.mirrorToStableChannel
  ) {
    throw new Error("Expected stable clean Synara releases to publish on GitHub Latest.");
  }
}

async function verifyReleaseWorkflowSafety(): Promise<void> {
  // Bun is the pinned release toolchain and already required by this smoke.
  const parseYaml = (source: string): unknown =>
    JSON.parse(
      execFileSync(
        "bun",
        ["-e", "process.stdout.write(JSON.stringify(Bun.YAML.parse(await Bun.stdin.text())))"],
        { input: source, encoding: "utf8" },
      ),
    );
  const workflow = readFileSync(
    resolve(repoRoot, ".github/workflows/release.yml"),
    "utf8",
  ).replaceAll("\r\n", "\n");
  const platformWorkflow = readFileSync(
    resolve(repoRoot, ".github/workflows/release-platform.yml"),
    "utf8",
  ).replaceAll("\r\n", "\n");
  const packagingJob = platformWorkflow.slice(platformWorkflow.indexOf("\njobs:\n"));
  assertContains(
    workflow,
    "\npermissions: {}\n",
    "Expected the release workflow to deny GITHUB_TOKEN permissions by default.",
  );
  assertNotContains(
    workflow,
    "permissions:\n  contents: write\n  id-token: write",
    "Release-wide publication permissions must not be inherited by every job.",
  );
  assertContains(
    workflow,
    "  preflight:\n    name: Preflight\n    runs-on: ubuntu-24.04\n    timeout-minutes: 15\n    permissions:\n      contents: read",
    "Expected preflight to receive read-only repository access.",
  );
  const buildJob = workflow.slice(
    workflow.indexOf("  build:\n"),
    workflow.indexOf("  publish_cli:\n"),
  );
  const buildSteps = packagingJob.split(/\n      - /).slice(1);
  const defenderIndex = buildSteps.findIndex((step) =>
    step.includes("run: ./scripts/verify-windows-defender.ps1"),
  );
  const startupIndex = buildSteps.findIndex((step) =>
    step.startsWith("name: Smoke packaged desktop startup\n"),
  );
  // Only the notarized Mac path may launch its app inside the build step, while
  // Apple notarizes the DMG; Windows must scan installers before any launch.
  const buildStep = buildSteps.find((step) => step.includes("id: build_artifact"))!;
  const earlySmoke = buildStep.indexOf("node scripts/verify-packaged-desktop-startup.ts");
  if (
    earlySmoke >= 0 &&
    !buildStep
      .slice(0, earlySmoke)
      .includes('if [[ "${{ inputs.platform }}" == "mac" && "$signed" == "true" ]]; then')
  ) {
    throw new Error("Only the signed macOS build may smoke before provenance.");
  }
  const uploadIndex = buildSteps.findIndex((step) =>
    step.includes("name: desktop-${{ inputs.platform }}-${{ inputs.arch }}"),
  );
  if (defenderIndex < 0 || startupIndex <= defenderIndex || uploadIndex <= defenderIndex) {
    throw new Error("Windows Defender must qualify installers before startup or artifact upload.");
  }
  const defenderStep = buildSteps[defenderIndex]!;
  if (/continue-on-error:\s*(?!false(?:\s|$))\S/.test(defenderStep)) {
    throw new Error("Windows Defender qualification must not be optional.");
  }
  const defenderPredicate = defenderStep.match(/\n        if: (.+)/)?.[1];
  if (!defenderPredicate) throw new Error("Missing Windows Defender platform predicate.");
  const scans = new Function("inputs", `return ${defenderPredicate};`) as (inputs: {
    platform: string;
  }) => boolean;
  for (const platform of ["win", "mac", "linux"]) {
    if (scans({ platform }) !== (platform === "win")) {
      throw new Error(`Incorrect Defender routing for ${platform}.`);
    }
  }
  const defenderId = defenderStep.match(/\n        id: (.+)/)?.[1];
  const evidenceStep = buildSteps.find((step) =>
    step.includes("name: windows-defender-${{ inputs.arch }}"),
  );
  const evidencePredicate = evidenceStep?.match(/\n        if: \$\{\{ (.+) \}\}/)?.[1];
  if (!defenderId || !evidencePredicate) throw new Error("Missing Defender evidence routing.");
  const preservesEvidence = new Function(
    "inputs",
    "steps",
    "always",
    `return ${evidencePredicate};`,
  ) as (
    inputs: { platform: string },
    steps: Record<string, { outcome: string }>,
    always: () => boolean,
  ) => boolean;
  for (const outcome of ["success", "failure", "cancelled", "skipped"]) {
    const upload = preservesEvidence(
      { platform: "win" },
      { [defenderId]: { outcome } },
      () => true,
    );
    if (upload !== (outcome !== "skipped")) {
      throw new Error(`Incorrect Defender evidence upload after ${outcome} scan.`);
    }
  }
  assertContains(
    buildJob,
    "uses: ./.github/workflows/release-platform.yml",
    "Missing native workflow.",
  );
  type Step = {
    name?: string;
    id?: string;
    uses?: string;
    if?: string;
    run?: string;
    with?: Record<string, string>;
    "continue-on-error"?: boolean | string;
  };
  const platformDefinition = parseYaml(platformWorkflow) as {
    jobs: Record<string, { steps: Step[] }>;
  };
  if (Object.keys(platformDefinition.jobs).length !== 1) {
    throw new Error("Successful packaging and qualification must share one runner.");
  }
  const nativeSteps = Object.values(platformDefinition.jobs)[0]!.steps;
  const stepById = (id: string): Step => {
    const step = nativeSteps.find((step) => step.id === id);
    if (!step) throw new Error(`Missing native release step ${id}.`);
    return step;
  };
  const evaluates = (step: Step, context: Record<string, unknown>): boolean => {
    if (!step.if) throw new Error(`Missing conditional admission for ${step.name}.`);
    const expression = step.if.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
    return Boolean(
      new Function(...Object.keys(context), `return ${expression};`)(...Object.values(context)),
    );
  };
  const lookup = stepById("checkpoint_lookup");
  if (
    evaluates(lookup, { github: { run_attempt: 1 } }) ||
    !evaluates(lookup, { github: { run_attempt: 2 } })
  ) {
    throw new Error("Checkpoint lookup must run only on retries.");
  }
  const restore = nativeSteps.find((step) => step.with?.["artifact-ids"]);
  if (
    !restore ||
    restore.with?.["run-id"] !== "${{ github.run_id }}" ||
    restore.with?.repository !== "${{ github.repository }}"
  ) {
    throw new Error("Checkpoint download must be bound to the current run and repository.");
  }
  for (const artifactId of ["", "42"]) {
    const context = { steps: { checkpoint_lookup: { outputs: { artifact_id: artifactId } } } };
    for (const step of [restore, stepById("restore_checkpoint")]) {
      if (evaluates(step, context) !== Boolean(artifactId))
        throw new Error("Checkpoint restore/verification admission mismatch.");
    }
  }
  const verifyIndex = nativeSteps.indexOf(stepById("restore_checkpoint"));
  const buildIndex = nativeSteps.indexOf(stepById("build_artifact"));
  const provenanceIndex = nativeSteps.indexOf(stepById("provenance"));
  if (
    verifyIndex <= nativeSteps.indexOf(restore) ||
    buildIndex <= verifyIndex ||
    provenanceIndex <= buildIndex ||
    defenderIndex <= provenanceIndex ||
    uploadIndex <= startupIndex
  ) {
    throw new Error("Restore, build, provenance and qualification order is unsafe.");
  }
  // Execute real workflow conditions for every preparation step. A valid
  // restored checkpoint skips the entire build; a cache miss keeps the full path.
  for (const platform of ["mac", "win", "linux"]) {
    for (const step of nativeSteps.slice(verifyIndex + 1, provenanceIndex + 1)) {
      const withOutcome = (outcome: string) =>
        evaluates(step, { inputs: { platform }, steps: { restore_checkpoint: { outcome } } });
      if (withOutcome("success"))
        throw new Error(`Restored ${platform} checkpoint repeats ${step.name}.`);
      if (step.id === "build_artifact" && !withOutcome("skipped"))
        throw new Error("Checkpoint miss must build.");
    }
  }
  const backupVerify = stepById("checkpoint_backup_verify");
  for (const step of nativeSteps.slice(0, nativeSteps.indexOf(backupVerify))) {
    if (step["continue-on-error"] !== undefined && step["continue-on-error"] !== false) {
      throw new Error(`Release failures must not be ignored by ${step.name}.`);
    }
    const diagnosticEvidence = step.with?.name === "windows-defender-${{ inputs.arch }}";
    if (!diagnosticEvidence && /\b(?:always|cancelled|failure|success)\s*\(/.test(step.if ?? "")) {
      throw new Error(`Normal release step ${step.name} must retain implicit success admission.`);
    }
  }
  for (const step of [backupVerify, stepById("restore_checkpoint")]) {
    if (!step.run?.includes("node scripts/verify-release-artifact-checkpoint.ts"))
      throw new Error("Checkpoint transfer requires the full identity and byte verifier.");
  }
  const backupUpload = nativeSteps.find((step) =>
    step.with?.name?.startsWith("candidate-desktop-"),
  );
  if (!backupUpload) throw new Error("Missing failed-attempt checkpoint persistence.");
  for (const failed of [false, true])
    for (const cancelled of [false, true]) {
      for (const provenance of ["success", "failure", "skipped"])
        for (const restored of ["success", "skipped"]) {
          const context = {
            failure: () => failed,
            cancelled: () => cancelled,
            steps: {
              provenance: { outcome: provenance },
              restore_checkpoint: { outcome: restored },
            },
          };
          if (
            evaluates(backupVerify, context) !==
            (failed && !cancelled && provenance === "success" && restored !== "success")
          ) {
            throw new Error(
              "Checkpoint backup must be limited to verified, freshly built failure payloads.",
            );
          }
        }
      for (const verified of ["success", "failure", "skipped"]) {
        if (
          evaluates(backupUpload, {
            failure: () => failed,
            cancelled: () => cancelled,
            steps: { checkpoint_backup_verify: { outcome: verified } },
          }) !== (failed && !cancelled && verified === "success")
        ) {
          throw new Error(
            "Checkpoint upload must not run on success, cancellation or changed bytes.",
          );
        }
      }
    }
  // Run the actual GitHub lookup script against an API boundary fixture; the
  // response includes unrelated and expired artifacts to catch a broad lookup.
  const lookupScript = lookup.with?.script;
  if (!lookupScript) throw new Error("Missing same-run checkpoint lookup.");
  const executeLookup = new Function(
    "github",
    "context",
    "process",
    "core",
    `return (async () => { ${lookupScript} })();`,
  );
  for (const scenario of ["hit", "duplicate", "miss", "api-error"]) {
    const outputs: Record<string, unknown> = {};
    let listedCurrentRun = false;
    let errorMessage = "";
    const endpoint = {};
    try {
      await executeLookup(
        {
          rest: { actions: { listWorkflowRunArtifacts: endpoint } },
          paginate: async (method: unknown, options: Record<string, unknown>) => {
            if (
              method !== endpoint ||
              options.run_id !== 123 ||
              options.owner !== "owner" ||
              options.repo !== "repo"
            )
              throw new Error("Checkpoint lookup escaped current run.");
            listedCurrentRun = true;
            if (scenario === "api-error") throw new Error("expected API failure");
            return [
              { id: 11, name: "other", expired: false },
              { id: 12, name: "candidate-desktop-mac-x64", expired: true },
              ...(scenario !== "miss"
                ? [{ id: 13, name: "candidate-desktop-mac-x64", expired: false }]
                : []),
              ...(scenario === "duplicate"
                ? [{ id: 14, name: "candidate-desktop-mac-x64", expired: false }]
                : []),
            ];
          },
        },
        { repo: { owner: "owner", repo: "repo" }, runId: 123 },
        { env: { CHECKPOINT_NAME: "candidate-desktop-mac-x64" } },
        {
          setOutput: (key: string, value: unknown) => {
            outputs[key] = value;
          },
        },
      );
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    const expectedError =
      scenario === "api-error"
        ? "expected API failure"
        : scenario === "duplicate"
          ? "More than one checkpoint matches this platform in this run."
          : "";
    if (
      !listedCurrentRun ||
      errorMessage !== expectedError ||
      (!expectedError && outputs.artifact_id !== (scenario === "miss" ? "" : 13))
    ) {
      throw new Error(`Incorrect checkpoint lookup result for ${scenario}.`);
    }
  }
  assertContains(
    platformWorkflow,
    "permissions:\n  contents: read\n  actions: read",
    "Native jobs require only repository and artifact reads.",
  );
  // Execute the actual job predicate against failed/skipped prerequisites. A
  // matching source string would not detect a permissive OR elsewhere in it.
  const predicate = buildJob.match(/    if: \$\{\{ (.+) \}\}/)?.[1];
  if (!predicate) throw new Error("Missing packaging admission predicate.");
  const admits = new Function("needs", "cancelled", `return ${predicate};`) as (
    needs: Record<string, unknown>,
    cancelled: () => boolean,
  ) => boolean;
  const prerequisites = ["preflight", "build_mac_icon", "build_portable", "prepare_cua"];
  const dependencies = buildJob.match(/    needs: \[(.+)\]/)?.[1]?.split(/,\s*/) ?? [];
  for (const name of prerequisites)
    if (!dependencies.includes(name)) throw new Error(`Packaging does not await ${name}.`);
  for (const testGate of ["quality", "server_tests"])
    if (dependencies.includes(testGate))
      throw new Error(`Packaging unnecessarily waits for ${testGate}.`);
  const successful: Record<string, { result: string; outputs?: Record<string, string> }> =
    Object.fromEntries(prerequisites.map((name) => [name, { result: "success" }]));
  successful.preflight = {
    result: "success",
    outputs: { package_artifacts: "true", prepare_cua: "true", build_icon: "true" },
  };
  if (!admits(successful, () => false)) throw new Error("Valid packaging is blocked.");
  if (admits(successful, () => true)) throw new Error("Cancelled release can package artifacts.");
  for (const name of prerequisites) {
    for (const result of ["failure", "cancelled", "skipped", ""]) {
      if (admits({ ...successful, [name]: { ...successful[name], result } }, () => false))
        throw new Error(`Packaging admitted ${name}=${result}.`);
    }
  }
  for (const platform of ["linux", "win"]) {
    const noMac = {
      ...successful,
      preflight: {
        result: "success",
        outputs: {
          package_artifacts: "true",
          build_icon: "false",
          prepare_cua: platform === "win" ? "false" : "true",
        },
      },
      build_mac_icon: { result: "skipped" },
      prepare_cua: { result: platform === "win" ? "skipped" : "success" },
    };
    if (!admits(noMac, () => false))
      throw new Error(`${platform} packaging is blocked by an intentional skip.`);
  }
  for (const gate of [
    "  quality:\n    name: Quality gates\n    needs: preflight\n    runs-on: ubuntu-24.04\n    timeout-minutes: 15\n    permissions:\n      contents: read",
    "  server_tests:\n    name: Server tests (${{ matrix.shard }})\n    needs: preflight\n    if: needs.preflight.outputs.quality_gates == 'true'\n    runs-on: ubuntu-24.04\n    timeout-minutes: 15\n    permissions:\n      contents: read",
    "bunx turbo run test --filter='!@synara/cli'",
    "bunx turbo run test --filter=@synara/cli -- --shard=${{ matrix.shard }}",
  ]) {
    assertContains(workflow, gate, "Expected read-only, sharded quality gates before publication.");
  }
  assertContains(
    buildJob,
    "permissions:\n      contents: read",
    "Artifact builds must remain read-only.",
  );
  assertContains(
    readFileSync(resolve(repoRoot, "scripts/lib/release-build-scope.ts"), "utf8"),
    'runner: "macos-15",',
    "Expected the arm64 native release runner to retain the macOS 15 SDK.",
  );
  for (const toolchain of [
    "native_developer_dir=/Applications/Xcode_16.4.app/Contents/Developer",
    "DEVELOPER_DIR: /Applications/Xcode_26.3.app/Contents/Developer",
    "runs-on: macos-26",
    "name: mac-icon-catalog",
    'echo "SYNARA_MAC_ICON_CATALOG=$RUNNER_TEMP/mac-icon/Assets.car" >> "$GITHUB_ENV"',
  ]) {
    assertContains(
      workflow + platformWorkflow,
      toolchain,
      "Expected separate native and icon release toolchains.",
    );
  }
  assertContains(
    readFileSync(resolve(repoRoot, ".github/actions/provision-cua/action.yml"), "utf8"),
    "pkg-config libssl-dev libx11-dev libxtst-dev libxrandr-dev libxfixes-dev libxrender-dev libxcb-shape0-dev libxcb-xfixes0-dev libxkbcommon-dev libwayland-dev",
    "Expected the Linux release to install the native driver's build dependencies.",
  );
  assertContains(
    workflow,
    "    permissions:\n      contents: read\n      id-token: write\n    steps:",
    "Expected only CLI publication to combine repository reads with npm OIDC.",
  );
  const workflowDefinition = parseYaml(workflow) as {
    jobs: Record<string, { needs: string[]; if: string }>;
  };
  for (const name of ["release", "publish_cli"]) {
    const publisher = workflowDefinition.jobs[name]!;
    for (const gate of ["preflight", "quality", "server_tests", "build"])
      if (!publisher.needs.includes(gate))
        throw new Error(`${name} does not directly await ${gate}.`);
    const expression = publisher.if.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
    if (/\b(?:always|cancelled|failure|success)\s*\(/.test(expression))
      throw new Error(`${name} must retain implicit success admission.`);
    const allows = new Function("needs", "vars", `return ${expression};`);
    for (const publish of ["true", "false"])
      for (const prerelease of ["true", "false"]) {
        const needs = Object.fromEntries(
          publisher.needs.map((gate) => [
            gate,
            { result: "success", outputs: {} as Record<string, string> },
          ]),
        );
        needs.preflight!.outputs = { publish_release: publish, is_prerelease: prerelease };
        if (
          Boolean(allows(needs, { SYNARA_PUBLISH_CLI: "1" })) !==
          (publish === "true" && (name === "release" || prerelease === "false"))
        )
          throw new Error(`${name} publication policy changed.`);
      }
    for (const gate of ["quality", "server_tests"])
      for (const result of ["failure", "cancelled", "skipped", ""]) {
        const needs = Object.fromEntries(
          publisher.needs.map((gate) => [
            gate,
            { result: "success", outputs: {} as Record<string, string> },
          ]),
        );
        needs.preflight!.outputs = { publish_release: "true", is_prerelease: "false" };
        needs[gate]!.result = result;
        if (allows(needs, { SYNARA_PUBLISH_CLI: "1" }))
          throw new Error(`${name} admits ${gate}=${result}.`);
      }
  }
  const serverJob = workflow.slice(
    workflow.indexOf("  build_server_tarball:\n"),
    workflow.indexOf("  release:\n"),
  );
  const serverNeeds = serverJob.match(/    needs: \[(.+)\]/)?.[1]?.split(/,\s*/) ?? [];
  for (const gate of ["preflight", "quality", "server_tests", "build_portable"])
    if (!serverNeeds.includes(gate)) throw new Error(`Server artifact does not await ${gate}.`);
  assertContains(
    serverJob,
    "permissions:\n      contents: read",
    "Server artifact access must remain read-only.",
  );
  assertContains(
    workflow,
    "  release:\n    name: Publish GitHub Release\n    if: ${{ needs.preflight.outputs.publish_release == 'true' && needs.quality.result == 'success' && needs.server_tests.result == 'success' }}\n    needs: [preflight, quality, server_tests, build, build_server_tarball]\n    runs-on: ubuntu-24.04\n    timeout-minutes: 10\n    permissions:\n      contents: write",
    "Expected only GitHub release publication to receive contents write access.",
  );
  assertContains(
    workflow,
    "repositories: ${{ github.event.repository.name }}\n          permission-contents: write",
    "Expected release finalization to mint a repository-scoped contents token.",
  );
  assertContains(
    workflow,
    "publish_release:\n        description:",
    "Expected a manual publication opt-in input.",
  );
  assertContains(
    workflow,
    "default: false\n        type: boolean",
    "Expected manual release runs to default to build-only mode.",
  );
  assertContains(
    workflow,
    "publish_release: ${{ steps.release_mode.outputs.publish_release }}",
    "Expected preflight to expose the resolved publication mode.",
  );
  assertContains(
    workflow,
    "if: ${{ needs.preflight.outputs.publish_release == 'true' && needs.quality.result == 'success' && needs.server_tests.result == 'success' }}",
    "Expected GitHub publication to require explicit publication mode.",
  );
  assertContains(
    workflow,
    "needs.preflight.outputs.publish_release == 'true' && vars.SYNARA_PUBLISH_CLI == '1'",
    "Expected CLI publication to require explicit publication mode.",
  );
  assertContains(
    workflow,
    "needs.preflight.outputs.publish_release == 'true' && vars.SYNARA_FINALIZE_RELEASE == '1'",
    "Expected release finalization to require explicit publication mode.",
  );
  assertContains(
    workflow,
    "vars.SYNARA_PUBLISH_CLI == '1' && needs.preflight.outputs.is_prerelease == 'false'",
    "Expected prereleases to be fenced out of the npm latest publish job.",
  );
  assertContains(
    workflow,
    "vars.SYNARA_FINALIZE_RELEASE == '1' && needs.preflight.outputs.is_prerelease == 'false'",
    "Expected prereleases to be fenced out of the version-bump finalize job.",
  );
  assertContains(
    workflow,
    "desktop_flavor: ${{ steps.release_meta.outputs.desktop_flavor }}",
    "Expected preflight to expose the resolved desktop flavor.",
  );
  assertContains(
    packagingJob,
    '--flavor "${{ inputs.desktop_flavor }}"',
    "Expected the desktop matrix to build the resolved flavor.",
  );
  assertContains(
    workflow,
    '--channel "$UPDATE_CHANNEL"',
    "Expected feed prep to emit manifests for the resolved update channel.",
  );
  assertContains(
    workflow,
    "UPDATE_CHANNEL: ${{ needs.preflight.outputs.update_channel }}",
    "Expected feed prep to receive the resolved update channel.",
  );
  assertContains(
    platformWorkflow,
    "--executable-name",
    "Expected packaged startup verification to resolve the flavor's executable name.",
  );
  const iconJob = workflow.slice(
    workflow.indexOf("  build_mac_icon:\n"),
    workflow.indexOf("  build:\n"),
  );
  assertContains(
    iconJob,
    "DESKTOP_FLAVOR: ${{ needs.preflight.outputs.desktop_flavor }}",
    "Expected the macOS icon job to receive the resolved desktop flavor.",
  );
  const brandAssets = readFileSync(resolve(repoRoot, "scripts/lib/brand-assets.ts"), "utf8");
  const betaComposerPath = /betaMacIconComposer: "([^"]+)"/.exec(brandAssets)?.[1];
  const prodComposerPath = /productionMacIconComposer: "([^"]+)"/.exec(brandAssets)?.[1];
  if (betaComposerPath === undefined || prodComposerPath === undefined) {
    throw new Error("Expected brand-assets.ts to declare Icon Composer sources per flavor.");
  }
  assertContains(
    iconJob,
    `icon_source="${prodComposerPath}"`,
    "Expected the macOS icon job to default to the production Icon Composer source.",
  );
  assertContains(
    iconJob,
    `icon_source="${betaComposerPath}"`,
    "Expected the macOS icon job to compile the beta Icon Composer source for beta releases.",
  );
  assertContains(
    iconJob,
    "--app-icon Synara",
    "Expected every flavor's icon catalog to keep the Synara asset name.",
  );
  const collectStep = packagingJob.slice(
    packagingJob.indexOf("  - name: Collect release assets"),
    packagingJob.indexOf("  - name: Verify and record artifact provenance"),
  );
  assertContains(
    collectStep,
    '"release/*.',
    "Expected the collect step to glob the release/ output directory.",
  );
  assertContains(
    platformWorkflow,
    "--output-dir release",
    "Expected every flavor's build to write into the collected release/ directory.",
  );
  assertContains(
    platformWorkflow,
    "SYNARA_PUBLISH_RELEASE: ${{ inputs.publish_release }}",
    "Expected artifact signing admission to know whether artifacts will be published.",
  );
  assertContains(
    platformWorkflow,
    "Publishing macOS artifacts requires every signing and notarization secret.",
    "Expected macOS publication to fail closed when signing is unavailable.",
  );
  assertContains(
    platformWorkflow,
    "Publishing Windows artifacts requires every Azure Trusted Signing secret.",
    "Expected Windows publication to fail closed when signing is unavailable.",
  );
  assertNotContains(
    platformWorkflow,
    "Windows signing is optional",
    "Windows publication must not retain the unsigned-installer fallback.",
  );
  assertContains(
    workflow,
    "node scripts/verify-release-source-provenance.ts",
    "Expected preflight to bind release source provenance before artifact jobs.",
  );
  assertContains(
    workflow,
    "source_commit: ${{ steps.source_provenance.outputs.source_commit }}",
    "Expected the verified source commit to be a preflight output.",
  );
  assertContains(
    workflow,
    "lockfile_sha256: ${{ steps.source_provenance.outputs.lockfile_sha256 }}",
    "Expected the verified lockfile digest to be a preflight output.",
  );
  assertContains(
    platformWorkflow,
    '--source-commit "$SOURCE_COMMIT"',
    "Expected desktop packaging to revalidate the verified source commit.",
  );
  assertContains(
    platformWorkflow,
    '--lockfile-sha256 "$LOCKFILE_SHA256"',
    "Expected desktop packaging to revalidate the verified lockfile digest.",
  );
  assertNotContains(
    workflow,
    "Align package versions to release version",
    "Release jobs must not mutate package versions after source provenance is established.",
  );
  assertContains(
    platformWorkflow,
    "node scripts/write-release-artifact-provenance.ts",
    "Expected every platform lane to prove collected artifacts before upload.",
  );
  assertContains(
    platformWorkflow,
    'mv release-publish/latest-mac.yml "release-publish/latest-mac-${{ inputs.arch }}.yml"',
    "Expected the x64 macOS matrix lane to preserve a distinct updater manifest for merging.",
  );
  assertContains(
    platformWorkflow,
    "APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}",
    "Expected macOS signing admission to pin the post-build Team ID.",
  );
  assertContains(
    platformWorkflow,
    "AZURE_TRUSTED_SIGNING_SUBJECT_DN: ${{ secrets.AZURE_TRUSTED_SIGNING_SUBJECT_DN }}",
    "Expected Windows signing admission to require the exact certificate subject DN.",
  );
  assertContains(
    platformWorkflow,
    '--expected-windows-subject-dn "$EXPECTED_WINDOWS_SUBJECT_DN"',
    "Expected Windows artifact provenance to verify the exact certificate subject DN.",
  );
  assertContains(
    platformWorkflow,
    "AZURE_TRUSTED_SIGNING_PUBLISHER_NAME: ${{ secrets.AZURE_TRUSTED_SIGNING_PUBLISHER_NAME }}",
    "Expected the Windows build to receive the publisher identity that is pinned in the bundle.",
  );
  assertContains(
    platformWorkflow,
    "node scripts/verify-packaged-desktop-startup.ts",
    "Expected every native payload to pass isolated packaged startup before upload.",
  );

  const cliScript = readFileSync(resolve(repoRoot, "apps/server/scripts/cli.ts"), "utf8");
  assertContains(
    cliScript,
    "makeTempDirectoryScoped",
    "Expected CLI publication to build an exclusively owned temporary package tree.",
  );
  assertContains(
    cliScript,
    "cwd: stagedPackageDir",
    "Expected npm publication to run only from the isolated CLI stage.",
  );
  assertContains(
    cliScript,
    "Staged CLI bin target is missing its Node shebang",
    "Expected staged CLI commands to remain executable npm bin entries.",
  );
  assertNotContains(
    cliScript,
    ".publish-bak",
    "CLI publication must not mutate and restore source-tree assets.",
  );

  const desktopBuildConfig = readFileSync(
    resolve(repoRoot, "apps/desktop/tsdown.config.mts"),
    "utf8",
  );
  assertContains(
    desktopBuildConfig,
    "__SYNARA_WINDOWS_UPDATER_PUBLISHER__",
    "Expected the Windows updater publisher identity to be compiled into the main bundle.",
  );

  const updaterSecurity = readFileSync(
    resolve(repoRoot, "apps/desktop/src/electronUpdaterSecurity.ts"),
    "utf8",
  );
  assertNotContains(
    updaterSecurity,
    "return feedPublisherNames",
    "Runtime signature verification must not trust publisher names from mutable updater config.",
  );

  const nextBetaJob = workflow.slice(workflow.indexOf("  cut_next_beta:\n"));
  assertContains(
    workflow,
    "if: ${{ needs.preflight.outputs.publish_release == 'true' && vars.SYNARA_AUTO_BETA == '1' && needs.preflight.outputs.is_prerelease == 'false' }}",
    "Expected the next-beta cut to require an opted-in stable publication.",
  );
  assertContains(
    nextBetaJob,
    "sort -V | tail -1",
    "Expected the next-beta job to skip releases that are not the highest stable tag.",
  );
  assertContains(
    nextBetaJob,
    'git push origin "refs/tags/$TAG"',
    "Expected the next-beta job to push only the beta tag.",
  );
  assertNotContains(nextBetaJob, "HEAD:main", "The next-beta job must never push to main.");
  assertNotContains(
    nextBetaJob,
    "git push origin HEAD",
    "The next-beta job must never push a branch.",
  );
}

function verifyDesktopStageLockAuthority(): void {
  const buildScript = readFileSync(resolve(repoRoot, "scripts/build-desktop-artifact.ts"), "utf8");
  const gitAttributes = readFileSync(resolve(repoRoot, ".gitattributes"), "utf8");
  assertContains(
    gitAttributes,
    "bun.lock text eol=lf",
    "Expected bun.lock to retain byte-identical LF endings on every release runner.",
  );
  assertContains(
    buildScript,
    "bun install --frozen-lockfile --ignore-scripts --linker hoisted",
    "Expected macOS and Linux desktop staging to install from the repository's frozen workspace lockfile.",
  );
  assertContains(
    buildScript,
    'if (platform === "win")',
    "Expected Windows staging to use its explicit Bun lockfile-workaround path.",
  );
  assertContains(
    buildScript,
    "bun install --omit=dev --ignore-scripts --linker hoisted",
    "Expected Windows staging to omit dev dependencies without Bun's implicitly frozen production mode.",
  );
  assertNotContains(
    buildScript,
    "--production --frozen-lockfile",
    "Desktop staging must avoid Bun's divergent frozen production-workspace lockfile resolution.",
  );
  assertNotContains(
    buildScript,
    "bun install --production",
    "Windows staging must not use Bun's production flag because it implicitly forces frozen mode.",
  );
  assertNotContains(
    buildScript,
    "--filter @synara/",
    "Desktop staging must not use Bun workspace filters because filtered hoisted installs can diverge from bun.lock.",
  );
  assertContains(
    buildScript,
    'npm rebuild node-pty --foreground-scripts --prefix ${path.join(stageAppDir, "node_modules", "node-pty")}',
    "Expected Linux desktop staging to build only node-pty after the script-free frozen install.",
  );
  assertNotContains(
    buildScript,
    "npm rebuild --foreground-scripts",
    "Desktop staging must never enable every dependency lifecycle script.",
  );
  assertNotContains(
    buildScript,
    "bun pm trust --all",
    "Desktop staging must never trust every dependency lifecycle script.",
  );
  assertContains(
    buildScript,
    'createRequire(new URL("./package.json", import.meta.url))',
    "Expected desktop packaging to resolve dependencies from the owning scripts workspace.",
  );
  assertContains(
    buildScript,
    'requireFromScriptsWorkspace.resolve("electron-builder/cli.js")',
    "Expected desktop packaging to resolve electron-builder across Bun hoisting layouts.",
  );
  assertContains(
    buildScript,
    "`${process.execPath} ${electronBuilderCliPath}",
    "Expected desktop packaging to invoke electron-builder through Node without platform-specific bin shims.",
  );
  assertNotContains(
    buildScript,
    "electron-builder.cmd",
    "Desktop packaging must not depend on a Windows bin shim that Bun may hoist elsewhere.",
  );
  assertContains(
    buildScript,
    "synaraCommitHash: commitHash",
    "Expected the staged package to carry its exact source commit.",
  );
  assertContains(
    buildScript,
    "synaraLockfileSha256: resolvedLockfileSha256",
    "Expected the staged package to carry its repository lockfile digest.",
  );
  assertContains(
    buildScript,
    "synaraWindowsPublisherSubject: resolvedBuildConfig.windowsPublisherSubject",
    "Expected signed Windows packages to carry the independently configured certificate subject DN.",
  );

  const lockfile = readFileSync(resolve(repoRoot, RELEASE_LOCKFILE_PATH), "utf8");
  const packagesSectionOffset = lockfile.indexOf('\n  "packages": {');
  if (packagesSectionOffset < 0) {
    throw new Error("Expected bun.lock to contain a packages section.");
  }
  const workspaceImporters = lockfile.slice(0, packagesSectionOffset);
  for (const manifestPath of RELEASE_WORKSPACE_MANIFEST_PATHS) {
    const workspacePath = manifestPath === "package.json" ? "" : dirname(manifestPath);
    if (!workspaceImporters.includes(`${JSON.stringify(workspacePath)}: {`)) {
      throw new Error(`Expected ${manifestPath} to have a matching importer in bun.lock.`);
    }
  }
}

const tempRoot = mkdtempSync(join(tmpdir(), "synara-release-smoke-"));

try {
  verifyCanonicalIdentity();
  await verifyReleaseWorkflowSafety();
  verifyDesktopStageLockAuthority();
  copyWorkspaceManifestFixture(tempRoot);

  execFileSync(
    process.execPath,
    [
      resolve(repoRoot, "scripts/update-release-package-versions.ts"),
      "9.9.9-smoke.0",
      "--root",
      tempRoot,
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  execFileSync("bun", ["install", "--lockfile-only", "--ignore-scripts"], {
    cwd: tempRoot,
    stdio: "inherit",
  });

  const lockfile = readFileSync(resolve(tempRoot, "bun.lock"), "utf8");
  assertContains(
    lockfile,
    `"version": "9.9.9-smoke.0"`,
    "Expected bun.lock to contain the smoke version.",
  );

  const { arm64Path, x64Path } = writeMacManifestFixtures(tempRoot);
  execFileSync(
    process.execPath,
    [resolve(repoRoot, "scripts/merge-mac-update-manifests.ts"), arm64Path, x64Path],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  const mergedManifest = readFileSync(arm64Path, "utf8");
  assertContains(
    mergedManifest,
    "Synara-9.9.9-smoke.0-arm64.zip",
    "Merged manifest is missing the arm64 asset.",
  );
  assertContains(
    mergedManifest,
    "Synara-9.9.9-smoke.0-x64.zip",
    "Merged manifest is missing the x64 asset.",
  );
  assertNotContains(
    mergedManifest,
    ".dmg",
    "macOS updater manifests must describe only the finalized ZIP artifacts.",
  );

  console.log("Release smoke checks passed.");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
