import { existsSync } from "node:fs";
import nodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ExecutionInstanceId } from "@t3tools/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { runProcess } from "../../processRunner.ts";
import { FakeRuntimeProviderAdapter } from "../Services/FakeRuntimeProviderAdapter.ts";
import { RuntimeActivityLeaseManager } from "../Services/RuntimeActivityLeaseManager.ts";
import { RuntimeCredentialBroker } from "../Services/RuntimeCredentialBroker.ts";
import { RuntimeGitWorkspace } from "../Services/RuntimeGitWorkspace.ts";
import { FakeRuntimeProviderAdapterLive } from "./FakeRuntimeProviderAdapter.ts";
import { RuntimeActivityLeaseManagerLive } from "./RuntimeActivityLeaseManager.ts";
import { RuntimeCredentialBrokerLive } from "./RuntimeCredentialBroker.ts";
import { RuntimeGitWorkspaceLive } from "./RuntimeGitWorkspace.ts";
import { redactSecrets, redactUrlCredentials } from "./redactCredentials.ts";

const makeTestRuntime = () => {
  const layer = Layer.mergeAll(
    FakeRuntimeProviderAdapterLive,
    RuntimeGitWorkspaceLive.pipe(Layer.provide(FakeRuntimeProviderAdapterLive)),
    RuntimeActivityLeaseManagerLive,
    RuntimeCredentialBrokerLive,
  ).pipe(Layer.provideMerge(NodeServices.layer));
  return ManagedRuntime.make(layer);
};

type TestRuntime = ReturnType<typeof makeTestRuntime>;

/** Build a bare git repo with one commit, standing in for a private remote. */
const makeBareRemote = async (): Promise<{ readonly remote: string; readonly seed: string }> => {
  const base = await runProcess("mktemp", ["-d", "-t", "synara-runtime-git"]);
  const root = base.stdout.trim();
  const remote = nodePath.join(root, "remote.git");
  const seed = nodePath.join(root, "seed");
  await runProcess("git", ["init", "--bare", remote]);
  await runProcess("git", ["init", seed]);
  await runProcess("git", ["-C", seed, "config", "user.email", "t@example.com"]);
  await runProcess("git", ["-C", seed, "config", "user.name", "Test"]);
  await runProcess("git", ["-C", seed, "config", "commit.gpgsign", "false"]);
  await runProcess("bash", ["-c", `printf 'hello\\n' > ${nodePath.join(seed, "README.md")}`]);
  await runProcess("git", ["-C", seed, "add", "."]);
  await runProcess("git", ["-C", seed, "commit", "-m", "init"]);
  await runProcess("git", ["-C", seed, "branch", "-M", "main"]);
  await runProcess("git", ["-C", seed, "remote", "add", "origin", remote]);
  await runProcess("git", ["-C", seed, "push", "origin", "main"]);
  await runProcess("git", ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  return { remote, seed };
};

const provisionInstance = (runtime: TestRuntime) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const adapter = yield* FakeRuntimeProviderAdapter;
      const context = yield* adapter.provision({
        threadId: "thread-git",
        flavor: "fake-pty-workspace",
      });
      return context;
    }),
  );

describe("RuntimeGitWorkspace v1", () => {
  let runtime: TestRuntime | undefined;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
      runtime = undefined;
    }
  });

  it("clones a private repo against a fake remote and reads status + diff", async () => {
    runtime = makeTestRuntime();
    const localRuntime = runtime;
    const { remote } = await makeBareRemote();
    const context = await provisionInstance(localRuntime);

    // A tokenized URL stands in for an authenticated clone. Git uses the file
    // path; the embedded credential is what must never leak into logs/errors.
    const token = "ghs_SUPERSECRETTOKEN1234567890";
    const repoUrl = `https://x-access-token:${token}@example.invalid/repo.git`;

    // Clone the real file remote (the token form is exercised by the redaction
    // and failure assertions below; a file URL cannot carry userinfo).
    await localRuntime.runPromise(
      Effect.gen(function* () {
        const git = yield* RuntimeGitWorkspace;
        yield* git.clone({
          instanceId: context.instance.id,
          repoUrl: remote,
          ref: "main",
          targetPath: "checkout",
        });
      }),
    );

    const checkoutPath = nodePath.join(context.rootPath, "checkout");
    expect(existsSync(nodePath.join(checkoutPath, "README.md"))).toBe(true);

    // A dirty change shows up in --porcelain status.
    await runProcess("bash", [
      "-c",
      `printf 'changed\\n' >> ${nodePath.join(checkoutPath, "README.md")}`,
    ]);
    await runProcess("bash", [
      "-c",
      `printf 'new\\n' > ${nodePath.join(checkoutPath, "added.txt")}`,
    ]);

    const status = await localRuntime.runPromise(
      Effect.gen(function* () {
        const git = yield* RuntimeGitWorkspace;
        return yield* git.status({ instanceId: context.instance.id, workdir: "checkout" });
      }),
    );
    const paths = status.map((entry) => entry.path);
    expect(paths).toContain("README.md");
    expect(paths).toContain("added.txt");
    const readmeEntry = status.find((entry) => entry.path === "README.md");
    expect(readmeEntry?.status).toContain("M");

    const diff = await localRuntime.runPromise(
      Effect.gen(function* () {
        const git = yield* RuntimeGitWorkspace;
        return yield* git.diff({ instanceId: context.instance.id, workdir: "checkout" });
      }),
    );
    expect(diff).toContain("README.md");
    expect(diff).toContain("changed");

    // The token never appears in a failure detail: a clone to a bad tokenized
    // URL fails, and the error message is redacted of the secret.
    const failure = await localRuntime.runPromiseExit(
      Effect.gen(function* () {
        const git = yield* RuntimeGitWorkspace;
        yield* git.clone({
          instanceId: context.instance.id,
          repoUrl,
          ref: "main",
          targetPath: "tokenized-checkout",
        });
      }),
    );
    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure") {
      const error = failure.cause;
      const rendered = JSON.stringify(error);
      expect(rendered).not.toContain(token);
    }
  });

  it("fails on a missing instance with a redacted error", async () => {
    runtime = makeTestRuntime();
    const localRuntime = runtime;

    const exit = await localRuntime.runPromiseExit(
      Effect.gen(function* () {
        const git = yield* RuntimeGitWorkspace;
        yield* git.clone({
          instanceId: ExecutionInstanceId.makeUnsafe("never-provisioned"),
          repoUrl: "https://user:tok@example.invalid/x.git",
          ref: "main",
          targetPath: "x",
        });
      }),
    );
    expect(exit._tag).toBe("Failure");
    expect(JSON.stringify(exit)).not.toContain("tok@");
  });
});

describe("redactCredentials", () => {
  it("strips userinfo from a tokenized URL", () => {
    expect(redactUrlCredentials("https://x-access-token:SECRET@github.com/o/r.git")).toBe(
      "https://***@github.com/o/r.git",
    );
    // ssh-style and path-embedded @ are untouched.
    expect(redactUrlCredentials("https://github.com/o/r.git")).toBe("https://github.com/o/r.git");
  });

  it("masks raw secret values that survive URL redaction", () => {
    const out = redactSecrets("error: token=abc123 leaked", ["abc123"]);
    expect(out).toBe("error: token=*** leaked");
    // Empty secrets cannot blank the string.
    expect(redactSecrets("untouched", ["", "   "])).toBe("untouched");
  });
});

describe("RuntimeActivityLeaseManager", () => {
  let runtime: TestRuntime | undefined;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
      runtime = undefined;
    }
  });

  it("acquires, renews, and releases a lease", async () => {
    runtime = makeTestRuntime();
    const localRuntime = runtime;
    const instanceId = ExecutionInstanceId.makeUnsafe("instance-lease");

    const lease = await localRuntime.runPromise(
      Effect.gen(function* () {
        const leases = yield* RuntimeActivityLeaseManager;
        return yield* leases.acquire({ instanceId, reason: "turn" });
      }),
    );
    expect(lease.reason).toBe("turn");
    expect(lease.renewedAt).toBeNull();

    const renewed = await localRuntime.runPromise(
      Effect.gen(function* () {
        const leases = yield* RuntimeActivityLeaseManager;
        return yield* leases.renew(lease.id);
      }),
    );
    expect(renewed.id).toBe(lease.id);
    expect(renewed.reason).toBe("turn");
    expect(renewed.acquiredAt).toBe(lease.acquiredAt);
    expect(renewed.renewedAt).not.toBeNull();

    // Release is terminal; releasing twice is a no-op.
    await localRuntime.runPromise(
      Effect.gen(function* () {
        const leases = yield* RuntimeActivityLeaseManager;
        yield* leases.release(lease.id);
        yield* leases.release(lease.id);
      }),
    );
  });
});

describe("RuntimeCredentialBroker", () => {
  let runtime: TestRuntime | undefined;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
      runtime = undefined;
    }
  });

  it("never returns raw tokens, scopes setup below agent, and flags secret-tainting kinds", async () => {
    runtime = makeTestRuntime();
    const localRuntime = runtime;

    const agentGrants = await localRuntime.runPromise(
      Effect.gen(function* () {
        const broker = yield* RuntimeCredentialBroker;
        return yield* broker.grantFor({
          role: "agent",
          kinds: ["env-var", "provider-secret", "ssh-agent", "git-credential-helper"],
        });
      }),
    );
    // Handles are opaque references, never the kind value verbatim as a secret.
    for (const grant of agentGrants) {
      expect(grant.handle.startsWith("cred:agent:")).toBe(true);
    }
    expect(agentGrants.find((g) => g.kind === "provider-secret")?.secretTainted).toBe(true);
    expect(agentGrants.find((g) => g.kind === "env-var")?.secretTainted).toBe(true);
    expect(agentGrants.find((g) => g.kind === "ssh-agent")?.secretTainted).toBe(false);
    expect(agentGrants.find((g) => g.kind === "git-credential-helper")?.secretTainted).toBe(false);

    const setupGrants = await localRuntime.runPromise(
      Effect.gen(function* () {
        const broker = yield* RuntimeCredentialBroker;
        return yield* broker.grantFor({
          role: "setup",
          kinds: ["env-var", "provider-secret", "git-credential-helper", "outbound-proxy"],
        });
      }),
    );
    const setupKinds = setupGrants.map((g) => g.kind);
    // Setup gets strictly fewer secrets: no env-var, no provider-secret.
    expect(setupKinds).not.toContain("env-var");
    expect(setupKinds).not.toContain("provider-secret");
    expect(setupKinds).toContain("git-credential-helper");
    expect(setupKinds).toContain("outbound-proxy");
    // No grant is secret-tainted for setup (only handle-style references remain).
    expect(setupGrants.every((g) => g.secretTainted === false)).toBe(true);
  });

  it("deduplicates repeated kinds", async () => {
    runtime = makeTestRuntime();
    const localRuntime = runtime;
    const grants = await localRuntime.runPromise(
      Effect.gen(function* () {
        const broker = yield* RuntimeCredentialBroker;
        return yield* broker.grantFor({
          role: "agent",
          kinds: ["env-var", "env-var", "ssh-agent"],
        });
      }),
    );
    expect(grants.length).toBe(2);
  });
});
