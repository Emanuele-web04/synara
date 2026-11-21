import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { reportReliabilityIssue } from "../reliability";
import { startCloudflareConnector } from "./connector";

vi.mock("../reliability", () => ({ reportReliabilityIssue: vi.fn() }));

let home: string;
beforeEach(async () => {
  home = await fsp.mkdtemp(join(tmpdir(), "synara-connector-exit-"));
});
afterEach(async () => {
  vi.mocked(reportReliabilityIssue).mockClear();
  await fsp.rm(home, { recursive: true, force: true });
});

function start(executable: string, ready: (value: boolean) => void = () => {}) {
  return startCloudflareConnector({
    executable: async () => executable,
    home,
    configurationFile: join(home, "managed.yml"),
    token: async () => "fixture-only-token",
    ready,
    signal: new AbortController().signal,
  });
}

it("reports a connector that exits on its own", async () => {
  // The runtime rejects the connector arguments and exits at once.
  const connector = start(process.execPath);
  try {
    await vi.waitFor(
      () => expect(reportReliabilityIssue).toHaveBeenCalledWith("remote.connector_exited"),
      { timeout: 10_000, interval: 50 },
    );
  } finally {
    await connector.stop();
  }
});

// The fixture relies on an executable shebang.
it.skipIf(process.platform === "win32")("does not report a connector this host stops", async () => {
  const executable = join(home, "connector.sh");
  await fsp.writeFile(executable, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
  let probes = 0;
  // The first readiness update precedes the spawn; later ones follow a probe of the child.
  const connector = start(executable, () => probes++);
  await vi.waitFor(() => expect(probes).toBeGreaterThanOrEqual(2), {
    timeout: 10_000,
    interval: 50,
  });
  await connector.stop();
  expect(reportReliabilityIssue).not.toHaveBeenCalled();
});
