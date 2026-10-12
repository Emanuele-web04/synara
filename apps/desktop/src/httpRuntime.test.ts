import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("completes HTTP requests when the socket rejects QoS marking", () => {
  // An isolated process exercises Node's actual fetch and the desktop's
  // dispatcher bootstrap, without changing Vitest's networking or globals.
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from "node:assert/strict";
    import { createServer } from "node:http";
    import { Socket } from "node:net";
    import { once } from "node:events";
    let markings = 0;
    Socket.prototype.setTypeOfService = function () {
      markings++;
      throw Object.assign(new Error("setTypeOfService EINVAL"), { code: "EINVAL", syscall: "setTypeOfService" });
    };
    await import(${JSON.stringify(new URL("./httpRuntime.ts", import.meta.url).href)});
    const server = createServer((_req, res) => res.end("ready"));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = "http://127.0.0.1:" + server.address().port;
    let dispatcher;
    try {
      const response = await fetch(url);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "ready");
      assert.equal(markings, 0, "default fetch should not mark a fresh socket");
      const { request, getGlobalDispatcher } = await import("undici");
      dispatcher = getGlobalDispatcher();
      const prioritized = await request(url, { typeOfService: 4 });
      assert.equal(prioritized.statusCode, 200);
      assert.equal(await prioritized.body.text(), "ready");
      assert.ok(markings > 0, "explicit QoS must exercise the throwing socket method");
      assert.equal(await (await fetch(url)).text(), "ready");
      await dispatcher.close();
      server.close();
      await once(server, "close");
      await assert.rejects(fetch(url), /fetch failed/);
    } finally {
      await dispatcher?.destroy();
      server.closeAllConnections();
      server.close();
    }
  `,
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.stderr).not.toContain("setTypeOfService EINVAL");
  expect(result.status, result.stderr || result.stdout).toBe(0);
});
