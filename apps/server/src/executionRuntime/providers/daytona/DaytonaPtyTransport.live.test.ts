/**
 * Daytona PTY transport LIVE integration test.
 *
 * The fake-socket unit tests in {@link ./DaytonaPtyTransport.test.ts} cannot
 * cover the behavior that broke L4: the live daemon (v0.184.0) ignores the PTY
 * create-body command and attaches a bare interactive shell, so codex must be
 * launched by writing `exec <command>` into the PTY's stdin after connect. This
 * test drives the *real* `liveDaytonaPtyConnect` + `makeDaytonaPtySession`
 * against a freshly created sandbox and asserts a JSON-RPC frame reaches the
 * consumer clean (through the real WS, the real shell echo, and the real ANSI
 * noise) and the WS close maps to the launched program's exit code.
 *
 * A codex-bearing snapshot is not required: a tiny shell stand-in emits a
 * `ready`-shaped JSON-RPC frame and exits, exercising the launch + readiness +
 * exit path end to end without provisioning the full agent toolchain.
 *
 * Opt-in only. Requires both `DAYTONA_PTY_LIVE=1` and real `DAYTONA_API_KEY`
 * credentials, so a stray key in a dev shell never creates a billable sandbox in
 * a normal test run. The sandbox is always destroyed in `finally`.
 *
 * @module daytona/DaytonaPtyTransport.live.test
 */
import { afterEach, describe, expect, it } from "vitest";

import { resolveDaytonaCredentials } from "./DaytonaConfig.ts";

interface DisposableRuntime {
  dispose(): Promise<void>;
}

const credentials = resolveDaytonaCredentials(process.env);
const liveEnabled = process.env.DAYTONA_PTY_LIVE === "1" && credentials !== null;

const describeLive = liveEnabled ? describe : describe.skip;

const quoteArg = (value: string): string => `'${value.split("'").join("'\\''")}'`;

describeLive("Daytona PTY transport (live)", () => {
  if (credentials === null) {
    it.skip("requires Daytona credentials", () => {});
    return;
  }
  const apiUrl = credentials.apiUrl;
  const proxyBaseUrl = (() => {
    const parsed = new URL(apiUrl);
    return `${parsed.protocol}//proxy.${parsed.host}`;
  })();
  const authHeaders: Record<string, string> = {
    authorization: `Bearer ${credentials.apiKey}`,
    "content-type": "application/json",
  };

  let sandboxId: string | undefined;
  let runtime: DisposableRuntime | undefined;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose().catch(() => {});
      runtime = undefined;
    }
    if (sandboxId !== undefined) {
      await fetch(`${apiUrl}/sandbox/${sandboxId}/archive`, {
        method: "POST",
        headers: authHeaders,
      }).catch(() => {});
      await fetch(`${apiUrl}/sandbox/${sandboxId}`, {
        method: "DELETE",
        headers: authHeaders,
      }).catch(() => {});
      sandboxId = undefined;
    }
  });

  it("launches over stdin, streams a JSON-RPC frame, and maps the WS close to exit", async () => {
    const [{ Effect, ManagedRuntime, Stream }, { FetchHttpClient, HttpClient, HttpClientRequest }] =
      await Promise.all([import("effect"), import("effect/unstable/http")]);
    const { liveDaytonaPtyConnect } = await import("./DaytonaPtyConnector.ts");
    const { makeDaytonaPtySession } = await import("./DaytonaPtyTransport.ts");

    const createRes = await fetch(`${apiUrl}/sandbox`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ labels: { "synara.test": "pty-live" } }),
    });
    const sandbox = (await createRes.json()) as { id: string; state?: string };
    sandboxId = sandbox.id;

    for (let attempt = 0; attempt < 15; attempt += 1) {
      const status = (await (
        await fetch(`${apiUrl}/sandbox/${sandboxId}`, { headers: authHeaders })
      ).json()) as { state?: string };
      if (status.state === "started") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    // Stand-in for codex: emit a ready-shaped JSON-RPC frame, then a plain log
    // line, then exit 0. `bash -lc` + `stty -echo` mirror the real launch.
    const inner = `printf '%s\\n' '{"jsonrpc":"2.0","method":"session/ready"}'; echo plain-startup-log; exit 0`;
    const command = `bash -lc ${quoteArg(`stty -echo 2>/dev/null; bash -lc ${quoteArg(inner)}`)}`;

    const made = ManagedRuntime.make(FetchHttpClient.layer);
    runtime = made;

    const program = Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const connection = yield* liveDaytonaPtyConnect({
        proxyBaseUrl,
        sandboxId: sandbox.id,
        cwd: undefined,
        envs: undefined,
        authorize: (request) => HttpClientRequest.bearerToken(request, credentials.apiKey),
        wsHeaders: { authorization: `Bearer ${credentials.apiKey}` },
        redact: (value) => value,
      }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
      const session = yield* makeDaytonaPtySession(connection, {
        command,
        readyTimeout: "5 seconds",
      });
      const lines = yield* session.stdoutLines.pipe(Stream.runCollect);
      const exit = yield* session.exit;
      yield* session.close;
      return { lines: Array.from(lines), exit };
    });

    const result = await made.runPromise(program);

    // The real JSON-RPC frame arrived clean on its own line (the shell prompt
    // and launch echo are separate, ANSI-laden lines the consumer's classifier
    // strips/suppresses) and parses as JSON.
    const ready = result.lines.find((line) => {
      try {
        return (JSON.parse(line) as { method?: unknown }).method === "session/ready";
      } catch {
        return false;
      }
    });
    expect(ready).toBe('{"jsonrpc":"2.0","method":"session/ready"}');
    // `exec` replaced the shell, so the WS close code is the program's exit.
    expect(result.exit).toEqual({ code: 0, signal: null });
  }, 60_000);
});
