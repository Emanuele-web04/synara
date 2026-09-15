import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, chmod, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { CuaDriverHost } from "./cuaDriverHost";
import {
  cuaRequest as rawCuaRequest,
  CUA_DRIVER_VERSION,
  CUA_NATIVE_REVISION,
  type CuaReply,
} from "@synara/shared/cuaDriverProtocol";
const capability = "isolated-fixture-authority-00000000000000";
const cuaRequest: typeof rawCuaRequest = (path, request, options) =>
  rawCuaRequest(path, { ...(request as object), capability }, options);
const cleanups: Array<() => Promise<unknown>> = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(
  authority = capability,
  options: {
    cleanup?: "incomplete" | "wrong-pid" | "missing-admission";
    unpatched?: boolean;
    failAction?: boolean;
    crash?: boolean;
    sessionDeathOnce?: boolean;
    sessionDeathTransport?: boolean;
    delayObservation?: boolean;
    hangSession?: boolean;
    dropCancel?: boolean;
    startupTimeoutMs?: number;
    deathFlag?: string;
    checkPermissions?: () => Promise<{ accessibility: boolean; screenRecording: boolean }>;
    releaseHeldInput?: () => Promise<void>;
    frameTap?: {
      update: (target: unknown) => void;
      endTask: (task: unknown) => Promise<void>;
      stop: () => Promise<void>;
      dispose: () => Promise<void>;
    };
    listWindows?: Array<Record<string, unknown>>;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "synara-cua-host-test-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const log = join(directory, "events.jsonl");
  const binary = join(directory, "driver");
  options = { ...options, deathFlag: join(directory, "session-died") };
  await writeFile(
    binary,
    `#!${process.execPath}
const net=require('node:net'),fs=require('node:fs');
const log=${JSON.stringify(log)}, options=${JSON.stringify(options)};
const write=event=>fs.appendFileSync(log,JSON.stringify({event,pid:process.pid,time:Date.now()})+'\\n');
write('start');
if(!process.argv.includes('--compact-cursor')) throw new Error('Missing compact cursor profile');
if(process.argv[process.argv.indexOf('--idle-hide-ms')+1]!=='900') throw new Error('Missing cursor idle deadline');
const socket=process.argv[process.argv.indexOf('--socket')+1];
let action, timer;
net.createServer(s=>{
  const reply=result=>s.end(JSON.stringify({ok:true,result})+'\\n');
  s.once('data',b=>{
    const r=JSON.parse(b.toString());
    if(r.method==='metadata') reply({driver_version:${JSON.stringify(CUA_DRIVER_VERSION)},synara_native_revision:options.unpatched?undefined:${CUA_NATIVE_REVISION},embedded:true,pid:process.pid});
    else if(r.method==='cancel_input') {
      write('cancel');
      if(options.dropCancel) { s.destroy(); return; }
      if(r.args.expected_pid!==process.pid) throw new Error('Wrong generation');
      clearTimeout(timer);
      if(action) { write('release'); action.end(JSON.stringify({ok:false,error:'cancelled'})+'\\n'); action=undefined; }
      setTimeout(()=>{
        write('cleanup-ack');
        reply({pid:process.pid+(options.cleanup==='wrong-pid'?1:0),input_admission_closed:options.cleanup==='missing-admission'?undefined:true,cleanup_complete:options.cleanup!=='incomplete',pending_input:options.cleanup==='incomplete'?1:0});
      },30);
    }
    else if(options.sessionDeathOnce && r.method==='call' && r.args && r.args.session && r.name!=='start_session' && r.name!=='set_agent_cursor_motion' && !fs.existsSync(options.deathFlag)) { fs.writeFileSync(options.deathFlag, '1'); reply({isError:true, content:[{type:'text', text:"session '"+r.args.session+"' has ended; tool call '"+r.name+"' was rejected. Call start_session with this id to revive it before issuing further actions, or use a new session id."}], structuredContent:{effect:'not-dispatched'}}); }
    else if(options.sessionDeathTransport && r.method==='call' && r.args && r.args.session && r.name!=='start_session' && r.name!=='set_agent_cursor_motion' && !fs.existsSync(options.deathFlag)) { fs.writeFileSync(options.deathFlag, '1'); s.end(JSON.stringify({ok:false,error:"session '"+r.args.session+"' has ended; tool call '"+r.name+"' was rejected. Call start_session with this id to revive it before issuing further actions, or use a new session id.",effect:'not-dispatched'})+'\\n'); }
    else if(r.name==='type_text') {
      write('dispatch'); action=s;
      if(options.crash) { write('crash'); process.exit(1); }
      else if(options.failAction) s.destroy();
      else timer=setTimeout(()=>{write('effect');reply({});action=undefined},10000);
    }
    else if(options.hangSession && r.name==='start_session' && !fs.existsSync(options.deathFlag)) { fs.writeFileSync(options.deathFlag,'1'); write('session-hang'); }
    else if(r.name==='set_agent_cursor_motion') { write('motion-'+r.args.glide_duration_ms+'-'+r.args.dwell_after_click_ms); reply({}); }
    else if(r.name==='press_key') { write('key'); write('observation-budget-'+process.env.SYNARA_CUA_FOREGROUND_OBSERVATION_MS); reply({}); }
    else if(r.name==='get_window_state' && !r.args?.empty) { write('observe'); setTimeout(()=>reply({structuredContent:{elements:[]}}),options.delayObservation?60:0); }
    else if(r.name==='get_desktop_state') reply({content:[{type:'image',data:'fixture-image'}]});
    else if(r.name==='list_windows') { write('list-windows'); reply({structuredContent:{windows:options.listWindows||[]}}); }
    else reply({});
  });
  s.on('error',()=>{});
}).listen(socket);
let retiring=false;
function retire(){if(retiring)return;retiring=true;write('retiring');setTimeout(()=>{write('exit');process.exit(0)},150)}
process.on('SIGTERM',retire);
process.stdin.resume(); process.stdin.on('end',retire);
`,
  );
  await chmod(binary, 0o755);
  const host = new CuaDriverHost({
    binaryPath: binary,
    bundleId: "fixture",
    capability: authority,
    setup: async () => {},
    ...(options.checkPermissions ? { checkPermissions: options.checkPermissions } : {}),
    ...(options.releaseHeldInput ? { releaseHeldInput: options.releaseHeldInput } : {}),
    ...(options.frameTap ? { frameTap: options.frameTap } : {}),
    ...(options.startupTimeoutMs ? { startupTimeoutMs: options.startupTimeoutMs } : {}),
  });
  const events = async () =>
    (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((row) => JSON.parse(row));
  cleanups.push(async () => {
    try {
      await host.dispose();
    } catch (error) {
      if (!options.cleanup && !options.crash) throw error;
    }
    // These are fake executables created by this test, with no OS input API.
    // A deliberately invalid cleanup acknowledgement must leave them alive.
    for (const event of await events().catch(() => [])) {
      if (event.event === "start") {
        try {
          process.kill(event.pid, "SIGKILL");
        } catch {
          /* Already exited. */
        }
      }
    }
  });
  const endpoint = await host.listen();
  return { host, endpoint, events };
}
describe("Cua GUI host retirement", () => {
  it("starts the compact cursor once per generation and owns the observation budget", async () => {
    const f = await fixture();
    for (let i = 0; i < 2; i++) {
      const reply = await cuaRequest<CuaReply>(f.endpoint, {
        method: "call",
        name: "press_key",
        args: { key: "enter", _synara_foreground_observation_ms: 0 },
      });
      expect(reply.ok).toBe(true);
    }
    const events = (await f.events()).map((row) => row.event);
    expect(events.filter((event) => event === "motion-100-0")).toHaveLength(1);
    expect(events.filter((event) => event === "observation-budget-100")).toHaveLength(2);
  });

  it.each(["stop", "suspend", "pauseDesktop"] as const)(
    "%s does not wait for another feature's permission dialog",
    async (method) => {
      const entered = deferred<void>();
      const pending = deferred<{ accessibility: boolean; screenRecording: boolean }>();
      const f = await fixture(capability, {
        checkPermissions: () => {
          entered.resolve();
          return pending.promise;
        },
      });
      const check = cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
      await entered.promise;
      await f.host[method]("screen-lock");
      await expect(check).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
      // Releasing this Computer wait does not cancel the shared request.
      pending.resolve({ accessibility: true, screenRecording: true });
      await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
    },
    2_000,
  );

  it("releases a disconnected permission check without retiring a later native session", async () => {
    const entered = deferred<void>();
    const pending = deferred<{ accessibility: boolean; screenRecording: boolean }>();
    const f = await fixture(capability, {
      checkPermissions: () => {
        entered.resolve();
        return pending.promise;
      },
    });
    const controller = new AbortController();
    const check = cuaRequest(
      f.endpoint,
      { method: "call", name: "check_permissions" },
      { signal: controller.signal },
    ).catch((error: unknown) => error);
    await entered.promise;
    controller.abort();
    await check;
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "get_screen_size" }, { timeoutMs: 2_000 }),
    ).resolves.toMatchObject({ ok: true });
    pending.resolve({ accessibility: true, screenRecording: true });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "press_key" }),
    ).resolves.toMatchObject({ ok: true });
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(1);
  });

  it("checks permissions through the fresh shared helper without starting Cua or requesting grants", async () => {
    let permissions = { accessibility: false, screenRecording: false };
    const f = await fixture(capability, { checkPermissions: async () => permissions });
    const check = () =>
      cuaRequest(f.endpoint, { method: "call", name: "check_permissions", args: { prompt: true } });
    await expect(check()).resolves.toMatchObject({
      result: {
        structuredContent: {
          accessibility: false,
          screen_recording: false,
          source: {
            attribution: "host",
            host_bundle_id: "fixture",
            probe: "appsnap-permission-helper",
          },
        },
      },
    });
    permissions = { accessibility: true, screenRecording: true };
    await expect(check()).resolves.toMatchObject({
      result: { structuredContent: { accessibility: true, screen_recording: true } },
    });
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retires a cached native process once when grants change, then requires fresh observation", async () => {
    let granted = true;
    const f = await fixture(capability, {
      checkPermissions: async () => ({ accessibility: granted, screenRecording: granted }),
    });
    const check = () => cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    await check();
    await cuaRequest(f.endpoint, { method: "call", name: "get_screen_size" });
    granted = false;
    await expect(check()).resolves.toMatchObject({
      desktopEpoch: 1,
      result: { structuredContent: { accessibility: false } },
    });
    expect((await f.events()).filter((event) => event.event === "cleanup-ack")).toHaveLength(1);
    await check();
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(1);
    granted = true;
    await check();
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "press_key" }),
    ).resolves.toMatchObject({ result: { isError: true } });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "get_window_state",
      modelObservation: true,
    });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "press_key" }),
    ).resolves.toMatchObject({ ok: true });
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(2);
  });

  it("does not bypass failed cleanup when refreshed permissions change", async () => {
    let granted = true;
    const f = await fixture(capability, {
      cleanup: "incomplete",
      checkPermissions: async () => ({ accessibility: granted, screenRecording: granted }),
    });
    await cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    await cuaRequest(f.endpoint, { method: "call", name: "get_screen_size" });
    // A dispatched action makes this generation's input state unprovable, so
    // the failed cleanup must keep the driver alive and admission closed.
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "press_key",
      args: { key: "enter" },
    });
    granted = false;
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "get_window_state", modelObservation: true }),
    ).resolves.toMatchObject({ ok: false });
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(1);
  });
  it("does not start while locked and requires fresh state after all desktop pauses end", async () => {
    const f = await fixture();
    await f.host.pauseDesktop("screen-lock");
    await f.host.pauseDesktop("system-sleep");
    f.host.resume(); // A backend restart cannot unlock the desktop.
    const press = () => cuaRequest(f.endpoint, { method: "call", name: "press_key" });
    await expect(press()).resolves.toMatchObject({
      result: {
        isError: true,
        structuredContent: { code: "desktop_input_paused", effect: "refused" },
      },
    });
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
    f.host.resumeDesktop("screen-lock");
    await expect(press()).resolves.toMatchObject({ result: { isError: true } });
    f.host.resumeDesktop("system-sleep");
    await cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    await expect(press()).resolves.toMatchObject({ result: { isError: true } });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "get_window_state",
      modelObservation: true,
      args: { pid: 1, window_id: 2 },
    });
    await expect(press()).resolves.toMatchObject({ ok: true });
    expect((await f.events()).filter((event) => event.event === "key")).toHaveLength(1);
  });

  it("retires a driver-ended session and retries once with a fresh one", async () => {
    // The driver can end a session the host still holds (restart, timeout).
    // Without a heal, every later call fails the same way and no model-side
    // retry can recover. The driver confirms nothing dispatched, so one
    // retire-plus-retry is replay-safe.
    const f = await fixture(capability, { sessionDeathOnce: true });
    const reply = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "press_key",
      args: { key: "enter" },
    });
    expect(reply.ok).toBe(true);
    expect(reply.result?.isError).not.toBe(true);
    const events = await f.events();
    // The dead generation retired (new driver process) and the key reached
    // the fresh session exactly once.
    expect(events.filter((event) => event.event === "start")).toHaveLength(2);
    expect(events.filter((event) => event.event === "key")).toHaveLength(1);
  });

  it("retires a transport-reported session death and retries once fresh", async () => {
    // The live driver surfaced session death as an ok:false reply rather than
    // an isError result: undetected, every later call died on the same id.
    const f = await fixture(capability, { sessionDeathTransport: true });
    const reply = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "press_key",
      args: { key: "enter" },
    });
    expect(reply.ok).toBe(true);
    expect(reply.result?.isError).not.toBe(true);
    const events = await f.events();
    expect(events.filter((event) => event.event === "start")).toHaveLength(2);
    expect(events.filter((event) => event.event === "key")).toHaveLength(1);
  });

  it("locking cancels active native input and rejects waiting input before dispatch", async () => {
    const f = await fixture();
    const active = cuaRequest(f.endpoint, {
      method: "call",
      name: "type_text",
      args: { text: "fixture" },
    });
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await f.events().catch(() => [])).some((event) => event.event === "dispatch")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await f.events()).some((event) => event.event === "dispatch")).toBe(true);
    const queued = cuaRequest<CuaReply>(f.endpoint, { method: "call", name: "press_key" });
    await f.host.pauseDesktop("screen-lock");
    expect(await active).toMatchObject({ ok: false });
    const queuedReply = await queued;
    expect(queuedReply.ok === false || queuedReply.result?.isError === true).toBe(true);
    const events = await f.events();
    expect(events.some((event) => event.event === "cleanup-ack")).toBe(true);
    expect(events.some((event) => event.event === "effect" || event.event === "key")).toBe(false);
  });

  it("unlock does not bypass an unacknowledged cleanup barrier", async () => {
    const f = await fixture(capability, { cleanup: "incomplete" });
    await cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "press_key",
      args: { key: "enter" },
    });
    await expect(f.host.pauseDesktop("screen-lock")).rejects.toThrow(
      "did not confirm native input cleanup",
    );
    f.host.resumeDesktop("screen-lock");
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "get_window_state" }),
    ).resolves.toMatchObject({ ok: false });
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(1);
  });

  it("preview and readiness reads cannot release the post-unlock model observation gate", async () => {
    const f = await fixture();
    await f.host.pauseDesktop("screen-lock");
    f.host.resumeDesktop("screen-lock");
    const press = () => cuaRequest(f.endpoint, { method: "call", name: "press_key" });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "get_desktop_state" }),
    ).resolves.toMatchObject({ ok: true, desktopEpoch: 1 });
    await cuaRequest(f.endpoint, { method: "call", name: "get_window_state" });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "get_window_state",
      modelObservation: true,
      args: { empty: true },
    });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "check_input_ready" }),
    ).resolves.toMatchObject({ result: { isError: true } });
    await expect(press()).resolves.toMatchObject({ result: { isError: true } });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "get_window_state",
      modelObservation: true,
    });
    await expect(press()).resolves.toMatchObject({ ok: true });
    expect((await f.events()).filter((event) => event.event === "key")).toHaveLength(1);
  });

  it("a disconnected observation cannot release the post-unlock gate", async () => {
    const f = await fixture(capability, { delayObservation: true });
    await f.host.pauseDesktop("screen-lock");
    f.host.resumeDesktop("screen-lock");
    const controller = new AbortController();
    const observation = cuaRequest(
      f.endpoint,
      {
        method: "call",
        name: "get_window_state",
        modelObservation: true,
      },
      { signal: controller.signal },
    ).catch((error: unknown) => error);
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await f.events().catch(() => [])).some((event) => event.event === "observe")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect((await f.events()).some((event) => event.event === "observe")).toBe(true);
    controller.abort();
    expect(await observation).toBeInstanceOf(Error);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "press_key" }),
    ).resolves.toMatchObject({ result: { isError: true } });
    expect((await f.events()).some((event) => event.event === "key")).toBe(false);
  });

  it("ignores a permission probe that reverts on the confirming re-read", async () => {
    // The AppSnap helper can read TCC mid-transition and report a grant that
    // the next probe reverts. Arming the gate on that phantom read deadlocked
    // production: every action runs check_permissions first via refresh(), so
    // the helper re-armed the gate after each observation cleared it.
    let probes = 0;
    const f = await fixture(capability, {
      checkPermissions: async () => {
        probes += 1;
        return { accessibility: true, screenRecording: probes !== 2 };
      },
    });
    const check = () => cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    await expect(check()).resolves.toMatchObject({ desktopEpoch: 0 });
    await expect(check()).resolves.toMatchObject({
      desktopEpoch: 0,
      result: { structuredContent: { screen_recording: true } },
    });
    expect(probes).toBe(3);
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "press_key" }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("a flapping permission helper cannot deadlock input behind the observation gate", async () => {
    let probes = 0;
    const f = await fixture(capability, {
      checkPermissions: async () => {
        probes += 1;
        return { accessibility: true, screenRecording: probes % 2 === 1 };
      },
    });
    const check = () => cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    const observe = () =>
      cuaRequest(f.endpoint, {
        method: "call",
        name: "get_window_state",
        modelObservation: true,
        args: { pid: 1, window_id: 2 },
      });
    await check();
    await f.host.pauseDesktop("screen-lock");
    f.host.resumeDesktop("screen-lock");
    for (let i = 0; i < 3; i += 1) {
      await observe();
      await check();
      await expect(
        cuaRequest(f.endpoint, { method: "call", name: "press_key" }),
      ).resolves.toMatchObject({ ok: true });
    }
  });

  it("refuses an observation a stop interrupted instead of silently voiding the clear", async () => {
    const f = await fixture(capability, { delayObservation: true });
    await f.host.pauseDesktop("screen-lock");
    f.host.resumeDesktop("screen-lock");
    const observe = () =>
      cuaRequest(f.endpoint, {
        method: "call",
        name: "get_window_state",
        modelObservation: true,
        args: { pid: 1, window_id: 2 },
      });
    const interrupted = observe();
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await f.events().catch(() => [])).some((event) => event.event === "observe")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // stopInput (turn Stop/revokeControl) used to bump only the input epoch:
    // the in-flight image still returned while its gate clear was skipped.
    await cuaRequest(f.endpoint, { method: "stop" });
    await expect(interrupted).resolves.toMatchObject({
      result: { isError: true, structuredContent: { code: "desktop_input_paused" } },
    });
    await observe();
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "press_key" }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("preserves multibyte UTF-8 across incoming socket chunks", async () => {
    const authority = capability + "-è🧪";
    const f = await fixture(authority);
    const request = Buffer.from(JSON.stringify({ method: "probe", capability: authority }) + "\n");
    const split = request.indexOf(Buffer.from("🧪")) + 1;
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(f.endpoint);
      let result = "";
      socket.setTimeout(2_000, () => socket.destroy(new Error("Fixture socket timed out.")));
      socket.once("error", reject);
      socket.on("data", (chunk) => {
        result += chunk.toString("utf8");
      });
      socket.once("end", () => resolve(result));
      socket.once("connect", () => {
        socket.write(request.subarray(0, split));
        setTimeout(() => socket.write(request.subarray(split)), 30);
      });
    });
    expect(JSON.parse(reply)).toMatchObject({ ok: true });
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("requires GUI authority even when a provider discovers the socket", async () => {
    const f = await fixture();
    await expect(
      rawCuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
    ).resolves.toMatchObject({ ok: false });
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("releases uncertain input before termination and waits for exit before replacement", async () => {
    const f = await fixture();
    await cuaRequest(f.endpoint, { method: "call", name: "check_permissions", args: {} });
    await expect(
      cuaRequest(
        f.endpoint,
        { method: "call", name: "type_text", args: { text: "fixture" } },
        { timeoutMs: 120, mutation: true },
      ),
    ).rejects.toMatchObject({ effect: "dispatched-unknown" });
    await f.host.stop();
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "check_permissions", args: {} }),
    ).resolves.toMatchObject({ ok: true });
    const events = await f.events();
    const starts = events.filter((e) => e.event === "start");
    expect(starts).toHaveLength(2);
    const exit = events.find((e) => e.event === "exit" && e.pid === starts[0].pid);
    expect(exit).toBeDefined();
    expect(starts[1].time).toBeGreaterThanOrEqual(exit.time);
    expect(events.some((e) => e.event === "effect")).toBe(false);
    expect(events.filter((e) => e.event === "dispatch")).toHaveLength(1);
    const first = events.filter((e) => e.pid === starts[0].pid).map((e) => e.event);
    expect(first).toEqual([
      "start",
      "motion-100-0",
      "dispatch",
      "cancel",
      "release",
      "cleanup-ack",
      "retiring",
      "exit",
    ]);
  });
  it("releases held input through the helper when the driver dies mid-action", async () => {
    let releaseCalls = 0;
    const released = async () => {
      releaseCalls += 1;
    };
    const f = await fixture(capability, { crash: true, releaseHeldInput: released });
    await cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    // The fake driver exits on dispatch, so the call's retire runs the
    // OS-level release before the request reports its failure.
    await expect(
      cuaRequest(
        f.endpoint,
        { method: "call", name: "type_text", args: { text: "fixture" } },
        { timeoutMs: 300, mutation: true },
      ),
    ).resolves.toMatchObject({ ok: false });
    expect(releaseCalls).toBe(1);
    // A confirmed release makes the desktop provably clean: the dead
    // generation clears, so the next request spawns a replacement instead of
    // poisoning admission for the host's lifetime.
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
    ).resolves.toMatchObject({ ok: true });
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(2);
  });
  it("keeps admission closed for the host's lifetime when held-input release fails", async () => {
    const f = await fixture(capability, {
      crash: true,
      releaseHeldInput: () => Promise.reject(new Error("helper gone")),
    });
    await expect(
      cuaRequest(
        f.endpoint,
        { method: "call", name: "type_text", args: { text: "fixture" } },
        { timeoutMs: 1_000, mutation: true },
      ),
    ).resolves.toMatchObject({ ok: false });
    // Without a confirmed release the held state is unprovable — no
    // replacement generation may spawn over it, now or later.
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
    ).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(1);
    await expect(f.host.stop()).rejects.toThrow("admission is closed");
  });
  it("replaces a driver that wedges during startup instead of closing admission", async () => {
    const f = await fixture(capability, {
      hangSession: true,
      dropCancel: true,
      startupTimeoutMs: 150,
    });
    // The wedged startup call is bounded by the startup timeout; its
    // retirement cannot confirm cleanup (the socket drops mid-request), but
    // no action ever reached this generation so nothing can be held.
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "press_key", args: { key: "enter" } }),
    ).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
    // Terminating the provably input-free generation clears it, so the next
    // request spawns a fresh driver instead of failing closed forever.
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
    ).resolves.toMatchObject({ ok: true });
    const events = await f.events();
    const starts = events.filter((event) => event.event === "start");
    expect(starts).toHaveLength(2);
    expect(events.filter((e) => e.pid === starts[0].pid).map((e) => e.event)).toEqual([
      "start",
      "session-hang",
      "cancel",
      "retiring",
      "exit",
    ]);
  });
  it("rejects later backend requests throughout suspension and resumes only on explicit restart", async () => {
    const f = await fixture();
    await cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    const stopping = f.host.suspend();
    await expect(
      cuaRequest(f.endpoint, {
        method: "call",
        name: "type_text",
        args: { text: "must not arrive" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      effect: "not-dispatched",
      error: expect.stringContaining("suspended"),
    });
    await stopping;
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
    ).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(1);
    expect((await f.events()).some((event) => event.event === "dispatch")).toBe(false);
    f.host.resume();
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
    ).resolves.toMatchObject({ ok: true });
    const events = await f.events();
    const starts = events.filter((event) => event.event === "start");
    expect(starts).toHaveLength(2);
    expect(starts[1].time).toBeGreaterThanOrEqual(
      events.find((event) => event.event === "exit" && event.pid === starts[0].pid).time,
    );
  });
  it("does not let resume bypass failed cleanup during backend suspension", async () => {
    const f = await fixture(capability, { cleanup: "incomplete" });
    await cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "press_key",
      args: { key: "enter" },
    });
    await expect(f.host.suspend()).rejects.toThrow("did not confirm native input cleanup");
    f.host.resume();
    await expect(
      cuaRequest(f.endpoint, {
        method: "call",
        name: "type_text",
        args: { text: "must not arrive" },
      }),
    ).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(1);
    expect((await f.events()).some((event) => event.event === "dispatch")).toBe(false);
  });
  it.each(["incomplete", "wrong-pid", "missing-admission"] as const)(
    "keeps the process alive and blocks replacement after %s cleanup",
    async (cleanup) => {
      const f = await fixture(capability, { cleanup });
      await cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
      // An input-dispatched generation can hold OS state the acknowledgement
      // cannot account for, so the driver stays alive and unreplaced.
      await cuaRequest(f.endpoint, {
        method: "call",
        name: "press_key",
        args: { key: "enter" },
      });
      await expect(f.host.stop()).rejects.toThrow("did not confirm native input cleanup");
      await expect(
        cuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
      ).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
      const events = await f.events();
      expect(events.map((e) => e.event)).toEqual([
        "start",
        "motion-100-0",
        "key",
        "observation-budget-100",
        "cancel",
        "cleanup-ack",
      ]);
      expect(() => process.kill(events[0].pid, 0)).not.toThrow();
    },
  );
  it("preserves an uncertain action effect when cleanup also fails", async () => {
    const f = await fixture(capability, { cleanup: "incomplete", failAction: true });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "type_text", args: { text: "fixture" } }),
    ).resolves.toMatchObject({
      ok: false,
      effect: "dispatched-unknown",
      error: expect.stringContaining("did not confirm native input cleanup"),
    });
    expect((await f.events()).some((e) => e.event === "retiring")).toBe(false);
  });
  it("blocks replacement when a driver crashes during input", async () => {
    const f = await fixture(capability, { crash: true });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "type_text", args: { text: "fixture" } }),
    ).resolves.toMatchObject({ ok: false, effect: "dispatched-unknown" });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
    ).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
    expect((await f.events()).filter((e) => e.event === "start")).toHaveLength(1);
  });
  it("rejects an upstream binary before native input is admitted", async () => {
    const f = await fixture(capability, { unpatched: true });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "type_text", args: { text: "fixture" } }),
    ).resolves.toMatchObject({
      ok: false,
      effect: "not-dispatched",
      error: expect.stringContaining("native revision handshake failed"),
    });
    expect((await f.events()).map((e) => e.event)).toEqual(["start", "retiring", "exit"]);
  });
  it("refuses unlisted driver operations before starting a daemon", async () => {
    const f = await fixture();
    const response = await cuaRequest<{ ok: boolean }>(f.endpoint, {
      method: "call",
      name: "browser_navigate",
      args: { url: "https://example.com" },
    });
    expect(response.ok).toBe(false);
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("task-owned user stop", () => {
  const task = { threadId: "thread", turnId: "turn" };
  it("end_task succeeds without a native preview", async () => {
    const f = await fixture();
    await expect(cuaRequest(f.endpoint, { method: "end_task", task })).resolves.toMatchObject({
      ok: true,
    });
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("user Stop refuses subsequent calls from the same turn", async () => {
    const f = await fixture();
    await f.host.stopTaskByUser(task);
    const blocked = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "press_key",
      task,
      args: { key: "enter", pid: 42, window_id: 10 },
    });
    expect(blocked).toMatchObject({ ok: false, effect: "not-dispatched" });
    expect(blocked.error).toContain("user stopped");
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
    const next = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "get_window_state",
      task: { ...task, turnId: "next" },
      modelObservation: true,
      args: { pid: 42, window_id: 10 },
    });
    expect(next.ok).toBe(true);
  });
});

describe("frame tap launch prime", () => {
  const task = { threadId: "thread", turnId: "turn" };
  const calculator = {
    pid: 101,
    window_id: 202,
    app_name: "Calculator",
    title: "Calculator",
    bounds: { x: 0, y: 0, width: 400, height: 600 },
    is_on_screen: true,
  };
  function tapDouble() {
    const updates: Array<unknown> = [];
    return {
      updates,
      host: {
        update: (target: unknown) => {
          updates.push(target);
        },
        endTask: async () => {},
        stop: async () => {},
        dispose: async () => {},
      },
    };
  }
  it("points the tap at the launched app's main window", async () => {
    const tap = tapDouble();
    const f = await fixture(capability, { frameTap: tap.host, listWindows: [calculator] });
    const launched = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "launch_app",
      task,
      args: { name: "Calculator" },
    });
    expect(launched.ok).toBe(true);
    await vi.waitFor(() => expect(tap.updates).toHaveLength(1));
    expect(tap.updates[0]).toMatchObject({ pid: 101, windowId: 202 });
  });
  it("matches bundle ids by their tail component", async () => {
    const tap = tapDouble();
    const f = await fixture(capability, { frameTap: tap.host, listWindows: [calculator] });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "launch_app",
      task,
      args: { bundle_id: "com.apple.Calculator" },
    });
    await vi.waitFor(() => expect(tap.updates).toHaveLength(1));
    expect(tap.updates[0]).toMatchObject({ pid: 101, windowId: 202 });
  });
  it("stays quiet when no on-screen window matches", async () => {
    const tap = tapDouble();
    const f = await fixture(capability, { frameTap: tap.host, listWindows: [calculator] });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "launch_app",
      task,
      args: { name: "TextEdit" },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(tap.updates).toEqual([]);
  });
  it("skips the prime for ended tasks", async () => {
    const tap = tapDouble();
    const f = await fixture(capability, { frameTap: tap.host, listWindows: [calculator] });
    await cuaRequest(f.endpoint, { method: "end_task", task });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "launch_app",
      task,
      args: { name: "Calculator" },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(tap.updates).toEqual([]);
  });
});
