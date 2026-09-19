/**
 * The AT-SPI helper's own tests, and its request framing, run against the real
 * interpreter. `atspi_helper_test.py` exercises the search, scoring, budget and
 * write logic through fakes; the framing tests below drive the real process
 * through its stdio with the malformed input a live client can produce and
 * check that each line costs exactly one reply and never the process.
 *
 * Nothing here touches a live accessibility bus: the unit tests fake Atspi,
 * and the framing tests only send requests the helper answers before reaching
 * the desktop, under an environment that points AT-SPI at a dead socket.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const HELPER_DIR = import.meta.dirname;
const HELPER_PATH = join(HELPER_DIR, "atspi_helper.py");
const UNITTEST_FILE = "atspi_helper_test.py";
const PYTHON = process.env.SYNARA_ATSPI_PYTHON ?? "python3";
const hasPython = spawnSync(PYTHON, ["--version"], { stdio: "ignore" }).status === 0;
/** Bound on one reply from a freshly spawned helper, interpreter start included. */
const REPLY_TIMEOUT_MS = 20_000;
const HELPER_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  PYTHONUNBUFFERED: "1",
  PYTHONDONTWRITEBYTECODE: "1",
  // Even if a request slipped past the pre-Atspi paths, there is no bus here.
  AT_SPI_BUS_ADDRESS: "unix:path=/nonexistent/synara-atspi-helper-test",
  NO_AT_BRIDGE: "1",
};

describe.skipIf(!hasPython)("atspi_helper.py", () => {
  it("passes its python unit tests", () => {
    // unittest turns a file path into a module name relative to the cwd, so
    // the run is anchored in the helper's directory rather than wherever
    // Vitest happens to be running from.
    const run = spawnSync(PYTHON, ["-m", "unittest", UNITTEST_FILE], {
      cwd: HELPER_DIR,
      encoding: "utf8",
      env: HELPER_ENV,
      timeout: 120_000,
    });
    if (run.status !== 0) {
      expect.fail(
        `python unittest exited with ${run.status ?? run.signal}\n${run.stdout}\n${run.stderr}`,
      );
    }
  });

  describe("framing", () => {
    it("answers invalid UTF-8 with one error line for a null id", async () => {
      await withHelper(async (helper) => {
        // `{"\xff\xfe"}`: the bad bytes decode with replacement and the line
        // then fails to parse, so no request id is ever known.
        const reply = await helper.exchange(
          Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d, 0x0a]),
        );
        expectErrorReply(reply, null);
      });
    });

    it("answers an unterminated JSON object with one error line for a null id", async () => {
      await withHelper(async (helper) => {
        const reply = await helper.exchange('{"jsonrpc":"2.0","id":3,"method":"probe"\n');
        expectErrorReply(reply, null);
      });
    });

    it("answers a request without an id with a null-id envelope", async () => {
      await withHelper(async (helper) => {
        // A valid request the helper refuses on its parameters, before it
        // would touch the desktop.
        const reply = await helper.exchange('{"jsonrpc":"2.0","method":"set-text","params":{}}\n');
        expectErrorReply(reply, null);
      });
    });

    it("answers an unknown method with an error carrying the request id", async () => {
      await withHelper(async (helper) => {
        const reply = await helper.exchange('{"jsonrpc":"2.0","id":7,"method":"no-such-method"}\n');
        expectErrorReply(reply, 7);
      });
    });

    it("answers probe with whether AT-SPI imported, without touching the desktop", async () => {
      await withHelper(async (helper) => {
        const reply = await helper.exchange('{"jsonrpc":"2.0","id":8,"method":"probe"}\n');
        expect(reply).toMatchObject({ jsonrpc: "2.0", id: 8 });
        const result = (reply as { result: Record<string, unknown> }).result;
        expect(result.ok).toBe(true);
        expect(typeof result.atspi).toBe("boolean");
        expect(result.atspi ? result.reason === null : typeof result.reason === "string").toBe(
          true,
        );
      });
    });
  });
});

function expectErrorReply(reply: unknown, id: number | null): void {
  expect(reply).toMatchObject({ jsonrpc: "2.0", id, error: { code: -32000 } });
  expect(typeof (reply as { error: { message: unknown } }).error.message).toBe("string");
  expect(reply).not.toHaveProperty("result");
}

/**
 * Runs `body` against a fresh helper, then proves the helper survived it: a
 * final probe must be answered by the very next line, which also shows the
 * exchange before it produced exactly one reply and nothing trailing.
 */
async function withHelper(body: (helper: HelperSession) => Promise<void>): Promise<void> {
  const helper = new HelperSession();
  try {
    await body(helper);
    const reply = await helper.exchange('{"jsonrpc":"2.0","id":99,"method":"probe"}\n');
    expect(reply).toMatchObject({ jsonrpc: "2.0", id: 99, result: { ok: true } });
    expect(helper.alive()).toBe(true);
  } finally {
    helper.kill();
  }
}

/** One real helper process, driven a line at a time. */
class HelperSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: string[] = [];
  private readonly waiters: Array<(line: string) => void> = [];
  private buffered = "";
  private stderr = "";
  private exit: string | null = null;

  constructor() {
    this.child = spawn(PYTHON, ["-u", HELPER_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      env: HELPER_ENV,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffered += chunk;
      let newline = this.buffered.indexOf("\n");
      while (newline !== -1) {
        const line = this.buffered.slice(0, newline);
        this.buffered = this.buffered.slice(newline + 1);
        const waiter = this.waiters.shift();
        if (waiter) waiter(line);
        else this.lines.push(line);
        newline = this.buffered.indexOf("\n");
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4096);
    });
    this.child.on("exit", (code, signal) => {
      this.exit = `code=${code ?? "null"} signal=${signal ?? "null"}`;
    });
  }

  /** Writes one line and returns the next reply line, parsed. */
  async exchange(line: string | Buffer): Promise<unknown> {
    this.child.stdin.write(line);
    return JSON.parse(await this.nextLine());
  }

  alive(): boolean {
    return this.exit === null && this.child.exitCode === null && this.child.signalCode === null;
  }

  kill(): void {
    this.child.stdin.end();
    if (this.alive()) this.child.kill("SIGKILL");
  }

  private nextLine(): Promise<string> {
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise<string>((resolve, reject) => {
      const waiter = (line: string) => {
        clearTimeout(timer);
        resolve(line);
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(
          new Error(
            `No reply from the AT-SPI helper within ${REPLY_TIMEOUT_MS} ms (${this.exit ?? "running"}).\n${this.stderr}`,
          ),
        );
      }, REPLY_TIMEOUT_MS);
      this.waiters.push(waiter);
    });
  }
}
