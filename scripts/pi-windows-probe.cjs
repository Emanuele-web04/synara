// Run with the EXTRACTED Synara executable and ELECTRON_RUN_AS_NODE=1:
// Synara.exe pi-windows-probe.cjs <resources/app.asar>
// Local control only: SYNARA_PROBE_LOCAL_CONTROL=1 node probe.cjs <checkout> <compactDatabase.mjs>
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { tmpdir } = require("node:os");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");

async function main() {
  const appRoot = path.resolve(process.argv[2] || "");
  const localControl = process.env.SYNARA_PROBE_LOCAL_CONTROL === "1";
  assert(
    localControl ||
      (process.platform === "win32" && process.versions.electron && appRoot.endsWith(".asar")),
    "Expected packaged Windows Electron and app.asar",
  );
  const temp = fs.mkdtempSync(path.join(tmpdir(), "Synara Pi packaged smoke "));
  // Drop credentials, loaders and external module search paths before loading any SDK.
  const allowed = new Set([
    "path",
    "pathext",
    "systemroot",
    "windir",
    "comspec",
    "temp",
    "tmp",
    "electron_run_as_node",
  ]);
  for (const key of Object.keys(process.env))
    if (!allowed.has(key.toLowerCase())) delete process.env[key];
  Object.assign(process.env, {
    HOME: temp,
    USERPROFILE: temp,
    APPDATA: path.join(temp, "appdata"),
    LOCALAPPDATA: path.join(temp, "localappdata"),
    XDG_CONFIG_HOME: path.join(temp, "config"),
    XDG_CACHE_HOME: path.join(temp, "cache"),
    XDG_DATA_HOME: path.join(temp, "data"),
    SYNARA_HOME: path.join(temp, "synara"),
    SYNARA_BETA_HOME: path.join(temp, "synara-beta"),
    PI_CODING_AGENT_DIR: path.join(temp, "pi"),
    PI_OFFLINE: "1",
    SYNARA_DISABLE_AUTO_UPDATE: "1",
  });
  for (const key of [
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "SYNARA_HOME",
    "SYNARA_BETA_HOME",
    "PI_CODING_AGENT_DIR",
  ])
    fs.mkdirSync(process.env[key], { recursive: true });
  process.chdir(temp);
  const report = {
    mode: localControl ? "local-control" : "packaged-windows",
    electron: process.versions.electron,
    node: process.versions.node,
    checks: [],
  };
  function packageEntry(name, parentEntry) {
    const lookup = createRequire(parentEntry);
    for (const dir of lookup.resolve.paths(name) || []) {
      const manifest = path.join(dir, name, "package.json");
      if (!fs.existsSync(manifest)) continue;
      const root = fs.realpathSync(path.dirname(manifest));
      const relative = path.relative(fs.realpathSync(appRoot), root);
      assert(
        !relative.startsWith("..") && !path.isAbsolute(relative),
        `${name} escaped the artifact`,
      );
      const metadata = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (name.startsWith("@earendil-works/pi-")) assert.equal(metadata.version, "1.4.0");
      return path.join(root, metadata.main || "index.js");
    }
    throw new Error(`Missing packaged dependency: ${name}`);
  }
  const serverEntry = path.join(appRoot, "apps/server/dist/runtimeDependencySmoke.mjs");
  assert(fs.existsSync(serverEntry), "Missing compiled server smoke entry");
  const piEntry = packageEntry("@earendil-works/pi-coding-agent", serverEntry);
  let sandbox;
  let client;
  try {
    const pi = await import(pathToFileURL(piEntry).href);
    for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-agent-core"])
      await import(pathToFileURL(packageEntry(name, piEntry)).href);
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    fs.writeFileSync(
      path.join(agentDir, "auth.json"),
      JSON.stringify({
        openai: {
          type: "oauth",
          access: "synthetic-token",
          refresh: "synthetic-refresh",
          expires: 4102444800000,
          clientId: "synthetic-client",
          scopes: ["chatgpt.tokens.use.direct", "resource.invoke"],
        },
      }),
    );
    const runtime = await pi.ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
      allowModelNetwork: false,
    });
    assert(
      new pi.ModelRegistry(runtime)
        .getAvailable()
        .some((model) => model.provider === "openai" && model.id === "gpt-5.4"),
    );
    assert.equal((await runtime.getAuth("openai")).auth.apiKey, "synthetic-token");
    report.checks.push("Pi 1.4.0: three packaged SDKs, offline ChatGPT discovery/auth");

    const codemode = await import(
      pathToFileURL(packageEntry("@earendil-works/pi-codemode", piEntry)).href
    );
    const workerExits = [];
    sandbox = new codemode.CodemodeSandbox({
      timeoutMs: 10000,
      onWorkerStarted: (exited) => workerExits.push(exited),
      tools: [{ name: "add", execute: async (args) => args.a + args.b }],
    });
    const executed = await sandbox.execute(
      "const answer = await tools.add({a:19,b:23}); text(answer); return answer;",
    );
    assert.equal(executed.ok, true, JSON.stringify(executed.error));
    assert.equal(executed.value, 42);
    assert(executed.output.some((item) => item.type === "text" && item.text === "42"));
    await sandbox.close();
    sandbox = undefined;
    await Promise.all(workerExits);
    report.checks.push(
      "Codemode: actual worker + QuickJS WASM + host-tool round trip, worker exited",
    );

    // A valid PNG decoded by Photon, not merely an imported WASM wrapper.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAAB/qH1jAAAAEklEQVR4nGP4z8DwHxkzoAsAAA8hD/EEN8afAAAAAElFTkSuQmCC",
      "base64",
    );
    const resized = await pi.resizeImage(png, "image/png", {
      maxWidth: 1,
      maxHeight: 1,
      maxBytes: 4096,
    });
    assert(resized, "Photon failed to decode/encode the image");
    assert.equal(resized.width, 1);
    assert.equal(resized.height, 1);
    assert.equal(resized.wasResized, true);
    assert.equal(resized.originalWidth, 4);
    assert.equal(resized.originalHeight, 2);
    assert(Buffer.from(resized.data, "base64").length > 0);
    report.checks.push(
      "Photon: actual PNG decode/encode (SDK may use its documented inline fallback)",
    );

    const mcpEntry = packageEntry("@earendil-works/pi-mcp", piEntry);
    const { McpClient, StdioTransport } = await import(pathToFileURL(mcpEntry).href);
    const fixture = path.join(temp, "mcp fixture with spaces.cjs");
    fs.writeFileSync(
      fixture,
      `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result;if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'offline-smoke',version:'1'}};else if(m.method==='tools/list')result={tools:[{name:'echo',inputSchema:{type:'object'}}]};else if(m.method==='tools/call')result={content:[{type:'text',text:m.params.arguments.value}]};else result={};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`,
    );
    const transport = new StdioTransport({
      command: process.execPath,
      args: [fixture],
      cwd: temp,
      env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
      inheritEnv: false,
      closeTimeoutMs: 2000,
    });
    client = new McpClient({ name: "packaged-smoke", version: "1", requestTimeoutMs: 5000 });
    await client.connect(transport);
    assert.equal((await client.listTools())[0].name, "echo");
    assert.equal(
      (await client.callTool("echo", { value: "offline-ok" })).content[0].text,
      "offline-ok",
    );
    const childPid = transport.pid;
    await client.close();
    client = undefined;
    assert(childPid);
    assert.throws(
      () => process.kill(childPid, 0),
      (error) => error.code === "ESRCH",
    );
    report.checks.push("Pi MCP: stdio initialization/list/call, spaced path, child exited");

    const { DatabaseSync } = require("node:sqlite");
    const databasePath = path.join(temp, "database with spaces.sqlite");
    let database = new DatabaseSync(databasePath);
    database.exec(
      "PRAGMA auto_vacuum=0; CREATE TABLE retained(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO retained VALUES(1,'keep'); CREATE TABLE churn(payload BLOB); INSERT INTO churn VALUES(zeroblob(16*1024*1024)); DELETE FROM churn;",
    );
    database.close();
    const before = fs.statSync(databasePath).size;
    const compactEntry =
      localControl && process.argv[3]
        ? path.resolve(process.argv[3])
        : path.join(appRoot, "apps/server/dist/compactDatabase.mjs");
    assert(fs.existsSync(compactEntry), "Missing compiled compactDatabase entry");
    const compact = spawnSync(process.execPath, [compactEntry, databasePath], {
      cwd: temp,
      env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
      encoding: "utf8",
      timeout: 20000,
      windowsHide: true,
      shell: false,
    });
    assert.ifError(compact.error);
    assert.equal(compact.status, 0, compact.stderr || compact.stdout);
    const after = fs.statSync(databasePath).size;
    assert(after < before, `${before} -> ${after}: compaction did not reclaim space`);
    database = new DatabaseSync(databasePath);
    try {
      assert.deepEqual(
        { ...database.prepare("SELECT * FROM retained").get() },
        { id: 1, value: "keep" },
      );
      assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.equal(database.prepare("PRAGMA auto_vacuum").get().auto_vacuum, 2);
    } finally {
      database.close();
    }
    for (const suffix of [".lifecycle-lock", "-wal", "-shm"])
      assert(!fs.existsSync(databasePath + suffix), `Residual ${suffix}`);
    report.checks.push(
      `Packaged compaction CLI: ${before} -> ${after} bytes; data/integrity/vacuum/cleanup verified`,
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (client) await client.close();
    if (sandbox) await sandbox.close();
    process.chdir(tmpdir());
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
const deadline = setTimeout(() => {
  console.error("Packaged probe timed out");
  process.exit(1);
}, 60000);
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => clearTimeout(deadline));
