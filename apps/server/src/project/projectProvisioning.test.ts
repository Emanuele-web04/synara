import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ProjectId, type ProjectProvisionInput } from "@synara/contracts";
import { Deferred, Effect, Fiber, FileSystem, Path, PlatformError } from "effect";
import { describe, expect, it } from "vitest";

import { parseRepositoryReference } from "@synara/shared/gitHostRepository";

import { GitCommandError, GitHostCliError } from "../git/Errors";
import type { GitCoreShape } from "../git/Services/GitCore";
import type { GitHostCliRouterShape, GitHostCliShape } from "../git/Services/GitHostCli";
import { ProjectProvisioningError, makeProjectProvisioner } from "./projectProvisioning";

function makeInput(
  destinationParent: string,
  overrides: Partial<ProjectProvisionInput> = {},
): ProjectProvisionInput {
  return {
    operationId: "operation-1",
    host: "github",
    repository: "openai/codex",
    destinationParent,
    directoryName: "codex",
    commandId: CommandId.makeUnsafe("command-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    newProjectSpaceId: null,
    defaultModelSelection: { provider: "codex", model: "gpt-5" },
    createdAt: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}

/** Pure routing over one per-host fake; the provisioner never needs the real router. */
function makeGitHostRouter(input: {
  github?: GitHostCliShape;
  gitlab?: GitHostCliShape;
}): GitHostCliRouterShape {
  const select = (repository: string) => {
    const identity = parseRepositoryReference(repository);
    const cli = identity?.kind === "gitlab" ? input.gitlab : input.github;
    return cli
      ? Effect.succeed({
          kind: identity?.kind ?? ("github" as const),
          host: identity?.host ?? "github.com",
          cli,
        })
      : Effect.fail(
          new GitHostCliError({
            host: "gitlab",
            operation: "forRepository",
            detail: "No CLI fake for this host.",
            reason: "not-installed",
          }),
        );
  };
  return {
    forRepository: select,
    forWorkspace: () => select("acme/app"),
    forReference: () => select("acme/app"),
    knownGitLabHosts: Effect.succeed(new Set<string>()),
  } as unknown as GitHostCliRouterShape;
}

function unavailableGitHubCli(): GitHostCliShape {
  return {
    getViewerLogin: () =>
      Effect.fail(
        new GitHostCliError({
          host: "github",
          operation: "getViewerLogin",
          detail: "GitHub CLI is not installed.",
          reason: "not-installed",
        }),
      ),
  } as unknown as GitHostCliShape;
}

function unavailableGitLabCli(): GitHostCliShape {
  return {
    getViewerLogin: () =>
      Effect.fail(
        new GitHostCliError({
          host: "gitlab",
          operation: "getViewerLogin",
          detail: "GitLab CLI is not installed.",
          reason: "not-installed",
        }),
      ),
  } as unknown as GitHostCliShape;
}

describe("project provisioning", () => {
  it("uses authenticated GitHub CLI cloning without forcing SSH or HTTPS", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-provision-" });
        const ghCalls: ReadonlyArray<string>[] = [];
        const github = {
          getViewerLogin: () => Effect.succeed("octocat"),
          execute: (input: Parameters<GitHostCliShape["execute"]>[0]) =>
            Effect.gen(function* () {
              ghCalls.push(input.args);
              yield* fileSystem.makeDirectory(input.args[4] ?? "", { recursive: true });
              return {
                code: 0,
                stdout: "",
                stderr: "",
                signal: null,
                timedOut: false,
              };
            }),
        } as unknown as GitHostCliShape;
        const git = {
          execute: () =>
            Effect.succeed({
              code: 0,
              stdout: "https://github.com/openai/codex.git\n",
              stderr: "",
            }),
        } as unknown as GitCoreShape;
        const provisioner = yield* makeProjectProvisioner({
          homeDir: parent,
          fileSystem,
          path,
          git,
          gitHost: makeGitHostRouter({ github }),
        });
        return {
          provisioned: yield* provisioner.provisionCheckout(makeInput(parent), {
            publish: () => Effect.void,
          }),
          ghCalls,
        };
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(result.provisioned.checkout).toBe("created");
    expect(result.ghCalls).toEqual([
      [
        "repo",
        "clone",
        "--no-upstream",
        "openai/codex",
        expect.stringContaining(".synara-clone-"),
        "--",
        "--progress",
      ],
    ]);
  });

  it("clones a GitLab project by URL with an authenticated glab", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-provision-" });
        const glabCalls: ReadonlyArray<string>[] = [];
        const gitlab = {
          getViewerLogin: () => Effect.succeed("nouchetm"),
          execute: (input: Parameters<GitHostCliShape["execute"]>[0]) =>
            Effect.gen(function* () {
              glabCalls.push(input.args);
              yield* fileSystem.makeDirectory(input.args[3] ?? "", { recursive: true });
              return { code: 0, stdout: "", stderr: "", signal: null, timedOut: false };
            }),
        } as unknown as GitHostCliShape;
        const git = {
          execute: () =>
            Effect.succeed({
              code: 0,
              stdout: "git@gitlab.dotblocks.fr:dotblocks/platform/app.git\n",
              stderr: "",
            }),
        } as unknown as GitCoreShape;
        const provisioner = yield* makeProjectProvisioner({
          homeDir: parent,
          fileSystem,
          path,
          git,
          gitHost: makeGitHostRouter({ gitlab }),
        });
        return {
          provisioned: yield* provisioner.provisionCheckout(
            makeInput(parent, {
              host: "gitlab",
              // A project URL is accepted as-is and canonicalized to `host/group/project`.
              repository: "https://gitlab.dotblocks.fr/dotblocks/platform/app.git",
              directoryName: "app",
            }),
            { publish: () => Effect.void },
          ),
          glabCalls,
        };
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(result.provisioned.checkout).toBe("created");
    expect(result.provisioned.repository).toBe("gitlab.dotblocks.fr/dotblocks/platform/app");
    expect(result.glabCalls).toEqual([
      [
        "repo",
        "clone",
        "https://gitlab.dotblocks.fr/dotblocks/platform/app",
        expect.stringContaining(".synara-clone-"),
        "--",
        "--progress",
      ],
    ]);
  });

  it("defaults a bare GitLab project path to gitlab.com and falls back to git clone", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-provision-" });
        const gitCalls: ReadonlyArray<string>[] = [];
        const git = {
          execute: (input: { operation: string; args: ReadonlyArray<string> }) =>
            Effect.gen(function* () {
              gitCalls.push(input.args);
              if (input.operation === "clone public project") {
                yield* fileSystem.makeDirectory(input.args[4] ?? "", { recursive: true });
                return { code: 0, stdout: "", stderr: "" };
              }
              return {
                code: 0,
                stdout: "https://gitlab.com/dotblocks/platform/app.git\n",
                stderr: "",
              };
            }),
        } as unknown as GitCoreShape;
        const provisioner = yield* makeProjectProvisioner({
          homeDir: parent,
          fileSystem,
          path,
          git,
          gitHost: makeGitHostRouter({ gitlab: unavailableGitLabCli() }),
        });
        return {
          provisioned: yield* provisioner.provisionCheckout(
            makeInput(parent, {
              host: "gitlab",
              repository: "dotblocks/platform/app",
              directoryName: "app",
            }),
            { publish: () => Effect.void },
          ),
          gitCalls,
        };
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(result.provisioned.repository).toBe("gitlab.com/dotblocks/platform/app");
    expect(result.gitCalls[0]).toEqual([
      "clone",
      "--progress",
      "--",
      "https://gitlab.com/dotblocks/platform/app.git",
      expect.stringContaining(".synara-clone-"),
    ]);
  });

  it("rejects a GitLab input that is neither a project path nor a project URL", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-provision-" });
        const provisioner = yield* makeProjectProvisioner({
          homeDir: parent,
          fileSystem,
          path,
          git: {} as unknown as GitCoreShape,
          gitHost: makeGitHostRouter({ gitlab: unavailableGitLabCli() }),
        });
        return yield* provisioner
          .provisionCheckout(makeInput(parent, { host: "gitlab", repository: "app" }), {
            publish: () => Effect.void,
          })
          .pipe(Effect.flip);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(error).toBeInstanceOf(ProjectProvisioningError);
    expect(error.code).toBe("INVALID_REPOSITORY");
    expect(error.message).toBe(
      "Enter a GitLab project as `group/project`, `host/group/project`, or a GitLab project URL.",
    );
  });

  it("clones into staging, verifies origin, and atomically promotes the checkout", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-provision-" });
        const calls: string[] = [];
        const git = {
          execute: (input: Parameters<GitCoreShape["execute"]>[0]) =>
            Effect.gen(function* () {
              calls.push(input.operation);
              if (input.operation === "clone public project") {
                yield* fileSystem.makeDirectory(input.args.at(-1) ?? "", { recursive: true });
                return { code: 0, stdout: "", stderr: "" };
              }
              return {
                code: 0,
                stdout: "https://github.com/openai/codex.git\n",
                stderr: "",
              };
            }),
        } as unknown as GitCoreShape;
        const provisioner = yield* makeProjectProvisioner({
          homeDir: parent,
          fileSystem,
          path,
          git,
          gitHost: makeGitHostRouter({ github: unavailableGitHubCli() }),
        });
        const provisioned = yield* provisioner.provisionCheckout(makeInput(parent), {
          publish: () => Effect.void,
        });
        return {
          provisioned,
          calls,
          entries: yield* fileSystem.readDirectory(parent),
        };
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(result.provisioned.checkout).toBe("created");
    expect(result.provisioned.workspaceRoot).toMatch(/[/\\]codex$/);
    expect(result.entries).toEqual(["codex"]);
    expect(result.calls).toEqual(["clone public project", "verify project clone"]);
  });

  it("reuses an existing checkout with the same origin", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-provision-" });
        yield* fileSystem.makeDirectory(path.join(parent, "codex"));
        const calls: string[] = [];
        const git = {
          execute: (input: Parameters<GitCoreShape["execute"]>[0]) => {
            calls.push(input.operation);
            return Effect.succeed({
              code: 0,
              stdout: "git@github.com:openai/codex.git\n",
              stderr: "",
            });
          },
        } as unknown as GitCoreShape;
        const provisioner = yield* makeProjectProvisioner({
          homeDir: parent,
          fileSystem,
          path,
          git,
          gitHost: makeGitHostRouter({ github: unavailableGitHubCli() }),
        });
        return {
          provisioned: yield* provisioner.provisionCheckout(makeInput(parent), {
            publish: () => Effect.void,
          }),
          calls,
        };
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(result.provisioned.checkout).toBe("reused");
    expect(result.calls).toEqual(["verify project clone"]);
  });

  it("reports a conflict for an existing directory that is not a Git checkout", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-provision-" });
        yield* fileSystem.makeDirectory(path.join(parent, "codex"));
        const git = {
          execute: () =>
            Effect.succeed({
              code: 128,
              stdout: "",
              stderr: "fatal: not a git repository",
            }),
        } as unknown as GitCoreShape;
        const provisioner = yield* makeProjectProvisioner({
          homeDir: parent,
          fileSystem,
          path,
          git,
          gitHost: makeGitHostRouter({ github: unavailableGitHubCli() }),
        });
        return yield* provisioner
          .provisionCheckout(makeInput(parent), { publish: () => Effect.void })
          .pipe(Effect.flip);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(failure.code).toBe("DESTINATION_CONFLICT");
    expect(failure.retryable).toBe(false);
  });

  it("preserves transient Git failures while inspecting an existing checkout", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-provision-" });
        yield* fileSystem.makeDirectory(path.join(parent, "codex"));
        const git = {
          execute: () =>
            Effect.fail(
              new GitCommandError({
                operation: "verify project clone",
                command: "git remote get-url origin",
                cwd: path.join(parent, "codex"),
                detail: "connection reset",
              }),
            ),
        } as unknown as GitCoreShape;
        const provisioner = yield* makeProjectProvisioner({
          homeDir: parent,
          fileSystem,
          path,
          git,
          gitHost: makeGitHostRouter({ github: unavailableGitHubCli() }),
        });
        return yield* provisioner
          .provisionCheckout(makeInput(parent), { publish: () => Effect.void })
          .pipe(Effect.flip);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(failure.code).toBe("NETWORK_ERROR");
    expect(failure.retryable).toBe(true);
  });

  it("removes only its owned staging directory after a failed clone", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-provision-" });
        const git = {
          execute: (input: Parameters<GitCoreShape["execute"]>[0]) =>
            Effect.gen(function* () {
              const stagingPath = input.args.at(-1) ?? "";
              yield* fileSystem.makeDirectory(stagingPath, { recursive: true });
              return yield* new GitCommandError({
                operation: input.operation,
                command: "git clone",
                cwd: input.cwd,
                detail: "connection reset",
              });
            }),
        } as unknown as GitCoreShape;
        const provisioner = yield* makeProjectProvisioner({
          homeDir: parent,
          fileSystem,
          path,
          git,
          gitHost: makeGitHostRouter({ github: unavailableGitHubCli() }),
        });
        const failure = yield* provisioner
          .provisionCheckout(makeInput(parent), { publish: () => Effect.void })
          .pipe(Effect.flip);
        return { failure, entries: yield* fileSystem.readDirectory(parent) };
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(result.failure).toBeInstanceOf(ProjectProvisioningError);
    expect(result.failure.code).toBe("NETWORK_ERROR");
    expect(result.entries).toEqual([]);
  });

  it("classifies Git HTTPS 403 responses as an authentication problem", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-provision-" });
        const git = {
          execute: (input: Parameters<GitCoreShape["execute"]>[0]) =>
            Effect.fail(
              new GitCommandError({
                operation: input.operation,
                command: "git clone",
                cwd: input.cwd,
                detail: "fatal: unable to access repository: The requested URL returned error: 403",
              }),
            ),
        } as unknown as GitCoreShape;
        const provisioner = yield* makeProjectProvisioner({
          homeDir: parent,
          fileSystem,
          path,
          git,
          gitHost: makeGitHostRouter({ github: unavailableGitHubCli() }),
        });
        return yield* provisioner
          .provisionCheckout(makeInput(parent), { publish: () => Effect.void })
          .pipe(Effect.flip);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(failure.code).toBe("AUTH_REQUIRED");
    expect(failure.retryable).toBe(false);
  });

  it("distinguishes the configured clone timeout from a network timeout", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-provision-" });
        const git = {
          execute: (input: Parameters<GitCoreShape["execute"]>[0]) =>
            Effect.fail(
              new GitCommandError({
                operation: input.operation,
                command: "git clone",
                cwd: input.cwd,
                detail: "git clone timed out.",
              }),
            ),
        } as unknown as GitCoreShape;
        const provisioner = yield* makeProjectProvisioner({
          homeDir: parent,
          fileSystem,
          path,
          git,
          gitHost: makeGitHostRouter({ github: unavailableGitHubCli() }),
        });
        return yield* provisioner
          .provisionCheckout(makeInput(parent), { publish: () => Effect.void })
          .pipe(Effect.flip);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(failure.code).toBe("CLONE_TIMEOUT");
    expect(failure.retryable).toBe(false);
    expect(failure.message).toContain("30-minute limit");
  });

  it("reports a destination conflict when the target appears during promotion", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-provision-" });
        const git = {
          execute: (input: Parameters<GitCoreShape["execute"]>[0]) =>
            Effect.gen(function* () {
              if (input.operation === "clone public project") {
                yield* fileSystem.makeDirectory(input.args.at(-1) ?? "", { recursive: true });
                return { code: 0, stdout: "", stderr: "" };
              }
              return {
                code: 0,
                stdout: "https://github.com/openai/codex.git\n",
                stderr: "",
              };
            }),
        } as unknown as GitCoreShape;
        const fileSystemWithPromotionRace = {
          ...fileSystem,
          rename: () =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "AlreadyExists",
                module: "FileSystem",
                method: "rename",
              }),
            ),
        } satisfies FileSystem.FileSystem;
        const provisioner = yield* makeProjectProvisioner({
          homeDir: parent,
          fileSystem: fileSystemWithPromotionRace,
          path,
          git,
          gitHost: makeGitHostRouter({ github: unavailableGitHubCli() }),
        });
        return yield* provisioner
          .provisionCheckout(makeInput(parent), { publish: () => Effect.void })
          .pipe(Effect.flip);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(failure.code).toBe("DESTINATION_CONFLICT");
    expect(failure.retryable).toBe(false);
  });

  it("removes its staging directory when an in-flight clone is cancelled", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-provision-" });
        const cloneStarted = yield* Deferred.make<void>();
        const git = {
          execute: (input: Parameters<GitCoreShape["execute"]>[0]) =>
            Effect.gen(function* () {
              const stagingPath = input.args.at(-1) ?? "";
              yield* fileSystem.makeDirectory(stagingPath, { recursive: true });
              yield* Deferred.succeed(cloneStarted, undefined);
              return yield* Effect.never;
            }),
        } as unknown as GitCoreShape;
        const provisioner = yield* makeProjectProvisioner({
          homeDir: parent,
          fileSystem,
          path,
          git,
          gitHost: makeGitHostRouter({ github: unavailableGitHubCli() }),
        });
        const fiber = yield* provisioner
          .provisionCheckout(makeInput(parent), {
            publish: () => Effect.void,
          })
          .pipe(Effect.forkScoped);

        yield* Deferred.await(cloneStarted);
        yield* Fiber.interrupt(fiber);
        return yield* fileSystem.readDirectory(parent);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(result).toEqual([]);
  });
});
